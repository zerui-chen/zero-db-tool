/** 与 /zero-db-tool/api 对话的最小客户端。 */
export type DbEngine = "sqlite" | "postgres" | "mysql";
export type ConnectionMode = "parameters" | "url-env";
export type PasswordMode = "runtime" | "environment" | "encrypted";

export type Connection = {
	name: string;
	engine: DbEngine;
	path?: string;
	mode?: ConnectionMode;
	urlEnv?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	passwordMode?: PasswordMode;
	passwordRef?: string;
	passwordEnv?: string;
	passwordStatus?: "runtime" | "environment" | "encrypted" | "required";
	ssl?: boolean;
	createdAt: string;
};

export type TableSummary = { name: string; type: "table" | "view"; schema?: string };
export type ColumnSummary = { name: string; type: string; nullable: boolean; primaryKey: boolean };
export type TablePage = {
	connection: string;
	table: string;
	columns: ColumnSummary[];
	rows: Array<Record<string, unknown>>;
	page: number;
	pageSize: number;
	hasNext: boolean;
};
export type QueryResult = { connection: string; sql: string; columns: string[]; rows: Array<Record<string, unknown>>; rowCount: number; truncated: boolean };
export type IndexSummary = { name: string; columns: string[]; unique: boolean; type?: string; definition?: string };
export type ExecuteResult = { statementCount: number; affectedRows: number; results: Array<{ operation: "INSERT" | "UPDATE"; affectedRows: number }> };
export type ExecuteResponse = { needsConfirmation?: boolean; challengeId?: string; statements?: string[]; result?: ExecuteResult };
export type ConnectionDocument = { schemaVersion: 1; exportedAt: string; connections: Connection[] };

const BASE = "/zero-db-tool/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(BASE + path, {
		credentials: "same-origin",
		...init,
		headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
	});
	let payload: unknown = null;
	try { payload = await response.json(); } catch { payload = null; }
	const body = payload as { ok?: boolean; error?: { message?: string } } | null;
	if (!response.ok || body?.ok === false) {
		throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
	}
	return payload as T;
}

export const api = {
	version: () => request<{ version: string }>("/version"),
	list: () => request<{ connections: Connection[] }>("/connections"),
	add: (input: Record<string, unknown>) => request<{ connection: Connection }>("/connections", { method: "POST", body: JSON.stringify(input) }),
	update: (name: string, input: Record<string, unknown>) => request<{ connection: Connection }>(`/connections/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify(input) }),
	remove: (name: string) => request<Record<string, never>>(`/connections/${encodeURIComponent(name)}`, { method: "DELETE" }),
	test: (name: string) => request<{ result: { elapsedMs?: number } }>(`/connections/${encodeURIComponent(name)}/test`, { method: "POST", body: "{}" }),
	catalog: (name: string, database?: string) => request<{ databases: string[]; tables: TableSummary[] }>(
		`/connections/${encodeURIComponent(name)}/browse${database ? `?database=${encodeURIComponent(database)}` : ""}`),
	browse: (name: string, table: string, page: number, pageSize: number, database?: string) => request<{ result: TablePage }>(
		`/connections/${encodeURIComponent(name)}/browse?table=${encodeURIComponent(table)}&page=${page}&pageSize=${pageSize}${database ? `&database=${encodeURIComponent(database)}` : ""}`),
	query: (name: string, sql: string, database?: string) => request<{ result: QueryResult }>(
		`/connections/${encodeURIComponent(name)}/query`, { method: "POST", body: JSON.stringify({ sql, maxRows: 500, ...(database ? { database } : {}) }) }),
	indexes: (name: string, table: string, database?: string) => request<{ indexes: IndexSummary[] }>(
		`/connections/${encodeURIComponent(name)}/indexes?table=${encodeURIComponent(table)}${database ? `&database=${encodeURIComponent(database)}` : ""}`),
	execute: (name: string, sql: string, opts?: { database?: string; confirmationId?: string }) => request<ExecuteResponse>(
		`/connections/${encodeURIComponent(name)}/execute`,
		{ method: "POST", body: JSON.stringify({ sql, ...(opts?.database ? { database: opts.database } : {}), ...(opts?.confirmationId ? { confirmationId: opts.confirmationId } : {}) }) }),
	exportAll: () => request<{ document: ConnectionDocument }>("/export"),
	importAll: (document: unknown, conflict: "skip" | "overwrite") => request<{ result: { imported: number; updated: number; skipped: number } }>(
		"/import", { method: "POST", body: JSON.stringify({ document, conflict }) }),
};