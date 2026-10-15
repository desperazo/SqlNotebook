import { useRef, useState, type CSSProperties } from "react";
import type { ConnectionView, TableDetails, TableInfo } from "../lib/backend";

export type ChildNode =
  | { kind: "schemas"; items: string[] }
  | { kind: "tables"; items: TableInfo[] };

type Props = {
  connections: ConnectionView[];
  /** All known groups: explicitly created ones plus names used by connections. */
  groups: string[];
  children: Record<string, ChildNode>;
  details: Record<string, TableDetails>;
  expanded: Set<string>;
  activeConnId: string | null;
  style?: CSSProperties;
  onHide: () => void;
  onNewConnection: () => void;
  onCreateGroup: (name: string) => void;
  onToggleConnection: (conn: ConnectionView) => void;
  onToggleSchema: (connId: string, schema: string) => void;
  onToggleTable: (conn: ConnectionView, table: TableInfo) => void;
  onSelectTable: (conn: ConnectionView, database: string, table: TableInfo) => void;
  onOpenTable: (conn: ConnectionView, database: string, table: TableInfo) => void;
  onConnectionContextMenu: (conn: ConnectionView, x: number, y: number) => void;
  onDisconnect: (conn: ConnectionView) => void;
  onDelete: (conn: ConnectionView) => void;
  onMoveConnection: (conn: ConnectionView, group: string | null) => void;
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron${open ? " chevron-open" : ""}`}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function DbGlyph() {
  return (
    <svg className="db-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <ellipse cx="8" cy="3.5" rx="5" ry="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M3 3.5v9c0 1.1 2.24 2 5 2s5-.9 5-2v-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function TableGlyph() {
  return (
    <svg className="table-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2 6.5h12M6.5 6.5V13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d="M1.5 12.5V4a1 1 0 0 1 1-1h3.4l1.6 2h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-.9-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function MetaGroup({ label, count, indent }: { label: string; count: number; indent: number }) {
  return (
    <div className="meta-group" style={{ paddingLeft: indent }}>
      {label}
      <span className="meta-count">{count}</span>
    </div>
  );
}

function TableDetailsNode({ details, indent }: { details?: TableDetails; indent: number }) {
  if (!details) {
    return (
      <div className="child-hint" style={{ paddingLeft: indent + 12 }}>
        Loading…
      </div>
    );
  }
  const rowIndent = indent + 24;
  return (
    <>
      <MetaGroup label="Columns" count={details.columns.length} indent={indent + 12} />
      {details.columns.map((column) => (
        <div key={column.name} className="meta-row" style={{ paddingLeft: rowIndent }}>
          <span className="label">{column.name}</span>
          <span className="meta-type">{column.dataType}</span>
          {column.key && <span className="key-badge">{column.key}</span>}
          {(column.extra === "auto_increment" || column.extra === "identity") && (
            <span className="meta-flag">{column.extra === "identity" ? "identity" : "auto"}</span>
          )}
          {column.default !== null && <span className="meta-flag">= {column.default}</span>}
        </div>
      ))}
      <MetaGroup label="Indexes" count={details.indexes.length} indent={indent + 12} />
      {details.indexes.map((index) => (
        <div key={index.name} className="meta-row" style={{ paddingLeft: rowIndent }}>
          <span className="label">{index.name}</span>
          <span className="meta-type">{index.columns.join(", ")}</span>
        </div>
      ))}
      <MetaGroup label="Foreign Keys" count={details.foreignKeys.length} indent={indent + 12} />
      {details.foreignKeys.map((fk) => (
        <div key={fk.name} className="meta-row" style={{ paddingLeft: rowIndent }}>
          <span className="label">{fk.name}</span>
          <span className="meta-type">
            {fk.columns.join(", ")} → {fk.refTable}.{fk.refColumns.join(", ")}
          </span>
          {(fk.onUpdate !== "NO ACTION" || fk.onDelete !== "NO ACTION") && (
            <span className="meta-flag">
              {fk.onUpdate} / {fk.onDelete}
            </span>
          )}
        </div>
      ))}
      <MetaGroup label="Unique Keys" count={details.uniqueKeys.length} indent={indent + 12} />
      {details.uniqueKeys.map((index) => (
        <div key={index.name} className="meta-row" style={{ paddingLeft: rowIndent }}>
          <span className="label">{index.name}</span>
          <span className="meta-type">{index.columns.join(", ")}</span>
        </div>
      ))}
    </>
  );
}

export default function ConnectionsSidebar(props: Props) {
  const {
    connections,
    groups,
    children,
    details,
    expanded,
    activeConnId,
    style,
    onHide,
    onNewConnection,
    onCreateGroup,
    onToggleConnection,
    onToggleSchema,
    onToggleTable,
    onSelectTable,
    onOpenTable,
    onConnectionContextMenu,
    onDisconnect,
    onDelete,
    onMoveConnection,
  } = props;

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  // Group name (or null for the root) currently highlighted as a drop target.
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Inline "New Group" input at the top of the tree.
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const groupCancelled = useRef(false);
  const draggedConn = useRef<ConnectionView | null>(null);
  // Single click expands a table; a double-click (SELECT insert) cancels the
  // pending expansion so the node does not flash open and shut.
  const tableClickTimer = useRef<number | null>(null);
  const cancelPendingTableExpand = () => {
    if (tableClickTimer.current !== null) {
      window.clearTimeout(tableClickTimer.current);
      tableClickTimer.current = null;
    }
  };

  const ungrouped = connections.filter((conn) => !conn.group);
  const membersOf = (name: string) => connections.filter((conn) => conn.group === name);

  const startGroupCreation = () => {
    groupCancelled.current = false;
    setGroupDraft("");
    setCreatingGroup(true);
  };

  const commitGroup = () => {
    if (groupCancelled.current) return;
    const name = groupDraft.trim();
    if (name) onCreateGroup(name);
    setCreatingGroup(false);
  };

  const toggleGroup = (name: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const startConnDrag = (conn: ConnectionView) => (event: React.DragEvent) => {
    draggedConn.current = conn;
    event.dataTransfer.setData("text/plain", conn.id);
    event.dataTransfer.effectAllowed = "move";
  };

  const endConnDrag = () => {
    draggedConn.current = null;
    setDropTarget(null);
  };

  const allowDrop = (event: React.DragEvent) => {
    if (!draggedConn.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const dropOnGroup = (group: string | null) => (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const conn = draggedConn.current;
    draggedConn.current = null;
    setDropTarget(null);
    if (conn && (conn.group ?? null) !== group) onMoveConnection(conn, group);
  };

  const requestDelete = (conn: ConnectionView) => {
    if (pendingDelete === conn.id) {
      setPendingDelete(null);
      onDelete(conn);
      return;
    }
    setPendingDelete(conn.id);
    window.setTimeout(() => {
      setPendingDelete((cur) => (cur === conn.id ? null : cur));
    }, 3000);
  };

  const renderTableNode = (
    conn: ConnectionView,
    table: TableInfo,
    indent: number,
    database: string,
    parentKey: string
  ) => {
    const key = `${conn.id}::${table.schema}::${table.name}`;
    const open = expanded.has(key);
    return (
      <div key={`${parentKey}/${table.schema}.${table.name}`}>
        <div
          className="row row-table"
          style={{ paddingLeft: indent }}
          role="treeitem"
          aria-expanded={open}
          title="Click to show columns, indexes and keys · double-click to insert a SELECT"
          onClick={() => {
            onSelectTable(conn, database, table);
            cancelPendingTableExpand();
            tableClickTimer.current = window.setTimeout(() => {
              tableClickTimer.current = null;
              onToggleTable(conn, table);
            }, 220);
          }}
          onDoubleClick={() => {
            cancelPendingTableExpand();
            onOpenTable(conn, database, table);
          }}
        >
          <Chevron open={open} />
          <TableGlyph />
          {/* MSSQL tables are listed flat per database, so the schema must be
              part of the label to tell same-named tables apart. */}
          <span className="label">
            {conn.kind === "mssql" ? `${table.schema}.${table.name}` : table.name}
          </span>
          <span className="kind-tag">{table.kind === "VIEW" ? "view" : ""}</span>
        </div>
        {open && <TableDetailsNode details={details[key]} indent={indent} />}
      </div>
    );
  };

  const renderConnection = (conn: ConnectionView, base: number) => {
    const open = expanded.has(conn.id);
    const node = children[conn.id];
    const confirming = pendingDelete === conn.id;
    return (
      <div key={conn.id}>
        <div
          className={`row row-conn${activeConnId === conn.id ? " row-active-dir" : ""}${
            confirming ? " row-actions-visible" : ""
          }`}
          style={{ paddingLeft: base }}
          role="treeitem"
          aria-expanded={open}
          title="Right-click for more options · drag onto a folder to group"
          draggable
          onDragStart={startConnDrag(conn)}
          onDragEnd={endConnDrag}
          onClick={() => onToggleConnection(conn)}
          onContextMenu={(event) => {
            event.preventDefault();
            onConnectionContextMenu(conn, event.clientX, event.clientY);
          }}
        >
          <Chevron open={open} />
          <span className={`status-dot${conn.connected ? " status-on" : ""}`} />
          <span className="label">{conn.name}</span>
          <span className="engine-tag">{conn.kind === "mssql" ? "MSSQL" : "MySQL"}</span>
          <span className="row-actions">
            {conn.connected && (
              <button
                className="icon-button"
                title="Disconnect"
                aria-label={`Disconnect ${conn.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDisconnect(conn);
                }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path
                    d="M5 2v3M11 2v3M3 5h10v3a5 5 0 0 1-10 0zM8 13v2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                </svg>
              </button>
            )}
            <button
              className={`icon-button${confirming ? " confirm-delete" : ""}`}
              title={confirming ? "Click again to confirm" : "Delete connection"}
              aria-label={`Delete ${conn.name}`}
              onClick={(e) => {
                e.stopPropagation();
                requestDelete(conn);
              }}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6L11.5 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </button>
          </span>
        </div>

        {open && !conn.connected && (
          <div className="child-hint" style={{ paddingLeft: base + 32 }}>
            Not connected
          </div>
        )}

        {open && conn.connected && !node && (
          <div className="child-hint" style={{ paddingLeft: base + 32 }}>
            Loading…
          </div>
        )}

        {open && conn.connected && node?.kind === "schemas" && (
          <>
            {node.items.map((schema) => {
              const key = `${conn.id}::${schema}`;
              const schemaOpen = expanded.has(key);
              const tables = children[key];
              return (
                <div key={key}>
                  <div
                    className="row row-schema"
                    style={{ paddingLeft: base + 20 }}
                    role="treeitem"
                    aria-expanded={schemaOpen}
                    onClick={() => onToggleSchema(conn.id, schema)}
                  >
                    <Chevron open={schemaOpen} />
                    <DbGlyph />
                    <span className="label">{schema}</span>
                  </div>
                  {schemaOpen &&
                    tables?.kind === "tables" &&
                    tables.items.map((table) =>
                      renderTableNode(conn, table, base + 40, schema, key)
                    )}
                  {schemaOpen &&
                    tables?.kind === "tables" &&
                    tables.items.length === 0 && (
                      <div className="child-hint" style={{ paddingLeft: base + 40 }}>
                        No tables
                      </div>
                    )}
                </div>
              );
            })}
            {node.items.length === 0 && (
              <div className="child-hint" style={{ paddingLeft: base + 32 }}>
                No schemas visible
              </div>
            )}
          </>
        )}

        {open && conn.connected && node?.kind === "tables" && (
          <>
            {node.items.map((table) =>
              renderTableNode(conn, table, base + 36, conn.database, conn.id)
            )}
            {node.items.length === 0 && (
              <div className="child-hint" style={{ paddingLeft: base + 36 }}>
                No tables
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderGroupFolder = (name: string, members: ConnectionView[]) => {
    const open = openGroups.has(name);
    return (
      <div key={`group::${name}`}>
        <div
          className={`row row-group${dropTarget === name ? " row-drop-target" : ""}`}
          role="treeitem"
          aria-expanded={open}
          title="Click to expand · drag connections here to group them"
          onClick={() => toggleGroup(name)}
          onDragOver={(event) => {
            allowDrop(event);
            setDropTarget((cur) => (cur === name ? cur : name));
          }}
          onDragLeave={() => setDropTarget((cur) => (cur === name ? null : cur))}
          onDrop={dropOnGroup(name)}
        >
          <Chevron open={open} />
          <FolderGlyph />
          <span className="label">{name}</span>
          <span className="group-count">{members.length}</span>
        </div>
        {open && members.map((conn) => renderConnection(conn, 24))}
      </div>
    );
  };

  return (
    <aside className="sidebar" style={style}>
      <div className="sidebar-header">
        <span className="sidebar-title">Connections</span>
        <span className="sidebar-header-actions">
          <button
            className="icon-button"
            onClick={onHide}
            title="Hide sidebar (⌘B)"
            aria-label="Hide sidebar"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M11 4.5L7.5 8 11 11.5M6.5 4.5L3 8l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
          </button>
          <button
            className="icon-button"
            onClick={startGroupCreation}
            title="New Group"
            aria-label="New Group"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                d="M1.5 12.5V4a1 1 0 0 1 1-1h3.4l1.6 2h5.9a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-.9-1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path d="M6.5 9.5h3M8 8v3" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button
            className="icon-button"
            onClick={onNewConnection}
            title="New Connection"
            aria-label="New Connection"
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </span>
      </div>

      <div className="tree" role="tree" onDragOver={allowDrop} onDrop={dropOnGroup(null)}>
        {creatingGroup && (
          <form
            className="group-create"
            onSubmit={(event) => {
              event.preventDefault();
              commitGroup();
            }}
          >
            <input
              autoFocus
              value={groupDraft}
              onChange={(event) => setGroupDraft(event.target.value)}
              onBlur={commitGroup}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  groupCancelled.current = true;
                  setCreatingGroup(false);
                }
              }}
              placeholder="Group name"
              aria-label="New group name"
            />
          </form>
        )}

        {connections.length === 0 && (
          <div className="sidebar-empty">
            <p>No connections yet.</p>
            <button className="button" onClick={onNewConnection}>
              New Connection
            </button>
          </div>
        )}

        {ungrouped.map((conn) => renderConnection(conn, 8))}
        {groups.map((name) => renderGroupFolder(name, membersOf(name)))}
      </div>
    </aside>
  );
}
