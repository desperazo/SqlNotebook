import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  backend,
  engineLabel,
  type ColumnMeta,
  type ConnectionView,
  type EngineKind,
  type QueryOutcome,
  type TableInfo,
} from "../lib/backend";
import { tokenizeSql, type SqlToken } from "../lib/sqlHighlight";
import {
  caretViewportPosition,
  computeSuggestContext,
  type SuggestItem,
} from "../lib/sqlCompletions";

export type QueryTabView = {
  id: string;
  name: string;
  kind: EngineKind;
  connected: boolean;
};

type Props = {
  tabs: QueryTabView[];
  activeTabId: string | null;
  activeConn: ConnectionView | null;
  sql: string;
  running: boolean;
  outcome: QueryOutcome | null;
  error: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSqlChange: (sql: string) => void;
  onRun: () => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
};

type SuggestState = {
  from: number;
  to: number;
  items: SuggestItem[];
  selected: number;
  top: number;
  left: number;
  /** Caret the items were computed at; scroll events re-anchor the popup to it. */
  caret: number;
};

const EDITOR_HEIGHT_KEY = "sqlnotebook.editorHeight";
const EDITOR_MIN_HEIGHT = 90;
/// Vertical space always left for the results pane while resizing.
const RESULTS_MIN_HEIGHT = 110;

const storedEditorHeight = (): number | null => {
  const value = Number(localStorage.getItem(EDITOR_HEIGHT_KEY));
  return Number.isFinite(value) && value >= EDITOR_MIN_HEIGHT ? value : null;
};

/// Viewport coordinates for the popup under the caret, flipping above the
/// line when there is not enough room below.
const popupPosition = (
  el: HTMLTextAreaElement,
  caret: number,
  itemCount: number
): { top: number; left: number } => {
  const pos = caretViewportPosition(el, caret);
  const estimated = Math.min(itemCount, 10) * 21 + 10;
  let top = pos.top + 20;
  if (top + estimated > window.innerHeight) {
    top = Math.max(4, pos.top - estimated - 6);
  }
  return { top, left: pos.left };
};

/// Colored copy of the editor text rendered behind the textarea, whose own
/// text is transparent. Plain tokens render as bare text so the layer stays
/// light; a trailing newline keeps the last line's height aligned.
function SqlHighlightLayer({
  sql,
  layerRef,
}: {
  sql: string;
  layerRef: RefObject<HTMLPreElement | null>;
}) {
  const tokens = useMemo(() => tokenizeSql(sql), [sql]);
  return (
    <pre className="sql-highlight" aria-hidden="true" ref={layerRef}>
      {tokens.map((token: SqlToken, index: number) =>
        token.type === "plain" ? (
          token.text
        ) : (
          <span key={index} className={`tok-${token.type}`}>
            {token.text}
          </span>
        )
      )}
      {"\n"}
    </pre>
  );
}

