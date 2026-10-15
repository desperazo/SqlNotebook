import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";

export type EngineKind = "mysql" | "mssql";

/** SQL Server only. `off` skips TLS entirely (legacy servers). */
export type MssqlEncryption = "required" | "off";

export type ConnectionSpec = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  kind: EngineKind;
  encryption?: MssqlEncryption;
  /** Sidebar folder name; connections sharing one render under a common folder. */
  group?: string;
  /** Opt-in; the password is stored in the OS keychain, never in connections.json. */
  savePassword?: boolean;
};

export type ConnectionView = ConnectionSpec & { connected: boolean };

export type TableInfo = { name: string; kind: string; schema: string };

export type ColumnMeta = {
  name: string;
  dataType: string;
  nullable: boolean;
  /** PRI | UNI | MUL | FK, or "" for a plain column. */
  key: string;
  default: string | null;
  extra: string;
};

export type IndexMeta = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
};

export type ForeignKeyMeta = {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
};

export type TableDetails = {
  columns: ColumnMeta[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  uniqueKeys: IndexMeta[];
};

export type QueryOutcome = {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  affectedRows: number;
  elapsedMs: number;
  truncated: boolean;
};

export const backend = {
  listConnections: () => invoke<ConnectionView[]>("list_connections"),
  saveConnection: (spec: ConnectionSpec) => invoke<void>("save_connection", { spec }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  listGroups: () => invoke<string[]>("list_groups"),
  createGroup: (name: string) => invoke<void>("create_group", { name }),
  getPassword: (id: string) => invoke<string | null>("get_password", { id }),
  connect: (id: string, password: string) => invoke<void>("connect", { id, password }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  listSchemas: (id: string) => invoke<string[]>("list_schemas", { id }),
  listTables: (id: string, schema: string) => invoke<TableInfo[]>("list_tables", { id, schema }),
  describeTable: (id: string, schema: string, table: string) =>
    invoke<TableDetails>("describe_table", { id, schema, table }),
  runQuery: (id: string, sql: string) => invoke<QueryOutcome>("run_query", { id, sql }),
  openSqlPath: () =>
    openFileDialog({
      multiple: false,
      title: "Open SQL file",
      filters: [
        { name: "SQL", extensions: ["sql"] },
        { name: "All Files", extensions: ["*"] },
      ],
    }),
  saveSqlPath: (defaultName: string) =>
    saveFileDialog({
      defaultPath: defaultName,
      title: "Save SQL file",
      filters: [{ name: "SQL", extensions: ["sql"] }],
    }),
  readSqlFile: (path: string) => invoke<string>("read_sql_file", { path }),
  writeSqlFile: (path: string, contents: string) =>
    invoke<void>("write_sql_file", { path, contents }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const defaultPort = (kind: EngineKind): number => (kind === "mssql" ? 1433 : 3306);

export const engineLabel = (kind: EngineKind): string => (kind === "mssql" ? "SQL Server" : "MySQL");

export const quoteIdent = (kind: EngineKind, name: string): string =>
  kind === "mssql"
    ? `[${name.replace(/]/g, "]]")}]`
    : `\`${name.replace(/`/g, "``")}\``;

export const selectSnippet = (kind: EngineKind, database: string, table: TableInfo): string =>
  kind === "mssql"
    ? `SELECT TOP 200 * FROM ${quoteIdent(kind, database)}.${quoteIdent(kind, table.schema)}.${quoteIdent(kind, table.name)};`
    : `SELECT * FROM ${quoteIdent(kind, database)}.${quoteIdent(kind, table.name)} LIMIT 200;`;
