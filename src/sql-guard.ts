/**
 * SQL 词法闸门：只读/写入语句分类与安全检查。
 *
 * - sql_query 只读：SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH，单语句
 * - sql_exec 只允许 INSERT/UPDATE；DELETE/DROP/DDL/事务等一律拒绝
 * - 所有守卫都是纯函数，便于单测
 */

export const READ_ONLY_LEADING_TOKENS = new Set([
	"SELECT", "PRAGMA", "EXPLAIN", "SHOW", "DESCRIBE", "WITH",
]);

export const WRITE_LEADING_TOKENS = new Set([
	"INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "DROP", "ALTER", "TRUNCATE",
	"VACUUM", "REINDEX", "ATTACH", "DETACH", "BEGIN", "COMMIT", "ROLLBACK",
	"SAVEPOINT", "RELEASE", "ANALYZE", "GRANT", "REVOKE", "MERGE", "CALL",
	"EXECUTE", "SET", "USE", "LOAD", "IMPORT", "COPY", "OPTIMIZE", "RENAME",
]);

export class SqlGuardError extends Error {
	constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SqlGuardError";
	}
}

/** Strip SQL comments (-- line, block) outside string literals. */
export function stripSqlComments(sql: string): string {
	let out = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;
	while (i < sql.length) {
		const ch = sql[i]!;
		const next = sql[i + 1];
		if (!inSingle && !inDouble) {
			if (ch === "-" && next === "-") {
				const end = sql.indexOf("\n", i);
				i = end === -1 ? sql.length : end;
				continue;
			}
			if (ch === "/" && next === "*") {
				const end = sql.indexOf("*/", i + 2);
				i = end === -1 ? sql.length : end + 2;
				continue;
			}
			if (ch === "'") inSingle = true;
			else if (ch === '"') inDouble = true;
		} else if (inSingle) {
			if (ch === "'") {
				if (next === "'") {
					out += "''";
					i += 2;
					continue;
				}
				inSingle = false;
			}
		} else if (inDouble && ch === '"') {
			inDouble = false;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/** Split a script into top-level statements, respecting literals and comments. */
export function splitStatements(sql: string): string[] {
	const parts: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i]!;
		const next = sql[i + 1];
		if (!inSingle && !inDouble) {
			if (ch === "-" && next === "-") {
				const end = sql.indexOf("\n", i);
				const stop = end === -1 ? sql.length : end;
				current += sql.slice(i, stop);
				i = stop;
				continue;
			}
			if (ch === "/" && next === "*") {
				const end = sql.indexOf("*/", i + 2);
				const stop = end === -1 ? sql.length : end + 2;
				current += sql.slice(i, stop);
				i = stop;
				continue;
			}
			if (ch === "'") { inSingle = true; current += ch; i += 1; continue; }
			if (ch === '"') { inDouble = true; current += ch; i += 1; continue; }
			if (ch === ";") { parts.push(current); current = ""; i += 1; continue; }
			current += ch;
			i += 1;
			continue;
		}
		if (inSingle) {
			if (ch === "'") {
				if (next === "'") { current += "''"; i += 2; continue; }
				inSingle = false;
			}
		} else if (inDouble && ch === '"') {
			inDouble = false;
		}
		current += ch;
		i += 1;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

export function leadingToken(statement: string): string {
	const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(statement);
	return match?.[1]?.toUpperCase() ?? "";
}

export function assertSingleStatement(statements: string[]): void {
	if (statements.length > 1) {
		throw new SqlGuardError(
			"DB_MULTI_STATEMENT_REJECTED",
			`sql_query accepts exactly one statement (got ${statements.length}); use sql_exec for INSERT/UPDATE batches`,
		);
	}
}

/** Allow only INSERT or UPDATE statements for sql_exec batches. */
export function assertWriteStatement(statement: string): "INSERT" | "UPDATE" {
	const bare = stripSqlComments(statement);
	const token = leadingToken(bare);
	if (token !== "INSERT" && token !== "UPDATE") {
		throw new SqlGuardError(
			"DB_READ_ONLY_VIOLATION",
			"sql_exec rejected: only INSERT and UPDATE are allowed (got " + (token || "nothing") + ")",
		);
	}
	if (/\b(?:DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|MERGE|GRANT|REVOKE|CALL|EXECUTE|COPY|LOAD|VACUUM|REINDEX|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|USE)\b/i.test(bare)) {
		throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_exec rejected: statement contains a forbidden mutation");
	}
	return token;
}

/** SQLite table-valued pragmas that only read metadata. */
const READ_ONLY_PRAGMA_CALLS = new Set([
	"table_info", "table_xinfo", "index_list", "index_info", "index_xinfo",
	"foreign_key_list", "database_list", "collation_list", "function_list",
	"module_list", "pragma_list",
]);

/** Lexical read-only gate for sql_query (statement must already be single). */
export function assertReadOnlyStatement(statement: string): void {
	const bare = stripSqlComments(statement);
	const token = leadingToken(bare);
	if (!READ_ONLY_LEADING_TOKENS.has(token)) {
		if (WRITE_LEADING_TOKENS.has(token)) {
			throw new SqlGuardError("DB_READ_ONLY_VIOLATION", `sql_query rejected: leading token ${token} is not read-only`);
		}
		throw new SqlGuardError(
			"DB_READ_ONLY_VIOLATION",
			`sql_query rejected: statement must start with SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH (got ${token || "nothing"})`,
		);
	}
	const folded = bare.toUpperCase();
	if (/\bFOR\s+UPDATE\b/.test(folded) || /\bFOR\s+SHARE\b/.test(folded)) {
		throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: FOR UPDATE / FOR SHARE locking clauses are not read-only");
	}
	if (/\bSELECT\b[^;]*\bINTO\b/.test(folded)) {
		throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: SELECT ... INTO creates a table");
	}
	if (token === "WITH") {
		if (/\)\s*(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(folded) || /\bAS\s*\(\s*(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(folded)) {
			throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: data-modifying CTE (WITH ... INSERT/UPDATE/DELETE)");
		}
		if (/\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/.test(folded)) {
			throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: data-modifying statement inside WITH");
		}
	}
	if (token === "PRAGMA") {
		if (/^PRAGMA\s+[A-Za-z0-9_.]+\s*=/.test(bare.trim().toUpperCase())) {
			throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: PRAGMA assignment writes configuration");
		}
		// Call-form is read-only only for SQLite's table-valued pragmas; the rest may set state.
		const callForm = /^PRAGMA\s+([A-Za-z0-9_.]+)\s*\(/i.exec(bare.trim());
		if (callForm && !READ_ONLY_PRAGMA_CALLS.has(callForm[1]!.toLowerCase())) {
			throw new SqlGuardError("DB_READ_ONLY_VIOLATION", "sql_query rejected: PRAGMA call-form assignment writes configuration");
		}
	}
}

/** Identifier guard for interpolated table names (schema/stats). */
export function assertSafeIdentifier(name: string): string {
	const trimmed = name.trim();
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
		throw new SqlGuardError("DB_INVALID_CONFIG", `invalid SQL identifier: ${JSON.stringify(trimmed)}`);
	}
	return trimmed;
}

/** JSON-safe cell value: bigint -> decimal string, binary -> size placeholder. */
export function jsonSafeValue(value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) return "<BLOB " + value.byteLength + "B>";
	if (value instanceof Date) return value.toISOString();
	return value;
}

export function jsonSafeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	return rows.map((row) => Object.fromEntries(
		Object.entries(row).map(([key, value]) => [key, jsonSafeValue(value)]),
	));
}

export function formatTable(columns: string[], rows: Array<Record<string, unknown>>): string {
	const cell = (value: unknown) => (value === null || value === undefined ? "" : String(value));
	return [columns.join(" | "), columns.map(() => "---").join(" | "), rows.map((row) => columns.map((column) => cell(row[column])).join(" | ")).join("\n")].join("\n");
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
	const escape = (value: unknown) => {
		const text = value === null || value === undefined ? "" : String(value);
		return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
	};
	return [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
}

/** True when the driver error means the server session is gone and one reopen may heal it. */
export function isDbConnectionLoss(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const err = error as { code?: unknown; message?: unknown };
	const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
	const message = typeof err.message === "string" ? err.message : "";
	if (["ECONNRESET", "EPIPE", "ETIMEDOUT", "PROTOCOL_CONNECTION_LOST", "CONNECTION_LOST", "57P01", "57P03", "08003", "08006"].includes(code)) return true;
	return /connection lost|connection closed|connection ended|connection terminated|server closed the connection unexpectedly/i.test(message);
}
