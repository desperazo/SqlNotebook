use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use keyring::Entry;
use mysql::{prelude::*, Conn, OptsBuilder, Value};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tiberius::{time as tds_time, AuthMethod, Client, ColumnData, Config, EncryptionLevel};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

/// Rows kept in the results grid; the rest are drained but not stored.
pub const MAX_ROWS: usize = 500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_secs(30);
/// Matches `Connect Timeout=30` from SQL Server connection strings.
const MSSQL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const MSSQL_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// SQL Server `datetime`/`smalldatetime` count days from 1900-01-01, which is
/// this many days before the Unix epoch.
const DAYS_1900_TO_1970: i64 = 25567;
/// Keychain service name; each password is stored under its connection id.
const KEYRING_SERVICE: &str = "SqlNotebook";

pub type DbResult<T> = Result<T, String>;

type MsSqlClient = Client<Compat<TcpStream>>;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    #[default]
    MySql,
    MsSql,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MssqlEncryption {
    #[default]
    Required,
    /// Skips TLS entirely. Legacy SQL Servers whose TLS stacks abort modern
    /// handshakes accept this when Force Encryption is off; credentials then
    /// travel unencrypted.
    Off,
}

/// Persisted to disk. Carries no secret: passwords live in the session or,
/// with `save_password`, in the OS keychain keyed by connection id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionSpec {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: String,
    /// Missing in configs saved before SQL Server support, hence the default.
    #[serde(default)]
    pub kind: Engine,
    /// SQL Server only; left out of the JSON for MySQL connections.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<MssqlEncryption>,
    /// Sidebar folder name; `None` keeps the connection at the top level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Opt-in; the password itself is stored in the OS keychain, never on disk.
    #[serde(
        rename = "savePassword",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub save_password: bool,
}

#[derive(Serialize)]
pub struct ConnectionView {
    #[serde(flatten)]
    pub spec: ConnectionSpec,
    pub connected: bool,
}

