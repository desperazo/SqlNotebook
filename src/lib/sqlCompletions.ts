import { quoteIdent, type ColumnMeta, type EngineKind, type TableInfo } from "./backend";

export type SuggestItem = {
  label: string;
  insert: string;
  kind: "keyword" | "table" | "column";
  detail?: string;
};

export type SuggestSource = {
  kind: EngineKind;
  tables: TableInfo[];
  columnMeta: (schema: string, table: string) => ColumnMeta[] | undefined;
  /** Ctrl+Space with an empty word still opens the full list. */
  allowEmptyToken?: boolean;
};

export type SuggestContext = {
  from: number;
  to: number;
  items: SuggestItem[];
  /** Tables whose columns the context wants; callers fetch and cache metadata. */
  wantedTables: TableInfo[];
};

const CORE_KEYWORDS =
  "SELECT FROM WHERE AND OR NOT NULL IS IN BETWEEN LIKE EXISTS INSERT INTO VALUES UPDATE SET DELETE " +
  "JOIN INNER LEFT RIGHT FULL OUTER ON GROUP BY HAVING ORDER ASC DESC UNION ALL DISTINCT AS CASE WHEN " +
  "THEN ELSE END CREATE TABLE VIEW INDEX DROP ALTER ADD CONSTRAINT PRIMARY FOREIGN REFERENCES DEFAULT " +
  "UNIQUE CHECK TRUNCATE COMMIT ROLLBACK TRANSACTION BEGIN IF USE COUNT SUM AVG MIN MAX CAST CONVERT " +
  "DECLARE EXEC RETURN TOP CROSS";
const MYSQL_EXTRA = [
  "LIMIT", "OFFSET", "AUTO_INCREMENT", "SHOW", "DATABASES", "TABLES", "DESCRIBE", "EXPLAIN",
  "REGEXP", "COALESCE", "IFNULL", "NOW", "DATE_FORMAT", "CONCAT", "SUBSTRING", "LOWER", "UPPER", "TRIM",
];
const MSSQL_EXTRA = [
  "IDENTITY", "NVARCHAR", "VARCHAR", "DATETIME2", "GETDATE", "GETUTCDATE", "ROW_NUMBER", "RANK",
  "OVER", "PARTITION", "MERGE", "OUTPUT", "APPLY", "PIVOT", "UNPIVOT", "COALESCE", "ISNULL",
  "LEN", "SUBSTRING", "LOWER", "UPPER", "LTRIM", "RTRIM",
];

export function keywordsFor(kind: EngineKind): string[] {
  const base = CORE_KEYWORDS.split(" ");
  return (kind === "mssql" ? [...base, ...MSSQL_EXTRA] : [...base, ...MYSQL_EXTRA]).sort();
}

/** Words that follow a table name in SQL but are not aliases. */
const ALIAS_STOPWORDS = new Set([
  "WHERE", "GROUP", "ORDER", "ON", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "JOIN",
  "SET", "VALUES", "AS", "UNION", "LIMIT", "TOP", "WITH", "CROSS", "OFFSET",
]);

/* Includes dots so `table.` / `alias.` reaches the column branch. */
const TOKEN_RE = /[A-Za-z0-9_$.]*$/;

/** Clause keywords that put the caret in a column position; FROM/JOIN stay table contexts. */
const COLUMN_CLAUSES = new Set([
  "SELECT", "WHERE", "AND", "OR", "ON", "HAVING", "ORDER", "GROUP", "BY", "SET",
]);

/** Uppercase last clause keyword before the caret, or null when none yet. */
export function lastClause(sql: string): string | null {
  const re = /\b(select|from|join|where|and|or|on|having|order|group|by|set)\b/gi;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) last = match[1].toUpperCase();
  return last;
}

/** Tables referenced by FROM/JOIN clauses in `sql`, in order of first appearance. */
export function referencedTables(sql: string, tables: TableInfo[]): TableInfo[] {
  const out: TableInfo[] = [];
  const seen = new Set<string>();
  const re = /(?:\bfrom\b|\bjoin\b)\s+([\w$]+(?:\s*\.\s*[\w$]+)*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) {
    const leaf = (cleanIdent(match[1]).split(".").pop() ?? "").toLowerCase();
    const table = tables.find((t) => t.name.toLowerCase() === leaf);
    if (table && !seen.has(leaf)) {
      seen.add(leaf);
      out.push(table);
    }
  }
  return out;
}

