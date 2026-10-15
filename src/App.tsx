import { useCallback, useEffect, useRef, useState } from "react";
import ConnectionDialog from "./components/ConnectionDialog";
import ConnectionsSidebar, { type ChildNode } from "./components/ConnectionsSidebar";
import QueryPanel from "./components/QueryPanel";
import {
  backend,
  errorMessage,
  selectSnippet,
  type ConnectionSpec,
  type ConnectionView,
  type QueryOutcome,
  type TableDetails,
  type TableInfo,
} from "./lib/backend";

type DialogState =
  | { mode: "new" }
  | { mode: "connect"; conn: ConnectionView; newTab?: boolean }
  | null;

type QueryTab = {
  id: string;
  connId: string;
  sql: string;
  outcome: QueryOutcome | null;
  error: string | null;
  running: boolean;
  /// Set once the editor content was opened from or saved to a file; Save then
  /// writes there without asking again.
  filePath: string | null;
};

type ConnContextMenu = { conn: ConnectionView; x: number; y: number };

const emptyTab = (connId: string, sql = ""): QueryTab => ({
  id: crypto.randomUUID(),
  connId,
  sql,
  outcome: null,
  error: null,
  running: false,
  filePath: null,
});

const SIDEBAR_WIDTH_KEY = "sqlnotebook.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "sqlnotebook.sidebarCollapsed";
const SIDEBAR_MIN_WIDTH = 200;

const storedSidebarWidth = (): number | null => {
  const parsed = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(parsed) && parsed >= SIDEBAR_MIN_WIDTH ? parsed : null;
};