#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub name: String,
    pub kind: String,
    /// Database name for MySQL, schema name (`dbo`) for SQL Server.
    pub schema: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    /// `PRI` / `UNI` / `MUL` / `FK`, or empty for a plain column.
    pub key: String,
    pub default: Option<String>,
    pub extra: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDetails {
    pub columns: Vec<ColumnMeta>,
    /// Secondary (non-unique) indexes; unique keys are listed separately.
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    /// Unique constraints and the primary key.
    pub unique_keys: Vec<IndexMeta>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutcome {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub affected_rows: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
}

pub enum ConnHandle {
    MySql(Arc<Mutex<Conn>>),
    MsSql(Arc<tokio::sync::Mutex<MsSqlClient>>),
}

pub struct AppState {
    specs: Mutex<Vec<ConnectionSpec>>,
    /// Folders created explicitly via New Group; kept so empty folders exist
    /// before any connection is dragged in.
    groups: Mutex<Vec<String>>,
    conns: Mutex<HashMap<String, ConnHandle>>,
    config_path: PathBuf,
}

impl AppState {
    pub fn load(config_path: PathBuf) -> Self {
        let specs = fs::read_to_string(&config_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(Vec::new);
        let groups_path = groups_path(&config_path);
        let groups = fs::read_to_string(&groups_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(Vec::new);
        Self {
            specs: Mutex::new(specs),
            groups: Mutex::new(groups),
            conns: Mutex::new(HashMap::new()),
            config_path,
        }
    }

    fn persist(&self) -> DbResult<()> {
        let specs = self.specs.lock().map_err(|_| "State poisoned")?;
        let json = serde_json::to_string_pretty(&*specs).map_err(|e| e.to_string())?;
        fs::write(&self.config_path, json).map_err(|e| format!("{e}: {}", self.config_path.display()))
    }

    fn persist_groups(&self) -> DbResult<()> {
        let groups = self.groups.lock().map_err(|_| "State poisoned")?;
        let json = serde_json::to_string_pretty(&*groups).map_err(|e| e.to_string())?;
        let path = groups_path(&self.config_path);
        fs::write(&path, json).map_err(|e| format!("{e}: {}", path.display()))
    }

    fn conn_handle(&self, id: &str) -> DbResult<ConnHandle> {
        self.conns
            .lock()
            .map_err(|_| "State poisoned")?
            .get(id)
            .map(clone_handle)
            .ok_or_else(|| "Not connected. Connect to this database first.".to_string())
    }

    fn spec(&self, id: &str) -> DbResult<ConnectionSpec> {
        self.specs
            .lock()
            .map_err(|_| "State poisoned")?
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "Unknown connection".to_string())
    }
}

fn clone_handle(handle: &ConnHandle) -> ConnHandle {
    match handle {
        ConnHandle::MySql(conn) => ConnHandle::MySql(Arc::clone(conn)),
        ConnHandle::MsSql(client) => ConnHandle::MsSql(Arc::clone(client)),
    }
}

// ---------- OS keychain ----------

fn keychain_entry(id: &str) -> Result<Entry, keyring::Error> {
    Entry::new(KEYRING_SERVICE, id)
}

fn keychain_store(id: &str, password: &str) -> DbResult<()> {
    let entry = keychain_entry(id).map_err(|e| e.to_string())?;
    entry.set_password(password).map_err(|e| e.to_string())
}

fn keychain_load(id: &str) -> Option<String> {
    keychain_entry(id).ok()?.get_password().ok()
}

fn keychain_wipe(id: &str) {
    if let Ok(entry) = keychain_entry(id) {
        let _ = entry.delete_credential();
    }
}

// ---------- MySQL ----------

pub fn connect_with(spec: &ConnectionSpec, password: &str) -> DbResult<Conn> {
    let opts = OptsBuilder::new()
        .ip_or_hostname(Some(spec.host.clone()))
        .tcp_port(spec.port)
        .user(Some(spec.user.clone()))
        .pass(Some(password.to_string()))
        .db_name(if spec.database.is_empty() {
            None
        } else {
            Some(spec.database.clone())
        })
        .tcp_connect_timeout(Some(CONNECT_TIMEOUT))
        .read_timeout(Some(IO_TIMEOUT))
        .write_timeout(Some(IO_TIMEOUT));
    Conn::new(opts).map_err(|e| format!("Connection to {} failed: {e}", spec.host))
}

pub fn list_schemas_with(conn: &mut Conn) -> DbResult<Vec<String>> {
    let rows = conn
        .query_iter("SHOW DATABASES")
        .map_err(|e| format!("List schemas failed: {e}"))?;
    let mut out = Vec::new();
    for item in rows {
        let value: String = mysql::from_row(item.map_err(|e| e.to_string())?);
        out.push(value);
    }
    Ok(out)
}

pub fn list_tables_with(conn: &mut Conn, schema: &str) -> DbResult<Vec<TableInfo>> {
    let rows = conn
        .exec_iter(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
            (schema,),
        )
        .map_err(|e| format!("List tables failed: {e}"))?;
    let mut out = Vec::new();
    for item in rows {
        let (name, kind) = mysql::from_row(item.map_err(|e| e.to_string())?);
        out.push(TableInfo {
            name,
            kind,
            schema: schema.to_string(),
        });
    }
    Ok(out)
}

pub fn run_query_with(conn: &mut Conn, sql: &str) -> DbResult<QueryOutcome> {
    let started = Instant::now();
    let result = conn
        .query_iter(sql)
        .map_err(|e| format!("Query failed: {e}"))?;

    let columns = result
        .columns()
        .as_ref()
        .iter()
        .map(|c| c.name_str().into_owned())
        .collect::<Vec<_>>();

    let mut rows = Vec::new();
    let mut row_count = 0usize;
    let mut truncated = false;
    for item in result {
        let row = item.map_err(|e| format!("Query failed: {e}"))?;
        row_count += 1;
        if rows.len() < MAX_ROWS {
            rows.push((0..columns.len()).map(|i| row.as_ref(i).and_then(display)).collect());
        } else {
            truncated = true;
        }
    }
    let affected_rows = conn.affected_rows();

    Ok(QueryOutcome {
        columns,
        rows,
        row_count,
        affected_rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

fn display(value: &Value) -> Option<String> {
    match value {
        Value::NULL => None,
        Value::Bytes(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        Value::Int(v) => Some(v.to_string()),
        Value::UInt(v) => Some(v.to_string()),
        Value::Float(v) => Some(v.to_string()),
        Value::Double(v) => Some(v.to_string()),
        Value::Date(year, month, day, hour, minute, second, micros) => {
            let base = format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}");
            Some(if *micros == 0 { base } else { format!("{base}.{micros:06}") })
        }
        Value::Time(neg, days, hours, minutes, seconds, micros) => Some(format!(
            "{}{}:{minutes:02}:{seconds:02}.{micros:06}",
            if *neg { "-" } else { "" },
            days * 24 + u32::from(*hours)
        )),
    }
}

/// Splits `information_schema.statistics` rows (already ordered by index name,
/// then seq) into plain indexes and unique keys. The primary key counts as a
/// unique key.
fn group_index_rows(rows: Vec<(String, u64, String, u64)>) -> (Vec<IndexMeta>, Vec<IndexMeta>) {
    let mut all: Vec<IndexMeta> = Vec::new();
    for (name, _seq, column, non_unique) in rows {
        match all.last_mut() {
            Some(index) if index.name == name => index.columns.push(column),
            _ => all.push(IndexMeta {
                primary: name == "PRIMARY",
                unique: non_unique == 0,
                name,
                columns: vec![column],
            }),
        }
    }
    let (unique_keys, indexes): (Vec<_>, Vec<_>) =
        all.into_iter().partition(|index| index.unique || index.primary);
    (indexes, unique_keys)
}

/// Groups `referential_constraints`/`key_column_usage` rows (ordered by
/// constraint name, then ordinal position) into foreign keys.
fn group_fk_rows(
    rows: Vec<(String, String, u64, String, String, String, String)>,
) -> Vec<ForeignKeyMeta> {
    let mut out: Vec<ForeignKeyMeta> = Vec::new();
    for (name, column, _pos, ref_table, ref_column, on_update, on_delete) in rows {
        match out.last_mut() {
            Some(fk) if fk.name == name => {
                fk.columns.push(column);
                fk.ref_columns.push(ref_column);
            }
            _ => out.push(ForeignKeyMeta {
                ref_table,
                name,
                columns: vec![column],
                ref_columns: vec![ref_column],
                on_update,
                on_delete,
            }),
        }
    }
    out
}

pub fn mysql_describe_table(conn: &mut Conn, schema: &str, table: &str) -> DbResult<TableDetails> {
    let failed = |e| format!("Describe table failed: {e}");

    let column_rows: Vec<(String, String, String, String, Option<String>, String)> = conn
        .exec(
            "SELECT column_name, column_type, is_nullable, column_key, column_default, extra \
             FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? \
             ORDER BY ordinal_position",
            (schema, table),
        )
        .map_err(failed)?;
    let columns = column_rows
        .into_iter()
        .map(|(name, data_type, nullable, key, default, extra)| ColumnMeta {
            key,
            extra,
            default,
            nullable: nullable == "YES",
            name,
            data_type,
        })
        .collect();

    let index_rows: Vec<(String, u64, String, u64)> = conn
        .exec(
            "SELECT index_name, seq_in_index, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = ? AND table_name = ? \
             ORDER BY index_name, seq_in_index",
            (schema, table),
        )
        .map_err(failed)?;
    let (indexes, unique_keys) = group_index_rows(index_rows);

    let fk_rows: Vec<(String, String, u64, String, String, String, String)> = conn
        .exec(
            "SELECT rc.constraint_name, kcu.column_name, kcu.ordinal_position, \
                    kcu.referenced_table_name, kcu.referenced_column_name, \
                    rc.update_rule, rc.delete_rule \
             FROM information_schema.referential_constraints rc \
             JOIN information_schema.key_column_usage kcu \
               ON kcu.constraint_schema = rc.constraint_schema \
              AND kcu.constraint_name = rc.constraint_name \
             WHERE rc.constraint_schema = ? AND rc.table_name = ? \
             ORDER BY rc.constraint_name, kcu.ordinal_position",
            (schema, table),
        )
        .map_err(failed)?;

    Ok(TableDetails {
        columns,
        indexes,
        unique_keys,
        foreign_keys: group_fk_rows(fk_rows),
    })
}

// ---------- SQL Server ----------

/// `None` (old configs) behaves like the default `Required`.
fn mssql_encryption_level(spec: &ConnectionSpec) -> EncryptionLevel {
    match spec.encryption {
        Some(MssqlEncryption::Off) => EncryptionLevel::NotSupported,
        Some(MssqlEncryption::Required) | None => EncryptionLevel::Required,
    }
}

pub async fn connect_mssql_with(spec: &ConnectionSpec, password: &str) -> DbResult<MsSqlClient> {
    let mut config = Config::new();
    config.host(&spec.host);
    config.port(spec.port);
    if !spec.database.is_empty() {
        config.database(&spec.database);
    }
    config.authentication(AuthMethod::sql_server(&spec.user, password));
    config.encryption(mssql_encryption_level(spec));
    // `TrustServerCertificate=True`: SQL Server commonly presents a self-signed
    // certificate, which the system trust store rejects.
    config.trust_cert();
    config.handshake_timeout(Some(MSSQL_HANDSHAKE_TIMEOUT));
    config.command_timeout(Some(MSSQL_COMMAND_TIMEOUT));

    let addr = config.get_addr();
    let tcp = TcpStream::connect(&addr)
        .await
        .map_err(|e| connect_error(&spec.host, e))?;
    tcp.set_nodelay(true).map_err(|e| connect_error(&spec.host, e))?;
    Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| connect_error(&spec.host, e))
}

fn connect_error<E: std::fmt::Display>(host: &str, error: E) -> String {
    format!("Connection to {host} failed: {error}")
}

/// Brackets a SQL Server identifier. `]` is escaped by doubling, so no name can
/// break out of the brackets.
fn mssql_ident(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// Quotes a value as an NVARCHAR literal; `'` is escaped by doubling.
fn mssql_lit(value: &str) -> String {
    format!("N'{}'", value.replace('\'', "''"))
}

pub async fn mssql_list_schemas(client: &mut MsSqlClient) -> DbResult<Vec<String>> {
    let mut stream = client
        .query("SELECT name FROM sys.databases ORDER BY name", &[])
        .await
        .map_err(|e| mssql_err("List schemas", e))?;

    let mut out = Vec::new();
    while let Some(item) = stream.try_next().await.map_err(|e| mssql_err("List schemas", e))? {
        let Some(row) = item.into_row() else { continue };
        out.push(cell_str(&row, 0)?);
    }
    Ok(out)
}

pub async fn mssql_list_tables(client: &mut MsSqlClient, database: &str) -> DbResult<Vec<TableInfo>> {
    let sql = format!(
        "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM {}.INFORMATION_SCHEMA.TABLES \
         WHERE TABLE_CATALOG = @P1 ORDER BY TABLE_SCHEMA, TABLE_NAME",
        mssql_ident(database)
    );
    let mut stream = client
        .query(sql, &[&database])
        .await
        .map_err(|e| mssql_err("List tables", e))?;

    let mut out = Vec::new();
    while let Some(item) = stream.try_next().await.map_err(|e| mssql_err("List tables", e))? {
        let Some(row) = item.into_row() else { continue };
        out.push(TableInfo {
            schema: cell_str(&row, 0)?,
            name: cell_str(&row, 1)?,
            kind: cell_str(&row, 2)?,
        });
    }
    Ok(out)
}

pub async fn mssql_describe_table(
    client: &mut MsSqlClient,
    schema: &str,
    table: &str,
) -> DbResult<TableDetails> {
    let object_id = format!("OBJECT_ID({})", mssql_lit(&format!("{schema}.{table}")));

    let sql = format!(
        "SELECT c.name, \
                TYPE_NAME(c.user_type_id) + \
                CASE WHEN TYPE_NAME(c.system_type_id) IN ('decimal','numeric') \
                     THEN '(' + CAST(c.precision AS nvarchar(10)) + ',' + CAST(c.scale AS nvarchar(10)) + ')' \
                     WHEN TYPE_NAME(c.system_type_id) IN ('char','varchar','binary','varbinary') AND c.max_length > 0 \
                     THEN '(' + CAST(c.max_length AS nvarchar(10)) + ')' \
                     WHEN TYPE_NAME(c.system_type_id) IN ('nchar','nvarchar') AND c.max_length > 0 \
                     THEN '(' + CAST(c.max_length / 2 AS nvarchar(10)) + ')' \
                     ELSE '' END, \
                c.is_nullable, c.is_identity, dc.definition \
         FROM sys.columns c \
         LEFT JOIN sys.default_constraints dc \
                ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
         WHERE c.object_id = {object_id} \
         ORDER BY c.column_id"
    );
    let mut stream = client
        .query(sql, &[])
        .await
        .map_err(|e| mssql_err("Describe table", e))?;
    let mut columns = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| mssql_err("Describe table", e))?
    {
        let Some(row) = item.into_row() else { continue };
        columns.push(ColumnMeta {
            name: cell_str(&row, 0)?,
            data_type: cell_str(&row, 1)?,
            nullable: row
                .try_get::<bool, _>(2)
                .map_err(|e| e.to_string())?
                .unwrap_or(false),
            key: String::new(),
            default: row
                .try_get::<&str, _>(4)
                .map_err(|e| e.to_string())?
                .map(str::to_owned),
            extra: if row
                .try_get::<bool, _>(3)
                .map_err(|e| e.to_string())?
                .unwrap_or(false)
            {
                "identity".to_string()
            } else {
                String::new()
            },
        });
    }
    drop(stream);

    let sql = format!(
        "SELECT i.name, i.is_unique, i.is_primary_key, i.is_unique_constraint, ic.key_ordinal, c.name \
         FROM sys.indexes i \
         JOIN sys.index_columns ic \
                ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0 \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = {object_id} \
         ORDER BY i.index_id, ic.key_ordinal"
    );
    let mut stream = client
        .query(sql, &[])
        .await
        .map_err(|e| mssql_err("Describe table", e))?;
    let mut index_rows: Vec<(String, bool, bool, Vec<String>)> = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| mssql_err("Describe table", e))?
    {
        let Some(row) = item.into_row() else { continue };
        let name = row
            .try_get::<&str, _>(0)
            .map_err(|e| e.to_string())?
            .unwrap_or("?")
            .to_owned();
        let read_flag = |idx: usize| -> DbResult<bool> {
            row.try_get::<bool, _>(idx)
                .map_err(|e| e.to_string())
                .map(|v| v.unwrap_or(false))
        };
        // Unique constraints surface as unique indexes in sys.indexes.
        let unique = read_flag(1)? || read_flag(3)?;
        let primary = read_flag(2)?;
        let column = cell_str(&row, 5)?;
        match index_rows.last_mut() {
            Some((known, _, _, columns)) if *known == name => columns.push(column),
            _ => index_rows.push((name, unique || primary, primary, vec![column])),
        }
    }
    let (unique_keys, indexes): (Vec<_>, Vec<_>) = index_rows
        .into_iter()
        .map(|(name, unique, primary, columns)| IndexMeta {
            name,
            unique,
            primary,
            columns,
        })
        .partition(|index| index.unique || index.primary);
    drop(stream);

    let sql = format!(
        "SELECT fk.name, fkc.constraint_column_id, pc.name, \
                OBJECT_NAME(fk.referenced_object_id), rc.name, \
                fk.update_referential_action_desc, fk.delete_referential_action_desc \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.parent_object_id = {object_id} \
         ORDER BY fk.name, fkc.constraint_column_id"
    );
    let mut stream = client
        .query(sql, &[])
        .await
        .map_err(|e| mssql_err("Describe table", e))?;
    let mut fk_rows: Vec<(String, String, u64, String, String, String, String)> = Vec::new();
    while let Some(item) = stream
        .try_next()
        .await
        .map_err(|e| mssql_err("Describe table", e))?
    {
        let Some(row) = item.into_row() else { continue };
        let name = cell_str(&row, 0)?;
        let column = cell_str(&row, 2)?;
        let ref_table = cell_str(&row, 3)?;
        let ref_column = cell_str(&row, 4)?;
        let action = |idx: usize| -> DbResult<String> {
            Ok(row
                .try_get::<&str, _>(idx)
                .map_err(|e| e.to_string())?
                .unwrap_or_default()
                .replace('_', " "))
        };
        let on_update = action(5)?;
        let on_delete = action(6)?;
        // Merging composite keys happens in group_fk_rows.
        fk_rows.push((name, column, 0, ref_table, ref_column, on_update, on_delete));
    }

    let mut details = TableDetails {
        columns,
        indexes,
        foreign_keys: group_fk_rows(fk_rows),
        unique_keys,
    };
    apply_mssql_key_badges(&mut details.columns, &details.unique_keys, &details.foreign_keys);
    Ok(details)
}

/// Stamps `PRI`/`UNI`/`FK` onto columns; earlier badges win so a PK column
/// that is also part of an FK stays `PRI`.
fn apply_mssql_key_badges(
    columns: &mut [ColumnMeta],
    unique_keys: &[IndexMeta],
    foreign_keys: &[ForeignKeyMeta],
) {
    let mut stamp = |name: &str, badge: &str| {
        if let Some(meta) = columns.iter_mut().find(|c| c.name == name) {
            if meta.key.is_empty() {
                meta.key = badge.to_string();
            }
        }
    };
    for index in unique_keys {
        let badge = if index.primary { "PRI" } else { "UNI" };
        for column in &index.columns {
            stamp(column, badge);
        }
    }
    for fk in foreign_keys {
        for column in &fk.columns {
            stamp(column, "FK");
        }
    }
}

pub async fn mssql_run_query(client: &mut MsSqlClient, sql: &str) -> DbResult<QueryOutcome> {
    let started = Instant::now();
    let mut stream = client
        .query(sql, &[])
        .await
        .map_err(|e| mssql_err("Query", e))?;

    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut row_count = 0usize;
    let mut truncated = false;

    while let Some(item) = stream.try_next().await.map_err(|e| mssql_err("Query", e))? {
        if let Some(metadata) = item.as_metadata() {
            if columns.is_empty() {
                columns = metadata.columns().iter().map(|c| c.name().to_string()).collect();
            }
            continue;
        }
        let Some(row) = item.into_row() else { continue };
        row_count += 1;
        if rows.len() < MAX_ROWS {
            rows.push(
                (0..row.len())
                    .map(|i| row.get_column_data(i).ok().and_then(mssql_display))
                    .collect(),
            );
        } else {
            truncated = true;
        }
    }

    // The stream keeps `client` borrowed until it is dropped.
    drop(stream);

    // A statement that produced no result set was DML/DDL; the streaming API
    // does not report affected rows, so ask the session.
    let affected_rows = if columns.is_empty() {
        mssql_rows_affected(client).await.unwrap_or(0)
    } else {
        0
    };

    Ok(QueryOutcome {
        columns,
        rows,
        row_count,
        affected_rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        truncated,
    })
}

fn mssql_err<E: std::fmt::Display>(label: &str, error: E) -> String {
    format!("{label} failed: {error}")
}

async fn mssql_rows_affected(client: &mut MsSqlClient) -> Option<u64> {
    let stream = client.query("SELECT @@ROWCOUNT", &[]).await.ok()?;
    let row = stream.into_row().await.ok()??;
    Some(row.get::<i32, _>(0)?.max(0) as u64)
}

fn cell_str(row: &tiberius::Row, index: usize) -> DbResult<String> {
    let value = row
        .try_get::<&str, _>(index)
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    Ok(value.to_owned())
}

fn mssql_display(value: &ColumnData<'_>) -> Option<String> {
    match value {
        ColumnData::U8(v) => v.map(|v| v.to_string()),
        ColumnData::I16(v) => v.map(|v| v.to_string()),
        ColumnData::I32(v) => v.map(|v| v.to_string()),
        ColumnData::I64(v) => v.map(|v| v.to_string()),
        ColumnData::F32(v) => v.map(|v| v.to_string()),
        ColumnData::F64(v) => v.map(|v| v.to_string()),
        ColumnData::Bit(v) => v.map(|v| if v { "1" } else { "0" }.to_string()),
        ColumnData::String(v) => v.as_ref().map(|s| s.as_ref().to_owned()),
        ColumnData::Guid(v) => v.map(|g| g.to_string()),
        ColumnData::Binary(v) => v.as_ref().map(|b| format!("0x{}", hex(b))),
        ColumnData::Numeric(v) => v.map(|n| n.to_string()),
        ColumnData::Xml(v) => v.as_ref().map(|x| x.to_string()),
        ColumnData::DateTime(v) => v.map(|d| {
            let seconds = (u64::from(d.seconds_fragments()) + 150) / 300;
            timestamp((i64::from(d.days()) - DAYS_1900_TO_1970) * 86400 + seconds as i64)
        }),
        ColumnData::SmallDateTime(v) => v.map(|d| {
            timestamp(
                (i64::from(d.days()) - DAYS_1900_TO_1970) * 86400
                    + i64::from(d.seconds_fragments()) * 60,
            )
        }),
        ColumnData::Time(v) => v.map(|t| clock(t.increments(), t.scale())),
        ColumnData::Date(v) => v.map(|d| date(d.days() as i64)),
        ColumnData::DateTime2(v) => v.map(datetime2),
        ColumnData::DateTimeOffset(v) => v.map(|d| {
            let offset = d.offset();
            let sign = if offset < 0 { '-' } else { '+' };
            let minutes = offset.unsigned_abs();
            format!(
                "{} {sign}{:02}:{:02}",
                datetime2(d.datetime2()),
                minutes / 60,
                minutes % 60
            )
        }),
    }
}

fn datetime2(value: tds_time::DateTime2) -> String {
    format!("{} {}", date(value.date().days() as i64), clock(value.time().increments(), value.time().scale()))
}

fn date(days: i64) -> String {
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// `increments` counts 10^-scale seconds since midnight.
fn clock(increments: u64, scale: u8) -> String {
    let divisor = 10u64.pow(u32::from(scale));
    let seconds = increments / divisor;
    let base = format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    );
    let fraction = increments % divisor;
    if scale == 0 || fraction == 0 {
        base
    } else {
        format!("{base}.{fraction:0pad$}", pad = scale as usize)
    }
}

fn timestamp(seconds: i64) -> String {
    format!(
        "{} {}",
        date(seconds.div_euclid(86400)),
        clock(seconds.rem_euclid(86400) as u64, 0)
    )
}

/// Days since the Unix epoch to a proleptic Gregorian (year, month, day).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719468;
    let era = shifted.div_euclid(146097);
    let day_of_era = shifted.rem_euclid(146097) as u64;
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

// ---------- Tauri commands ----------

/// Folders live next to connections.json, named for their sibling.
fn groups_path(config_path: &Path) -> PathBuf {
    config_path.with_file_name("groups.json")
}

/// Validates and appends a folder name; shared by the command and tests.
fn add_group(groups: &mut Vec<String>, name: &str) -> DbResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Group name cannot be empty".into());
    }
    if groups.iter().any(|g| g == name) {
        return Err(format!("Group \"{name}\" already exists"));
    }
    groups.push(name.to_string());
    Ok(())
}

#[tauri::command]
pub fn list_groups(state: tauri::State<'_, AppState>) -> DbResult<Vec<String>> {
    let mut groups = state.groups.lock().map_err(|_| "State poisoned")?.clone();
    groups.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(groups)
}

#[tauri::command]
pub fn create_group(state: tauri::State<'_, AppState>, name: String) -> DbResult<()> {
    {
        let mut groups = state.groups.lock().map_err(|_| "State poisoned")?;
        add_group(&mut groups, &name)?;
    }
    state.persist_groups()
}

#[tauri::command]
pub fn list_connections(state: tauri::State<'_, AppState>) -> DbResult<Vec<ConnectionView>> {
    let connected = state.conns.lock().map_err(|_| "State poisoned")?;
    let specs = state.specs.lock().map_err(|_| "State poisoned")?;
    Ok(specs
        .iter()
        .map(|spec| ConnectionView {
            connected: connected.contains_key(&spec.id),
            spec: spec.clone(),
        })
        .collect())
}

#[tauri::command]
pub fn save_connection(state: tauri::State<'_, AppState>, spec: ConnectionSpec) -> DbResult<()> {
    let mut specs = state.specs.lock().map_err(|_| "State poisoned")?;
    match specs.iter_mut().find(|s| s.id == spec.id) {
        Some(existing) => *existing = spec,
        None => specs.push(spec),
    }
    drop(specs);
    state.persist()
}

#[tauri::command]
pub fn delete_connection(state: tauri::State<'_, AppState>, id: String) -> DbResult<()> {
    state
        .conns
        .lock()
        .map_err(|_| "State poisoned")?
        .remove(&id);
    let mut specs = state.specs.lock().map_err(|_| "State poisoned")?;
    specs.retain(|s| s.id != id);
    drop(specs);
    keychain_wipe(&id);
    state.persist()
}

/// Hands the stored password back only for connections that opted into
/// saving it; used to prefill the connect dialog.
#[tauri::command]
pub fn get_password(state: tauri::State<'_, AppState>, id: String) -> DbResult<Option<String>> {
    if !state.spec(&id)?.save_password {
        return Ok(None);
    }
    Ok(keychain_load(&id))
}

#[tauri::command]
pub async fn connect(state: tauri::State<'_, AppState>, id: String, password: String) -> DbResult<()> {
    let spec = state.spec(&id)?;
    let handle = match spec.kind {
        Engine::MySql => {
            let blocking = {
                let spec = spec.clone();
                let password = password.clone();
                tauri::async_runtime::spawn_blocking(move || connect_with(&spec, &password))
            };
            ConnHandle::MySql(Arc::new(Mutex::new(
                blocking.await.map_err(|e| e.to_string())??,
            )))
        }
        Engine::MsSql => ConnHandle::MsSql(Arc::new(tokio::sync::Mutex::new(
            connect_mssql_with(&spec, &password).await?,
        ))),
    };

    state
        .conns
        .lock()
        .map_err(|_| "State poisoned")?
        .insert(id.clone(), handle);

    // Only touch the keychain once the connection itself succeeded. An empty
    // password with the flag on keeps whatever is already stored.
    if spec.save_password {
        if !password.is_empty() {
            keychain_store(&id, &password).map_err(|e| {
                format!("Connected, but saving the password in the keychain failed: {e}")
            })?;
        }
    } else {
        keychain_wipe(&id);
    }
    Ok(())
}

#[tauri::command]
pub fn disconnect(state: tauri::State<'_, AppState>, id: String) -> DbResult<()> {
    state
        .conns
        .lock()
        .map_err(|_| "State poisoned")?
        .remove(&id);
    Ok(())
}

async fn with_mysql<T, F>(handle: Arc<Mutex<Conn>>, work: F) -> DbResult<T>
where
    T: Send + 'static,
    F: FnOnce(&mut Conn) -> DbResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = handle.lock().map_err(|_| "Connection state poisoned")?;
        work(&mut conn)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_schemas(state: tauri::State<'_, AppState>, id: String) -> DbResult<Vec<String>> {
    match state.conn_handle(&id)? {
        ConnHandle::MySql(handle) => with_mysql(handle, list_schemas_with).await,
        ConnHandle::MsSql(handle) => {
            let mut client = handle.lock().await;
            mssql_list_schemas(&mut client).await
        }
    }
}

#[tauri::command]
pub async fn list_tables(
    state: tauri::State<'_, AppState>,
    id: String,
    schema: String,
) -> DbResult<Vec<TableInfo>> {
    match state.conn_handle(&id)? {
        ConnHandle::MySql(handle) => {
            with_mysql(handle, move |conn| list_tables_with(conn, &schema)).await
        }
        ConnHandle::MsSql(handle) => {
            let mut client = handle.lock().await;
            mssql_list_tables(&mut client, &schema).await
        }
    }
}

#[tauri::command]
pub async fn describe_table(
    state: tauri::State<'_, AppState>,
    id: String,
    schema: String,
    table: String,
) -> DbResult<TableDetails> {
    match state.conn_handle(&id)? {
        ConnHandle::MySql(handle) => {
            with_mysql(handle, move |conn| mysql_describe_table(conn, &schema, &table)).await
        }
        ConnHandle::MsSql(handle) => {
            let mut client = handle.lock().await;
            mssql_describe_table(&mut client, &schema, &table).await
        }
    }
}

#[tauri::command]
pub async fn run_query(
    state: tauri::State<'_, AppState>,
    id: String,
    sql: String,
) -> DbResult<QueryOutcome> {
    match state.conn_handle(&id)? {
        ConnHandle::MySql(handle) => with_mysql(handle, move |conn| run_query_with(conn, &sql)).await,
        ConnHandle::MsSql(handle) => {
            let mut client = handle.lock().await;
            mssql_run_query(&mut client, &sql).await
        }
    }
}

pub fn config_path(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .expect("platform provides a config dir");
    fs::create_dir_all(&dir).expect("config dir is writable");
    dir.join("connections.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ConnectionSpec {
        ConnectionSpec {
            id: "c1".into(),
            name: "demo".into(),
            host: "localhost".into(),
            port: 3306,
            user: "root".into(),
            database: "shop".into(),
            kind: Engine::MySql,
            encryption: None,
            group: None,
            save_password: false,
        }
    }

    #[test]
    fn display_formats_each_value_kind() {
        assert_eq!(display(&Value::NULL), None);
        assert_eq!(display(&Value::Int(-42)), Some("-42".into()));
        assert_eq!(display(&Value::UInt(7)), Some("7".into()));
        assert_eq!(display(&Value::Double(1.5)), Some("1.5".into()));
        assert_eq!(display(&Value::Bytes(b"hi".to_vec())), Some("hi".into()));
        assert_eq!(
            display(&Value::Date(2026, 10, 14, 9, 5, 3, 0)),
            Some("2026-10-14 09:05:03".into())
        );
        assert_eq!(
            display(&Value::Date(2026, 10, 14, 9, 5, 3, 123456)),
            Some("2026-10-14 09:05:03.123456".into())
        );
        assert_eq!(
            display(&Value::Time(false, 1, 2, 3, 4, 5)),
            Some("26:03:04.000005".into())
        );
        assert_eq!(display(&Value::Time(true, 0, 1, 0, 0, 0)), Some("-1:00:00.000000".into()));
    }

    #[test]
    fn spec_round_trips_through_json_without_password() {
        let json = serde_json::to_string(&spec()).unwrap();
        assert!(!json.contains("password"), "spec must never carry a password");
        let back: ConnectionSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back, spec());
    }

    #[test]
    fn spec_tolerates_missing_database_field() {
        let raw = r#"{"id":"x","name":"n","host":"h","port":1,"user":"u"}"#;
        let parsed: ConnectionSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.database, "");
        assert_eq!(parsed.kind, Engine::MySql, "old configs are MySQL");
    }

    #[test]
    fn spec_reads_the_engine_kind() {
        let raw = r#"{"id":"x","name":"n","host":"h","port":1433,"user":"u","kind":"mssql"}"#;
        let parsed: ConnectionSpec = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.kind, Engine::MsSql);
        assert_eq!(serde_json::to_string(&Engine::MySql).unwrap(), "\"mysql\"");
    }

    #[test]
    fn mssql_encryption_option_maps_and_stays_out_of_mysql_json() {
        let off: ConnectionSpec = serde_json::from_str(
            r#"{"id":"x","name":"n","host":"h","port":1433,"user":"u","kind":"mssql","encryption":"off"}"#,
        )
        .unwrap();
        assert_eq!(off.encryption, Some(MssqlEncryption::Off));
        assert!(matches!(
            mssql_encryption_level(&off),
            EncryptionLevel::NotSupported
        ));

        let legacy: ConnectionSpec = serde_json::from_str(
            r#"{"id":"x","name":"n","host":"h","port":1433,"user":"u","kind":"mssql"}"#,
        )
        .unwrap();
        assert_eq!(legacy.encryption, None);
        assert!(matches!(
            mssql_encryption_level(&legacy),
            EncryptionLevel::Required
        ));

        assert!(!serde_json::to_string(&spec()).unwrap().contains("encryption"));
    }

    #[test]
    fn save_password_flag_round_trips_and_stays_off_disk_when_false() {
        let mut saved = spec();
        saved.save_password = true;
        let json = serde_json::to_string(&saved).unwrap();
        assert!(json.contains("\"savePassword\":true"));
        assert_eq!(serde_json::from_str::<ConnectionSpec>(&json).unwrap(), saved);

        // Old configs lack the flag, and opting out never reaches the JSON.
        let legacy: ConnectionSpec =
            serde_json::from_str(r#"{"id":"x","name":"n","host":"h","port":1,"user":"u"}"#)
                .unwrap();
        assert!(!legacy.save_password);
        assert!(!serde_json::to_string(&spec()).unwrap().contains("savePassword"));
    }

    #[test]
    fn group_round_trips_and_stays_out_of_json_when_unset() {
        let mut grouped = spec();
        grouped.group = Some("Production".into());
        let json = serde_json::to_string(&grouped).unwrap();
        assert!(json.contains("\"group\":\"Production\""));
        assert_eq!(serde_json::from_str::<ConnectionSpec>(&json).unwrap(), grouped);

        // Old configs have no group, and ungrouped connections omit the field.
        let legacy: ConnectionSpec =
            serde_json::from_str(r#"{"id":"x","name":"n","host":"h","port":1,"user":"u"}"#)
                .unwrap();
        assert_eq!(legacy.group, None);
        assert!(!serde_json::to_string(&spec()).unwrap().contains("group"));
    }

    /// Touches the real OS keychain; run explicitly with --ignored.
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        const ID: &str = "selftest-keyring";
        keychain_wipe(ID);
        assert_eq!(keychain_load(ID), None);
        keychain_store(ID, "not-a-real-password").expect("store");
        assert_eq!(keychain_load(ID).as_deref(), Some("not-a-real-password"));
        keychain_wipe(ID);
        assert_eq!(keychain_load(ID), None);
    }

    #[test]
    fn mssql_display_formats_scalars() {
        assert_eq!(mssql_display(&ColumnData::I32(None)), None);
        assert_eq!(mssql_display(&ColumnData::I64(Some(-42))), Some("-42".into()));
        assert_eq!(mssql_display(&ColumnData::F64(Some(1.5))), Some("1.5".into()));
        assert_eq!(mssql_display(&ColumnData::Bit(Some(true))), Some("1".into()));
        assert_eq!(mssql_display(&ColumnData::Bit(Some(false))), Some("0".into()));
        assert_eq!(
            mssql_display(&ColumnData::String(Some("hi".into()))),
            Some("hi".into())
        );
        assert_eq!(
            mssql_display(&ColumnData::Binary(Some(vec![0xde, 0xad].into()))),
            Some("0xdead".into())
        );
        assert_eq!(
            mssql_display(&ColumnData::Numeric(Some(tiberius::numeric::Numeric::new_with_scale(-1234, 2)))),
            Some("-12.34".into())
        );
    }

    #[test]
    fn mssql_display_formats_dates_and_times() {
        // 19723 days after the Unix epoch is 2024-01-01.
        assert_eq!(mssql_display(&ColumnData::Date(Some(tds_time::Date::new(19723)))), Some("2024-01-01".into()));
        assert_eq!(mssql_display(&ColumnData::Date(Some(tds_time::Date::new(0)))), Some("1970-01-01".into()));

        // 09:00:00.1234567 at datetime2's 100ns precision.
        let time = tds_time::Time::new(324_000_000_000 + 1_234_567, 7);
        assert_eq!(mssql_display(&ColumnData::Time(Some(time))), Some("09:00:00.1234567".into()));
        assert_eq!(
            mssql_display(&ColumnData::Time(Some(tds_time::Time::new(32_400, 0)))),
            Some("09:00:00".into())
        );

        let datetime2 = tds_time::DateTime2::new(tds_time::Date::new(19723), time);
        assert_eq!(
            mssql_display(&ColumnData::DateTime2(Some(datetime2))),
            Some("2024-01-01 09:00:00.1234567".into())
        );
        assert_eq!(
            mssql_display(&ColumnData::DateTimeOffset(Some(tds_time::DateTimeOffset::new(
                tds_time::DateTime2::new(tds_time::Date::new(19723), tds_time::Time::new(32_400, 0)),
                420
            )))),
            Some("2024-01-01 09:00:00 +07:00".into())
        );

        // Legacy datetime counts days from 1900-01-01 in 1/300s fragments.
        assert_eq!(
            mssql_display(&ColumnData::DateTime(Some(tds_time::DateTime::new(0, 0)))),
            Some("1900-01-01 00:00:00".into())
        );
        assert_eq!(
            mssql_display(&ColumnData::DateTime(Some(tds_time::DateTime::new(45_000, 32_583 * 300)))),
            Some("2023-03-17 09:03:03".into())
        );
        assert_eq!(
            mssql_display(&ColumnData::SmallDateTime(Some(tds_time::SmallDateTime::new(0, 90)))),
            Some("1900-01-01 01:30:00".into())
        );
    }

    #[test]
    fn civil_from_days_handles_both_sides_of_the_epoch() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19723), (2024, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(-25567), (1900, 1, 1));
        assert_eq!(civil_from_days(20_148), (2025, 3, 1));
    }

    #[test]
    fn mssql_ident_escapes_brackets() {
        assert_eq!(mssql_ident("dbo"), "[dbo]");
        assert_eq!(mssql_ident("we]ird"), "[we]]ird]");
    }

    #[test]
    fn mssql_lit_escapes_quotes() {
        assert_eq!(mssql_lit("dbo.users"), "N'dbo.users'");
        assert_eq!(mssql_lit("ob'ject"), "N'ob''ject'");
    }

    #[test]
    fn index_rows_split_into_plain_and_unique_groups() {
        // (name, seq, column, non_unique) as ordered by the query.
        let rows = vec![
            ("PRIMARY".into(), 1, "id".into(), 0),
            ("email_key".into(), 1, "email".into(), 0),
            ("idx_name".into(), 1, "last_name".into(), 1),
            ("idx_name".into(), 2, "first_name".into(), 1),
        ];
        let (indexes, unique_keys) = group_index_rows(rows);
        assert_eq!(indexes.len(), 1);
        assert_eq!(indexes[0].name, "idx_name");
        assert!(!indexes[0].unique);
        assert_eq!(indexes[0].columns, ["last_name", "first_name"]);
        assert_eq!(
            unique_keys.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(),
            ["PRIMARY", "email_key"]
        );
        assert!(unique_keys[0].primary && unique_keys[0].unique);
        assert!(!unique_keys[1].primary && unique_keys[1].unique);
    }

    #[test]
    fn fk_rows_merge_composite_constraints() {
        let rows = vec![
            (
                "fk_order".into(),
                "customer_id".into(),
                1,
                "customers".into(),
                "id".into(),
                "CASCADE".into(),
                "RESTRICT".into(),
            ),
            (
                "fk_order".into(),
                "region_id".into(),
                2,
                "customers".into(),
                "region".into(),
                "CASCADE".into(),
                "RESTRICT".into(),
            ),
            (
                "fk_item".into(),
                "order_id".into(),
                1,
                "orders".into(),
                "id".into(),
                "NO ACTION".into(),
                "NO ACTION".into(),
            ),
        ];
        let fks = group_fk_rows(rows);
        assert_eq!(fks.len(), 2);
        assert_eq!(fks[0].columns, ["customer_id", "region_id"]);
        assert_eq!(fks[0].ref_columns, ["id", "region"]);
        assert_eq!(fks[0].ref_table, "customers");
        assert_eq!(fks[1].columns, ["order_id"]);
    }

    #[test]
    fn mssql_key_badges_respect_precedence() {
        let mut columns = vec![
            ColumnMeta {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                key: String::new(),
                default: None,
                extra: String::new(),
            },
            ColumnMeta {
                name: "email".into(),
                data_type: "nvarchar(255)".into(),
                nullable: false,
                key: String::new(),
                default: None,
                extra: String::new(),
            },
            ColumnMeta {
                name: "customer_id".into(),
                data_type: "int".into(),
                nullable: true,
                key: String::new(),
                default: None,
                extra: String::new(),
            },
        ];
        let unique_keys = vec![IndexMeta {
            name: "PK_users".into(),
            columns: vec!["id".into()],
            unique: true,
            primary: true,
        }];
        let foreign_keys = vec![ForeignKeyMeta {
            name: "fk_order_customer".into(),
            columns: vec!["id".into(), "customer_id".into()],
            ref_table: "customers".into(),
            ref_columns: vec!["id".into(), "id".into()],
            on_update: "NO ACTION".into(),
            on_delete: "CASCADE".into(),
        }];
        apply_mssql_key_badges(&mut columns, &unique_keys, &foreign_keys);
        // PRI wins over FK for the id column.
        assert_eq!(columns[0].key, "PRI");
        assert_eq!(columns[1].key, "");
        assert_eq!(columns[2].key, "FK");
    }

    #[test]
    fn table_details_serialize_in_camel_case() {
        let details = TableDetails {
            columns: vec![ColumnMeta {
                name: "id".into(),
                data_type: "int".into(),
                nullable: false,
                key: "PRI".into(),
                default: None,
                extra: "auto_increment".into(),
            }],
            indexes: vec![],
            foreign_keys: vec![ForeignKeyMeta {
                name: "fk".into(),
                columns: vec!["a".into()],
                ref_table: "t".into(),
                ref_columns: vec!["b".into()],
                on_update: "NO ACTION".into(),
                on_delete: "CASCADE".into(),
            }],
            unique_keys: vec![IndexMeta {
                name: "PRIMARY".into(),
                columns: vec!["id".into()],
                unique: true,
                primary: true,
            }],
        };
        let json = serde_json::to_string(&details).unwrap();
        for key in ["dataType", "foreignKeys", "uniqueKeys", "refTable", "refColumns", "onUpdate", "onDelete"] {
            assert!(json.contains(&format!("\"{key}\"")), "missing {key}: {json}");
        }
    }

    #[test]
    fn state_loads_persisted_specs_and_reports_connected() {
        let dir = std::env::temp_dir().join(format!("sqlnotebook-state-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");
        fs::write(&path, serde_json::to_string(&vec![spec()]).unwrap()).unwrap();

        let state = AppState::load(path.clone());
        assert_eq!(state.specs.lock().unwrap().len(), 1);
        assert!(state.conn_handle("c1").is_err());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_upserts_and_persists() {
        let dir = std::env::temp_dir().join(format!("sqlnotebook-save-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");

        let state = AppState::load(path.clone());
        {
            let mut specs = state.specs.lock().unwrap();
            specs.push(spec());
        }
        state.persist().unwrap();

        let reloaded = AppState::load(path.clone());
        assert_eq!(reloaded.specs.lock().unwrap().as_slice(), [spec()]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn groups_validate_and_persist_to_sibling_file() {
        let dir = std::env::temp_dir().join(format!("sqlnotebook-groups-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connections.json");

        let state = AppState::load(path.clone());
        assert!(state.groups.lock().unwrap().is_empty(), "old configs have no groups file");
        {
            let mut groups = state.groups.lock().unwrap();
            add_group(&mut groups, "Production").unwrap();
            assert!(add_group(&mut groups, "   ").is_err(), "blank names rejected");
            assert!(add_group(&mut groups, " Production ").is_err(), "name is trimmed before dupe check");
        }
        state.persist_groups().unwrap();

        let groups_file = path.with_file_name("groups.json");
        assert!(groups_file.exists());
        let reloaded = AppState::load(path);
        assert_eq!(
            reloaded.groups.lock().unwrap().as_slice(),
            ["Production".to_string()]
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    /// Runs against a real server; skipped unless MYSQL_TEST_HOST etc. are set.
    #[test]
    #[ignore]
    fn live_mysql_round_trip() {
        let Ok(host) = std::env::var("MYSQL_TEST_HOST") else {
            eprintln!("MYSQL_TEST_HOST not set; skipping live test");
            return;
        };
        let spec = ConnectionSpec {
            id: "live".into(),
            name: "live".into(),
            host,
            port: std::env::var("MYSQL_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306),
            user: std::env::var("MYSQL_TEST_USER").unwrap_or_else(|_| "root".into()),
            database: std::env::var("MYSQL_TEST_DB").unwrap_or_default(),
            kind: Engine::MySql,
            encryption: None,
            group: None,
            save_password: false,
        };
        let password = std::env::var("MYSQL_TEST_PASSWORD").expect("MYSQL_TEST_PASSWORD");

        let mut conn = connect_with(&spec, &password).expect("connect");
        let schemas = list_schemas_with(&mut conn).expect("schemas");
        assert!(!schemas.is_empty());

        let schema = if spec.database.is_empty() {
            schemas
                .iter()
                .find(|s| !matches!(s.as_str(), "information_schema" | "mysql" | "performance_schema" | "sys"))
                .cloned()
                .unwrap_or_else(|| schemas[0].clone())
        } else {
            spec.database.clone()
        };

        let tables = list_tables_with(&mut conn, &schema).expect("tables");
        eprintln!("schema={schema} tables={tables:?}");

        if let Some(table) = tables.first() {
            let sql = format!("SELECT * FROM `{schema}`.`{}` LIMIT 5", table.name);
            let outcome = run_query_with(&mut conn, &sql).expect("query");
            eprintln!("columns={:?} rows={}", outcome.columns, outcome.row_count);
            assert!(outcome.elapsed_ms < 30_000);
        }

        let bad = run_query_with(&mut conn, "SELECT * FROM definitely_not_a_table");
        assert!(bad.is_err(), "bad query must surface an error");
    }

    /// Runs against a real server; skipped unless MSSQL_TEST_HOST etc. are set.
    #[tokio::test]
    #[ignore]
    async fn live_mssql_round_trip() {
        let Ok(host) = std::env::var("MSSQL_TEST_HOST") else {
            eprintln!("MSSQL_TEST_HOST not set; skipping live test");
            return;
        };
        let spec = ConnectionSpec {
            id: "live-mssql".into(),
            name: "live".into(),
            host,
            port: std::env::var("MSSQL_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(1433),
            user: std::env::var("MSSQL_TEST_USER").expect("MSSQL_TEST_USER"),
            database: std::env::var("MSSQL_TEST_DB").unwrap_or_default(),
            kind: Engine::MsSql,
            encryption: match std::env::var("MSSQL_TEST_ENCRYPTION").as_deref() {
                Ok("off") => Some(MssqlEncryption::Off),
                _ => None,
            },
            group: None,
            save_password: false,
        };
        let password = std::env::var("MSSQL_TEST_PASSWORD").expect("MSSQL_TEST_PASSWORD");

        let mut client = connect_mssql_with(&spec, &password).await.expect("connect");
        let databases = mssql_list_schemas(&mut client).await.expect("databases");
        assert!(!databases.is_empty());

        let database = if spec.database.is_empty() {
            databases
                .iter()
                .find(|d| !matches!(d.as_str(), "master" | "tempdb" | "model" | "msdb"))
                .cloned()
                .unwrap_or_else(|| databases[0].clone())
        } else {
            spec.database.clone()
        };

        let tables = mssql_list_tables(&mut client, &database).await.expect("tables");
        eprintln!("database={database} tables={}", tables.len());

        if let Some(table) = tables.first() {
            let sql = format!(
                "SELECT TOP 5 * FROM {}.[{}].[{}]",
                mssql_ident(&database),
                table.schema.replace(']', "]]"),
                table.name.replace(']', "]]")
            );
            let outcome = mssql_run_query(&mut client, &sql).await.expect("query");
            eprintln!("columns={:?} rows={}", outcome.columns, outcome.row_count);
            assert!(!outcome.columns.is_empty());
        }

        let bad = mssql_run_query(&mut client, "SELECT * FROM definitely_not_a_table").await;
        assert!(bad.is_err(), "bad query must surface an error");
    }
}