export default function QueryPanel({
  tabs,
  activeTabId,
  activeConn,
  sql,
  running,
  outcome,
  error,
  textareaRef,
  onSelectTab,
  onCloseTab,
  onSqlChange,
  onRun,
  onOpenFile,
  onSaveFile,
}: Props) {
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [resultsOpen, setResultsOpen] = useState(true);
  // Explicit editor height in px; null defers to the CSS default (34%).
  const [editorHeight, setEditorHeight] = useState<number | null>(storedEditorHeight);
  const editorStackRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  // Per-connection schema metadata, fetched on demand for completions.
  const tablesCache = useRef(new Map<string, TableInfo[]>());
  const columnsCache = useRef(new Map<string, ColumnMeta[]>());
  const pendingColumns = useRef(new Set<string>());
  const recomputeRef = useRef<(value: string, caret: number, force: boolean) => void>(() => {});

  // The highlight layer sits under the textarea, so it must mirror scrolling.
  const syncHighlightScroll = () => {
    const el = textareaRef.current;
    const layer = highlightRef.current;
    if (el && layer) {
      layer.scrollTop = el.scrollTop;
      layer.scrollLeft = el.scrollLeft;
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = editorStackRef.current?.offsetHeight ?? 0;
    const container = editorStackRef.current?.parentElement;
    const maxHeight = () => Math.max((container?.clientHeight ?? 0) - RESULTS_MIN_HEIGHT, EDITOR_MIN_HEIGHT);
    const onMove = (move: PointerEvent) => {
      const next = Math.min(Math.max(startHeight + (move.clientY - startY), EDITOR_MIN_HEIGHT), maxHeight());
      setEditorHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setEditorHeight((height) => {
        if (height !== null) localStorage.setItem(EDITOR_HEIGHT_KEY, String(Math.round(height)));
        return height;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const resetResize = () => {
    localStorage.removeItem(EDITOR_HEIGHT_KEY);
    setEditorHeight(null);
  };

  useEffect(() => {
    setSuggest(null);
  }, [activeTabId]);

  const ensureTables = (conn: ConnectionView) => {
    if (tablesCache.current.has(conn.id)) return;
    // Placeholder first so parallel calls do not refetch.
    tablesCache.current.set(conn.id, []);
    const el = textareaRef.current;
    const load = conn.database
      ? backend.listTables(conn.id, conn.database)
      : backend
          .listSchemas(conn.id)
          .then((names) => names.map((name) => ({ name, kind: "SCHEMA", schema: name })));
    load
      .then((items) => {
        tablesCache.current.set(conn.id, items);
        // The typing keystroke that triggered this ran before the list
        // existed; re-evaluate so the popup opens on that same token.
        if (el) recomputeRef.current(el.value, el.selectionStart, false);
      })
      .catch(() => tablesCache.current.delete(conn.id));
  };

  const ensureColumns = (conn: ConnectionView, table: TableInfo) => {
    const key = `${table.schema}.${table.name}`.toLowerCase();
    if (columnsCache.current.has(key) || pendingColumns.current.has(key)) return;
    pendingColumns.current.add(key);
    backend
      .describeTable(conn.id, table.schema, table.name)
      .then((details) => columnsCache.current.set(key, details.columns))
      .catch(() => {})
      .finally(() => {
        pendingColumns.current.delete(key);
        const el = textareaRef.current;
        if (el) recomputeRef.current(el.value, el.selectionStart, false);
      });
  };

  const recompute = (value: string, caret: number, force: boolean) => {
    const el = textareaRef.current;
    if (!activeConn || !el) {
      setSuggest(null);
      return;
    }
    ensureTables(activeConn);
    const context = computeSuggestContext(value, caret, {
      kind: activeConn.kind,
      tables: tablesCache.current.get(activeConn.id) ?? [],
      columnMeta: (schema, table) =>
        columnsCache.current.get(`${schema}.${table}`.toLowerCase()),
      allowEmptyToken: force,
    });
    if (context) {
      for (const table of context.wantedTables) ensureColumns(activeConn, table);
    }
    if (!context || context.items.length === 0) {
      setSuggest(null);
      return;
    }
    const { top, left } = popupPosition(el, caret, context.items.length);
    setSuggest({
      from: context.from,
      to: context.to,
      items: context.items,
      selected: 0,
      top,
      left,
      caret,
    });
  };
  recomputeRef.current = recompute;

  const acceptItem = (item: SuggestItem, state: SuggestState) => {
    const el = textareaRef.current;
    if (!el) return;
    onSqlChange(el.value.slice(0, state.from) + item.insert + el.value.slice(state.to));
    setSuggest(null);
    const caret = state.from + item.insert.length;
    requestAnimationFrame(() => el.setSelectionRange(caret, caret));
  };

  const editorKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSuggest((s) =>
          s ? { ...s, selected: (s.selected + 1) % s.items.length } : s
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSuggest((s) =>
          s ? { ...s, selected: (s.selected - 1 + s.items.length) % s.items.length } : s
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        acceptItem(suggest.items[suggest.selected], suggest);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggest(null);
        return;
      }
    } else if (event.ctrlKey && event.key === " ") {
      event.preventDefault();
      const el = event.currentTarget;
      recompute(el.value, el.selectionStart, true);
    }
  };

  return (
    <main className="editor">
      {tabs.length > 0 && (
        <div className="tabstrip" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={`tab${tab.id === activeTabId ? " tab-active" : ""}`}
              title={`${engineLabel(tab.kind)}${tab.connected ? "" : " (not connected)"}`}
              onClick={() => onSelectTab(tab.id)}
            >
              <span className={`status-dot${tab.connected ? " status-on" : ""}`} />
              <span className="tab-label">{tab.name}</span>
              <button
                className="tab-close"
                aria-label={`Close ${tab.name} tab`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="toolbar">
        <div className="toolbar-actions">
          <button
            className="button"
            onClick={onOpenFile}
            disabled={!activeTabId}
            title="Open a .sql file into this tab (⌘O)"
          >
            Open
          </button>
          <button
            className="button"
            onClick={onSaveFile}
            disabled={!activeTabId}
            title="Save this tab's SQL to a file (⌘S)"
          >
            Save
          </button>
          <button
            className={`button${resultsOpen ? "" : " button-secondary"}`}
            onClick={() => setResultsOpen((open) => !open)}
            title={resultsOpen ? "Hide the results pane" : "Show the results pane"}
          >
            Results
          </button>
          <button
            className="button run-button"
            onClick={onRun}
            disabled={!activeTabId || running}
            title="Run (F5) — executes the selected text, or the whole editor"
          >
            {running ? "Running…" : "Run"}
            <span className="kbd-hint">F5</span>
          </button>
        </div>
      </div>

      <div
        ref={editorStackRef}
        className={`sql-editor-stack${resultsOpen ? "" : " editor-full"}`}
        style={
          resultsOpen && editorHeight !== null
            ? { height: editorHeight, flex: "0 0 auto" }
            : undefined
        }
      >
        <SqlHighlightLayer sql={sql} layerRef={highlightRef} />
        <textarea
          ref={textareaRef}
          className="textarea sql-editor"
          value={sql}
          spellCheck={false}
          placeholder="SELECT * FROM …"
          onChange={(event) => {
            onSqlChange(event.target.value);
            recompute(event.target.value, event.target.selectionStart, false);
          }}
          onKeyDown={editorKeyDown}
          onBlur={() => setSuggest(null)}
          onScroll={() => {
            // The textarea scrolls to keep the caret visible on every
            // keystroke near the bottom; the popup follows the caret
            // instead of vanishing (Escape already closed it via state).
            const el = textareaRef.current;
            if (el) {
              setSuggest((s) => {
                if (!s) return s;
                const { top, left } = popupPosition(el, s.caret, s.items.length);
                return { ...s, top, left };
              });
            }
            syncHighlightScroll();
          }}
        />
      </div>

      {resultsOpen && (
        <div
          className="resize-handle"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={resetResize}
        />
      )}

      {suggest && (
        <div
          className="suggest-popup"
          style={{ top: suggest.top, left: suggest.left }}
          // Keep editor focus so typing continues to filter the list.
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggest.items.map((item, index) => (
            <div
              key={`${item.kind}-${item.label}-${index}`}
              className={`suggest-item${index === suggest.selected ? " suggest-selected" : ""}`}
              onClick={() => acceptItem(item, suggest)}
            >
              <span className="suggest-label">{item.label}</span>
              {item.detail && <span className="suggest-detail">{item.detail}</span>}
              <span className="suggest-kind">{item.kind}</span>
            </div>
          ))}
        </div>
      )}

      {resultsOpen && (
        <div className="results-pane">
          <button
            className="icon-button results-close"
            onClick={() => setResultsOpen(false)}
            title="Hide results"
            aria-label="Hide results"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
          {error && <div className="error-banner">{error}</div>}

          {!error && outcome && (
            <>
              <div className="results-meta">
                {outcome.columns.length > 0
                  ? `${outcome.rowCount} row${outcome.rowCount === 1 ? "" : "s"} in ${outcome.elapsedMs} ms${
                      outcome.truncated ? ` · showing first ${outcome.rows.length}` : ""
                    }`
                  : `OK, ${outcome.affectedRows} row(s) affected in ${outcome.elapsedMs} ms`}
              </div>
              {outcome.columns.length > 0 && (
                <div className="results">
                  <table>
                    <thead>
                      <tr>
                        {outcome.columns.map((column, i) => (
                          <th key={i}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {outcome.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((cell, c) => (
                            <td key={c}>{cell === null ? <span className="null">NULL</span> : cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {!error && !outcome && (
            <div className="results-empty">Run a query to see results here.</div>
          )}
        </div>
      )}
    </main>
  );
}