const cleanIdent = (name: string) => name.replace(/[`"\[\]]/g, "");

const safeIdent = (kind: EngineKind, name: string): string =>
  /^[\w$]+$/.test(name) ? name : quoteIdent(kind, name);

function tableInsert(kind: EngineKind, table: TableInfo): string {
  if (kind === "mssql") {
    return `${safeIdent("mssql", table.schema)}.${safeIdent("mssql", table.name)}`;
  }
  return safeIdent("mysql", table.name);
}

/** Maps the identifier before a dot to a table, either directly
 *  (`users.`, `dbo.users.`) or through a FROM/JOIN alias (`o.` for `FROM orders o`). */
export function resolveQualifier(
  before: string,
  qualifier: string,
  tables: TableInfo[]
): TableInfo | null {
  const cleaned = cleanIdent(qualifier).toLowerCase();
  if (!cleaned) return null;
  const leaf = cleaned.split(".").pop() ?? "";
  const direct = tables.find(
    (t) => t.name.toLowerCase() === leaf || `${t.schema}.${t.name}`.toLowerCase() === cleaned
  );
  if (direct) return direct;

  const aliasRe =
    /(?:\bfrom\b|\bjoin\b)\s+([\w$]+(?:\s*\.\s*[\w$]+)*)\s+(?:as\s+)?([A-Za-z_][\w$]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = aliasRe.exec(before))) {
    if (ALIAS_STOPWORDS.has(match[2].toUpperCase())) continue;
    if (match[2].toLowerCase() !== leaf) continue;
    const name = cleanIdent(match[1]).split(".").pop() ?? "";
    return tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  return null;
}

export function computeSuggestContext(
  value: string,
  caret: number,
  source: SuggestSource
): SuggestContext | null {
  const before = value.slice(0, caret);
  // After a `;` the statement is done; stay quiet until a new line begins.
  const lastSemi = before.lastIndexOf(";");
  if (lastSemi >= 0 && !/[\r\n]/.test(before.slice(lastSemi))) return null;
  // A bare newline (Enter) is formatting, not a request; wait for typed input.
  if (!source.allowEmptyToken && /[\r\n]$/.test(before)) return null;
  const token = TOKEN_RE.exec(before)?.[0] ?? "";
  const clause = lastClause(before);
  const wantsColumns = clause !== null && COLUMN_CLAUSES.has(clause);
  // Column positions (e.g. right after `WHERE `) open on an empty token too.
  if (!token && !source.allowEmptyToken && !wantsColumns) return null;
  const from = caret - token.length;

  const dotIndex = token.lastIndexOf(".");
  if (dotIndex >= 0) {
    const table = resolveQualifier(before, token.slice(0, dotIndex), source.tables);
    if (!table) return null;
    const word = token.slice(dotIndex + 1).toLowerCase();
    const metas = source.columnMeta(table.schema, table.name) ?? [];
    const items = metas
      .filter((c) => c.name.toLowerCase().startsWith(word))
      .slice(0, 50)
      .map((c) => ({
        label: c.name,
        insert: safeIdent(source.kind, c.name),
        kind: "column" as const,
        detail: c.dataType,
      }));
    return {
      // Accepting a member replaces only the name after the dot, keeping `o.`.
      from: caret - (token.length - dotIndex - 1),
      to: caret,
      items,
      wantedTables: [table],
    };
  }

  const word = token.toLowerCase();
  if (wantsColumns) {
    // Column position: offer the columns of every table named in FROM/JOIN.
    const refs = referencedTables(before, source.tables);
    const items: SuggestItem[] = [];
    const seen = new Set<string>();
    for (const t of refs) {
      for (const c of source.columnMeta(t.schema, t.name) ?? []) {
        const key = c.name.toLowerCase();
        if (!key.startsWith(word) || seen.has(key)) continue;
        seen.add(key);
        items.push({
          label: c.name,
          insert: safeIdent(source.kind, c.name),
          kind: "column" as const,
          detail: refs.length > 1 ? `${t.name} · ${c.dataType}` : c.dataType,
        });
      }
    }
    for (const kw of keywordsFor(source.kind)) {
      if (kw.toLowerCase().startsWith(word)) {
        items.push({ label: kw, insert: kw, kind: "keyword" });
      }
    }
    return { from, to: caret, items: items.slice(0, 50), wantedTables: refs };
  }

  const items: SuggestItem[] = [];
  for (const t of source.tables) {
    const label = source.kind === "mssql" ? `${t.schema}.${t.name}` : t.name;
    if (label.toLowerCase().startsWith(word) || t.name.toLowerCase().startsWith(word)) {
      items.push({
        label,
        insert: tableInsert(source.kind, t),
        kind: "table",
        detail: t.kind === "VIEW" ? "view" : "table",
      });
    }
  }
  for (const kw of keywordsFor(source.kind)) {
    if (kw.toLowerCase().startsWith(word)) {
      items.push({ label: kw, insert: kw, kind: "keyword" });
    }
  }
  return { from, to: caret, items: items.slice(0, 50), wantedTables: [] };
}

/** Caret pixel position in viewport coordinates, via a mirror element with
 *  identical typography (the textarea uses a monospace font). */
export function caretViewportPosition(
  textarea: HTMLTextAreaElement,
  caret: number
): { top: number; left: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const prop of [
    "fontFamily", "fontSize", "fontStyle", "fontWeight", "letterSpacing", "tabSize",
    "textIndent", "boxSizing", "lineHeight", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth",
  ] as const) {
    mirror.style[prop] = style[prop];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop;
  const left = marker.offsetLeft;
  document.body.removeChild(mirror);

  const rect = textarea.getBoundingClientRect();
  return {
    top: rect.top + top - textarea.scrollTop,
    left: rect.left + left - textarea.scrollLeft,
  };
}
