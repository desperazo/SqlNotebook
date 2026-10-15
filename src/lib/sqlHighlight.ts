export type SqlTokenType =
  | "keyword"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "quoted"
  | "function"
  | "variable"
  | "plain";

export type SqlToken = { type: SqlTokenType; text: string };

const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL", "ON", "AS",
  "AND", "OR", "XOR", "NOT", "NULL", "IS", "IN", "BETWEEN", "LIKE", "REGEXP",
  "RLIKE", "EXISTS", "ANY", "SOME", "GROUP", "BY", "ORDER", "HAVING", "LIMIT",
  "OFFSET", "FETCH", "FIRST", "NEXT", "ONLY", "UNION", "ALL", "DISTINCT", "CREATE",
  "TABLE", "DATABASE", "SCHEMA", "INDEX", "VIEW", "DROP", "ALTER", "ADD", "COLUMN",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "CONSTRAINT", "UNIQUE", "DEFAULT",
  "CHECK", "AUTO_INCREMENT", "IDENTITY", "CASE", "WHEN", "THEN", "ELSE", "END",
  "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "WITH", "RECURSIVE", "TOP", "USE",
  "GO", "ASC", "DESC", "SHOW", "DESCRIBE", "EXPLAIN", "TRUNCATE", "GRANT", "REVOKE",
  "OVER", "PARTITION", "WINDOW", "ROWS", "RANGE", "RETURNING", "OUTPUT", "DECLARE",
  "EXEC", "EXECUTE", "PROCEDURE", "FUNCTION", "TRIGGER", "IF", "ELSEIF", "WHILE",
  "LOCK", "UNLOCK", "FOR", "FORCE", "USING", "SEPARATOR", "COLLATE", "ESCAPE",
  "INTERVAL", "MERGE", "MATCHED", "PIVOT", "UNPIVOT", "TEMPORARY", "TEMP", "IGNORE",
]);

const TYPES = new Set([
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "MEDIUMINT", "VARCHAR",
  "NVARCHAR", "CHAR", "NCHAR", "TEXT", "TINYTEXT", "MEDIUMTEXT", "LONGTEXT",
  "NTEXT", "DATE", "DATETIME", "DATETIME2", "SMALLDATETIME", "TIMESTAMP", "TIME",
  "YEAR", "DECIMAL", "NUMERIC", "FLOAT", "REAL", "DOUBLE", "PRECISION", "BOOLEAN",
  "BOOL", "BIT", "BLOB", "LONGBLOB", "MEDIUMBLOB", "TINYBLOB", "VARBINARY",
  "BINARY", "JSON", "UUID", "XML", "MONEY", "UNIQUEIDENTIFIER", "SERIAL", "ENUM",
]);

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;

/// Single-pass SQL tokenizer for the editor's highlight layer. Handles the
/// dialect mix this app targets: MySQL (`--`, `#`, backticks, backslash
/// escapes) and T-SQL (`[brackets]`, `@variables`, `N'...'` strings).
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const push = (type: SqlTokenType, text: string) => tokens.push({ type, text });
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (WHITESPACE.test(ch)) {
      let j = i + 1;
      while (j < sql.length && WHITESPACE.test(sql[j])) j++;
      push("plain", sql.slice(i, j));
      i = j;
      continue;
    }

    // Line comments: `-- ...` (both dialects) and `# ...` (MySQL).
    if ((ch === "-" && sql[i + 1] === "-") || ch === "#") {
      let j = sql.indexOf("\n", i);
      if (j === -1) j = sql.length;
      push("comment", sql.slice(i, j));
      i = j;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      let j = sql.indexOf("*/", i + 2);
      j = j === -1 ? sql.length : j + 2;
      push("comment", sql.slice(i, j));
      i = j;
      continue;
    }

    // String literal; `''` and `\x` escape. Also covers the T-SQL `N'...'`
    // prefix when reached as `N` below falls into the word branch — `N` alone
    // is not a keyword, and the quote after it starts a fresh string token.
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push("string", sql.slice(i, Math.min(j, sql.length)));
      i = Math.min(j, sql.length);
      continue;
    }

    // Quoted identifiers: "ANSI", `MySQL`, [T-SQL] (with doubled escapes).
    if (ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push("quoted", sql.slice(i, Math.min(j, sql.length)));
      i = Math.min(j, sql.length);
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "]") {
          if (sql[j + 1] === "]") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push("quoted", sql.slice(i, Math.min(j, sql.length)));
      i = Math.min(j, sql.length);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const match = /^(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)/.exec(sql.slice(i));
      const text = match ? match[0] : ch;
      push("number", text);
      i += text.length;
      continue;
    }

    if (ch === "@") {
      const match = /^@{1,2}[A-Za-z0-9_$]*/.exec(sql.slice(i));
      const text = match ? match[0] : ch;
      push("variable", text);
      i += text.length;
      continue;
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < sql.length && WORD_PART.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      let type: SqlTokenType = "plain";
      if (KEYWORDS.has(upper)) {
        type = "keyword";
      } else if (TYPES.has(upper)) {
        type = "type";
      } else {
        let k = j;
        while (k < sql.length && WHITESPACE.test(sql[k])) k++;
        if (sql[k] === "(") type = "function";
      }
      push(type, word);
      i = j;
      continue;
    }

    push("plain", ch);
    i++;
  }

  return tokens;
}