export default function App() {
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  // Groups created explicitly via New Group; folder names used only by
  // connections are merged in for the sidebar and dialog suggestions.
  const [persistedGroups, setPersistedGroups] = useState<string[]>([]);
  const [children, setChildren] = useState<Record<string, ChildNode>>({});
  // Fetched table metadata, keyed like the expanded set: connId::schema::table.
  const [details, setDetails] = useState<Record<string, TableDetails>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<QueryTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [status, setStatus] = useState("Add a connection to begin");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<ConnContextMenu | null>(null);
  const [groupMenu, setGroupMenu] = useState<{ conn: ConnectionView; x: number; y: number } | null>(
    null
  );
  const [newGroupName, setNewGroupName] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(storedSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"
  );

  // Session-side password cache; with Save password the OS keychain also
  // holds a copy. connections.json never contains secrets either way.
  const passwords = useRef(new Map<string, string>());
  const sqlEditorRef = useRef<HTMLTextAreaElement | null>(null);
  // Cursor position to restore after the next sql commit (double-click insert).
  const pendingCursor = useRef<number | null>(null);

  const refreshConnections = useCallback(async () => {
    setConnections(await backend.listConnections());
  }, []);

  const refreshGroups = useCallback(async () => {
    setPersistedGroups(await backend.listGroups());
  }, []);

  useEffect(() => {
    refreshConnections().catch((error) => setStatus(errorMessage(error)));
    refreshGroups().catch((error) => setStatus(errorMessage(error)));
  }, [refreshConnections, refreshGroups]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeConnId = activeTab?.connId ?? null;
  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;
  const activeSql = activeTab?.sql ?? "";

  const existingGroups = [
    ...new Set([...persistedGroups, ...connections.map((c) => c.group).filter((g): g is string => Boolean(g))]),
  ].sort((a, b) => a.localeCompare(b));

  const createGroup = useCallback(
    async (name: string) => {
      try {
        await backend.createGroup(name);
        await refreshGroups();
        setStatus(`Created group "${name}"`);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [refreshGroups]
  );

  const tabViews = tabs.map((tab) => {
    const conn = connections.find((c) => c.id === tab.connId);
    return {
      id: tab.id,
      name: conn?.name ?? "…",
      kind: conn?.kind ?? "mysql",
      connected: conn?.connected ?? false,
    };
  });

  const ensureTab = useCallback(
    (connId: string) => {
      const activeTabNow = tabs.find((t) => t.id === activeTabId);
      if (activeTabNow && activeTabNow.connId === connId) return;
      const existing = tabs.find((t) => t.connId === connId);
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const tab = emptyTab(connId);
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    },
    [activeTabId, tabs]
  );

  const openNewTab = useCallback((connId: string) => {
    const tab = emptyTab(connId);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);

  const selectTab = useCallback((tabId: string) => setActiveTabId(tabId), []);

  const closeTab = useCallback(
    (tabId: string) => {
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index < 0) return;
      const remaining = tabs.filter((t) => t.id !== tabId);
      setTabs(remaining);
      if (activeTabId === tabId) {
        setActiveTabId(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
      }
    },
    [activeTabId, tabs]
  );

  const removeConnTabs = useCallback(
    (connId: string) => {
      const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
      const remaining = tabs.filter((t) => t.connId !== connId);
      setTabs(remaining);
      if (activeIndex >= 0 && tabs[activeIndex].connId === connId) {
        setActiveTabId(remaining[Math.min(activeIndex, remaining.length - 1)]?.id ?? null);
      }
    },
    [activeTabId, tabs]
  );

  const changeSql = useCallback(
    (next: string) => {
      setTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, sql: next } : t)));
    },
    [activeTabId]
  );

  const loadConnectionChildren = useCallback(async (conn: ConnectionView) => {
    if (conn.database) {
      const items = await backend.listTables(conn.id, conn.database);
      setChildren((prev) => ({ ...prev, [conn.id]: { kind: "tables", items } }));
    } else {
      const items = await backend.listSchemas(conn.id);
      setChildren((prev) => ({ ...prev, [conn.id]: { kind: "schemas", items } }));
    }
  }, []);

  const expandKey = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });

  const collapseKey = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const toggleConnection = useCallback(
    async (conn: ConnectionView) => {
      if (!conn.connected) {
        setDialog({ mode: "connect", conn });
        return;
      }
      ensureTab(conn.id);
      if (expanded.has(conn.id)) {
        collapseKey(conn.id);
        return;
      }
      expandKey(conn.id);
      try {
        await loadConnectionChildren(conn);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [ensureTab, expanded, loadConnectionChildren]
  );

  const toggleSchema = useCallback(
    async (connId: string, schema: string) => {
      const key = `${connId}::${schema}`;
      if (expanded.has(key)) {
        collapseKey(key);
        return;
      }
      expandKey(key);
      try {
        const items = await backend.listTables(connId, schema);
        setChildren((prev) => ({ ...prev, [key]: { kind: "tables", items } }));
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [expanded]
  );

  const tableKey = (connId: string, table: TableInfo) => `${connId}::${table.schema}::${table.name}`;

  const toggleTable = useCallback(
    async (conn: ConnectionView, table: TableInfo) => {
      const key = tableKey(conn.id, table);
      if (expanded.has(key)) {
        collapseKey(key);
        return;
      }
      expandKey(key);
      try {
        const fetched = await backend.describeTable(conn.id, table.schema, table.name);
        setDetails((prev) => ({ ...prev, [key]: fetched }));
        setStatus(
          `${table.name}: ${fetched.columns.length} columns, ${fetched.indexes.length} indexes, ` +
            `${fetched.foreignKeys.length} foreign keys, ${fetched.uniqueKeys.length} unique keys`
        );
      } catch (error) {
        collapseKey(key);
        setStatus(errorMessage(error));
      }
    },
    [expanded]
  );

  const selectTable = useCallback(
    (conn: ConnectionView, _database: string, table: TableInfo) => {
      ensureTab(conn.id);
      setStatus(`${table.name} — click again to show columns, or double-click to insert a SELECT`);
    },
    [ensureTab]
  );

  const openTable = useCallback(
    (conn: ConnectionView, database: string, table: TableInfo) => {
      const snippet = selectSnippet(conn.kind, database, table);
      const el = sqlEditorRef.current;
      const activeTabNow = tabs.find((t) => t.id === activeTabId);
      // Prefer the active tab when it belongs to this connection; otherwise
      // fall back to the connection's first tab (creating one if needed).
      const target =
        activeTabNow && activeTabNow.connId === conn.id
          ? activeTabNow
          : tabs.find((t) => t.connId === conn.id);
      const activeTarget = target && target.id === activeTabId ? target : null;

      let nextSql: string;
      let cursor: number;
      if (activeTarget && el) {
        const before = el.value.slice(0, el.selectionStart);
        const after = el.value.slice(el.selectionEnd);
        // Keep the snippet from gluing onto surrounding words or `;`.
        const lead = before.length > 0 && !/[\s;]$/.test(before) ? "\n" : "";
        const trail = after.length > 0 && !/^\s/.test(after) ? "\n" : "";
        nextSql = before + lead + snippet + trail + after;
        cursor = before.length + lead.length + snippet.length;
      } else {
        const base = target?.sql ?? "";
        const lead = base.length > 0 && !/[\s;]$/.test(base) ? "\n" : "";
        nextSql = base + lead + snippet;
        cursor = nextSql.length;
      }

      if (target) {
        setTabs((prev) =>
          prev.map((t) => (t.id === target.id ? { ...t, sql: nextSql, outcome: null, error: null } : t))
        );
        setActiveTabId(target.id);
      } else {
        const tab = emptyTab(conn.id, nextSql);
        setTabs((prev) => [...prev, tab]);
        setActiveTabId(tab.id);
      }
      pendingCursor.current = cursor;
      setStatus(`Inserted SELECT for ${table.name}`);
    },
    [activeTabId, tabs]
  );

  useEffect(() => {
    if (pendingCursor.current === null) return;
    const position = pendingCursor.current;
    pendingCursor.current = null;
    const el = sqlEditorRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(position, position);
    }
  }, [activeSql]);

  const handleDialogSubmit = useCallback(
    async (spec: ConnectionSpec, password: string) => {
      const wantsNewTab = dialog?.mode === "connect" && dialog.newTab === true;
      setDialog(null);
      try {
        // Always upsert: connect mode can flip the savePassword flag.
        await backend.saveConnection(spec);
        await backend.connect(spec.id, password);
        passwords.current.set(spec.id, password);
        await refreshConnections();
        const connected: ConnectionView = { ...spec, connected: true };
        if (wantsNewTab) {
          openNewTab(spec.id);
        } else {
          ensureTab(spec.id);
        }
        expandKey(spec.id);
        await loadConnectionChildren(connected);
        setStatus(`Connected to ${spec.name}`);
      } catch (error) {
        await refreshConnections();
        setStatus(errorMessage(error));
      }
    },
    [dialog, ensureTab, loadConnectionChildren, openNewTab, refreshConnections]
  );

  const forgetConnTreeData = (connId: string) => {
    setChildren((prev) => {
      const next = { ...prev };
      delete next[connId];
      return next;
    });
    setDetails((prev) => {
      const next: Record<string, TableDetails> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (!key.startsWith(`${connId}::`)) next[key] = value;
      }
      return next;
    });
    collapseKey(connId);
  };

  const disconnect = useCallback(
    async (conn: ConnectionView) => {
      try {
        await backend.disconnect(conn.id);
        forgetConnTreeData(conn.id);
        removeConnTabs(conn.id);
        await refreshConnections();
        setStatus(`Disconnected from ${conn.name}`);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [refreshConnections, removeConnTabs]
  );

  const deleteConnection = useCallback(
    async (conn: ConnectionView) => {
      try {
        await backend.deleteConnection(conn.id);
        passwords.current.delete(conn.id);
        forgetConnTreeData(conn.id);
        removeConnTabs(conn.id);
        await refreshConnections();
        setStatus(`Deleted ${conn.name}`);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [refreshConnections, removeConnTabs]
  );

  const moveConnection = useCallback(
    async (conn: ConnectionView, group: string | null) => {
      const { connected: _connected, ...spec } = conn;
      try {
        await backend.saveConnection({ ...spec, group: group ?? undefined });
        await refreshConnections();
        setStatus(group ? `Moved ${conn.name} to group "${group}"` : `Removed ${conn.name} from its group`);
      } catch (error) {
        setStatus(errorMessage(error));
      }
    },
    [refreshConnections]
  );

  const openSqlFile = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    const path = await backend.openSqlPath();
    if (!path) return;
    try {
      const contents = await backend.readSqlFile(path);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id ? { ...t, sql: contents, outcome: null, error: null, filePath: path } : t
        )
      );
      const name = path.split("/").pop() ?? path;
      setStatus(`Opened ${name}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [activeTabId, tabs]);

  const saveSqlFile = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    let path = tab.filePath;
    if (!path) {
      path = await backend.saveSqlPath("query.sql");
      if (!path) return;
    }
    try {
      await backend.writeSqlFile(path, tab.sql);
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, filePath: path! } : t)));
      setStatus(`Saved ${path.split("/").pop() ?? path}`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [activeTabId, tabs]);

  const run = useCallback(async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab || tab.running || !tab.sql.trim()) return;
    // With a selection in the editor, execute only the highlighted SQL.
    const el = sqlEditorRef.current;
    const selected =
      el && el.selectionStart !== el.selectionEnd
        ? el.value.slice(el.selectionStart, el.selectionEnd)
        : "";
    const targetSql = selected.trim() ? selected : tab.sql;
    const patch = (part: Partial<QueryTab>) =>
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, ...part } : t)));
    patch({ running: true, error: null, outcome: null });
    try {
      const result = await backend.runQuery(tab.connId, targetSql);
      patch({ outcome: result });
      setStatus(
        result.columns.length > 0
          ? `${result.rowCount} rows in ${result.elapsedMs} ms`
          : `${result.affectedRows} row(s) affected in ${result.elapsedMs} ms`
      );
    } catch (error) {
      const message = errorMessage(error);
      patch({ error: message });
      setStatus(message);
      await refreshConnections();
    } finally {
      patch({ running: false });
    }
  }, [activeTabId, refreshConnections, tabs]);

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sidebar = event.currentTarget.previousElementSibling as HTMLElement | null;
    if (!sidebar) return;
    const startX = event.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    const onMove = (move: PointerEvent) => {
      const max = Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth * 0.5);
      const width = Math.min(Math.max(startWidth + move.clientX - startX, SIDEBAR_MIN_WIDTH), max);
      setSidebarWidth(width);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setSidebarWidth((width) => {
        if (width === null) localStorage.removeItem(SIDEBAR_WIDTH_KEY);
        else localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
        return width;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetSidebarWidth = () => {
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    setSidebarWidth(null);
  };

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((collapsed) => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "0" : "1");
      return !collapsed;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F5") {
        event.preventDefault();
        void run();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "s") {
        event.preventDefault();
        void saveSqlFile();
      } else if (event.key === "o") {
        event.preventDefault();
        void openSqlFile();
      } else if (event.key === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run, saveSqlFile, openSqlFile, toggleSidebar]);

  useEffect(() => {
    if (!contextMenu && !groupMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setGroupMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contextMenu, groupMenu]);

  const openConnectionMenu = useCallback((conn: ConnectionView, x: number, y: number) => {
    setContextMenu({
      conn,
      x: Math.min(x, window.innerWidth - 190),
      y: Math.min(y, window.innerHeight - 150),
    });
  }, []);

  const menuNewTab = (conn: ConnectionView) => {
    setContextMenu(null);
    if (conn.connected) {
      openNewTab(conn.id);
    } else {
      setDialog({ mode: "connect", conn, newTab: true });
    }
  };

  return (
    <div className="app">
      <div className="body">
        {sidebarCollapsed ? (
          <div className="sidebar-rail">
            <button
              className="icon-button"
              onClick={toggleSidebar}
              title="Show sidebar (⌘B)"
              aria-label="Show sidebar"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path
                  d="M5 4.5L8.5 8 5 11.5M9.5 4.5L13 8l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <ConnectionsSidebar
              connections={connections}
              groups={existingGroups}
              children={children}
              details={details}
              expanded={expanded}
              activeConnId={activeConnId}
              style={sidebarWidth !== null ? { width: sidebarWidth } : undefined}
              onHide={toggleSidebar}
              onNewConnection={() => setDialog({ mode: "new" })}
              onCreateGroup={(name) => void createGroup(name)}
              onToggleConnection={toggleConnection}
              onToggleSchema={toggleSchema}
              onToggleTable={toggleTable}
              onSelectTable={selectTable}
              onOpenTable={openTable}
              onConnectionContextMenu={openConnectionMenu}
              onDisconnect={disconnect}
              onDelete={deleteConnection}
              onMoveConnection={(conn, group) => void moveConnection(conn, group)}
            />
            <div
              className="sidebar-resize-handle"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize · double-click to reset"
              onPointerDown={startSidebarResize}
              onDoubleClick={resetSidebarWidth}
            />
          </>
        )}
        <QueryPanel
          tabs={tabViews}
          activeTabId={activeTabId}
          activeConn={activeConn}
          sql={activeSql}
          running={activeTab?.running ?? false}
          outcome={activeTab?.outcome ?? null}
          error={activeTab?.error ?? null}
          textareaRef={sqlEditorRef}
          onSelectTab={selectTab}
          onCloseTab={closeTab}
          onSqlChange={changeSql}
          onRun={run}
          onOpenFile={() => void openSqlFile()}
          onSaveFile={() => void saveSqlFile()}
        />
      </div>
      <footer className="statusbar">
        <span className="status-message">{status}</span>
        <span className="status-right">
          {activeConn ? `${activeConn.host}:${activeConn.port}` : "not connected"}
        </span>
      </footer>
      {dialog && (
        <ConnectionDialog
          mode={dialog.mode}
          existing={dialog.mode === "connect" ? dialog.conn : undefined}
          groups={existingGroups}
          onSubmit={handleDialogSubmit}
          onClose={() => setDialog(null)}
        />
      )}
      {contextMenu && (
        <>
          <div
            className="context-overlay"
            onClick={() => setContextMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          />
          <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button onClick={() => menuNewTab(contextMenu.conn)}>New Query Tab</button>
            {contextMenu.conn.connected ? (
              <button
                onClick={() => {
                  const conn = contextMenu.conn;
                  setContextMenu(null);
                  void disconnect(conn);
                }}
              >
                Disconnect
              </button>
            ) : (
              <button
                onClick={() => {
                  const conn = contextMenu.conn;
                  setContextMenu(null);
                  setDialog({ mode: "connect", conn });
                }}
              >
                Connect…
              </button>
            )}
            <button
              onClick={() => {
                const { conn, x, y } = contextMenu;
                setContextMenu(null);
                setNewGroupName("");
                setGroupMenu({ conn, x, y });
              }}
            >
              Move to Group…
            </button>
            {contextMenu.conn.group && (
              <button
                onClick={() => {
                  const conn = contextMenu.conn;
                  setContextMenu(null);
                  void moveConnection(conn, null);
                }}
              >
                Remove from Group
              </button>
            )}
          </div>
        </>
      )}
      {groupMenu && (
        <>
          <div
            className="context-overlay"
            onClick={() => setGroupMenu(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setGroupMenu(null);
            }}
          />
          <div className="context-menu" style={{ left: groupMenu.x, top: groupMenu.y }}>
            <form
              className="group-new"
              onSubmit={(event) => {
                event.preventDefault();
                const name = newGroupName.trim();
                const conn = groupMenu.conn;
                if (!name) return;
                setGroupMenu(null);
                void moveConnection(conn, name);
              }}
            >
              <input
                autoFocus
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="New group name"
                aria-label="New group name"
              />
            </form>
            {existingGroups.map((group) => (
              <button
                key={group}
                disabled={group === groupMenu.conn.group}
                onClick={() => {
                  const conn = groupMenu.conn;
                  setGroupMenu(null);
                  void moveConnection(conn, group);
                }}
              >
                {group}
                {group === groupMenu.conn.group ? " ✓" : ""}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
