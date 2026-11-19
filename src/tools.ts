/**
 * 六个模型工具：
 *   sql_query        只读单语句
 *   sql_exec         INSERT 直通；含 UPDATE 时由本工具直接向用户发起批准
 *   sql_schema       列出表/视图，或描述一张表的列
 *   sql_stats        表数量、逐表行数、SQLite 文件大小
 *   sql_health       逐连接探活 + 治理摘要
 *   sql_connections  列出/新增/删除/测试连接
 */
import { DbConnectionError } from "./connections.js";
import type { PluginContext } from "./plugin-types.js";
import {
	SQL_MAX_ROWS_DEFAULT,
	SQL_MAX_ROWS_LIMIT,
	SQL_QUERY_TIMEOUT_MS,
	SQL_EXEC_TIMEOUT_MS,
	WorkbenchService,
	type QueryFormat,
} from "./manager.js";
import { SqlGuardError } from "./sql-guard.js";

const TOOL_DESCRIPTION =
	"Governed SQL access over named database connections (sqlite via node:sqlite; PostgreSQL via pg; MySQL via mysql2). " +
	"sql_query is READ-ONLY (SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH; single statement). " +
	"Before writing any SQL, call sql_schema to inspect real table/column names — never guess identifiers. " +
	"sql_exec permits INSERT directly; UPDATE asks the user for approval inside the call. DELETE, DROP, DDL, permissions, transactions and all other mutations remain forbidden. " +
	"sql_stats counts rows per table (can be expensive on large tables). sql_health probes connectivity. " +
	"sql_connections manages configs: adding a connection is low-risk, but run action=\"test\" before first real use.";

type ToolOutput = { text: string; isError?: boolean };

type ExecLike = { agent?: unknown; signal?: AbortSignal } | undefined;

function mapErrorCode(error: unknown): string {
	if (error instanceof SqlGuardError) return error.code;
	if (error instanceof DbConnectionError) return error.code;
	const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
	switch (code) {
		case "DB_CONNECTION_NOT_FOUND":
		case "DB_ENV_MISSING":
		case "DB_ENGINE_UNAVAILABLE":
		case "DB_ENGINE_ERROR":
		case "DB_INVALID_CONFIG":
			return code;
		default:
			return "DB_ENGINE_ERROR";
	}
}

async function envelope(operation: () => Promise<Record<string, unknown>>): Promise<ToolOutput> {
	try {
		const result = await operation();
		return { text: JSON.stringify({ ok: true, ...result }) };
	} catch (error) {
		return {
			text: JSON.stringify({ ok: false, error: { code: mapErrorCode(error), message: error instanceof Error ? error.message : String(error) } }),
			isError: true,
		};
	}
}

const output = {
	schema: {
		type: "object",
		properties: {
			text: { type: "string", description: "JSON result text" },
			isError: { type: "boolean", description: "true when the operation was rejected or failed" },
		},
		required: ["text"],
	},
	render: (_args: unknown, value: { text: string }) => [{ type: "text" as const, text: value.text }],
};

export function registerTools(ctx: PluginContext, service: WorkbenchService): void {
	const tools = ctx.tools;
	if (!tools?.register) return;

	tools.register({
		name: "sql_query",
		timeoutMs: SQL_QUERY_TIMEOUT_MS + 10_000,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				connection: { type: "string", description: "Named database connection." },
				sql: { type: "string", description: "One read-only SQL statement (SELECT/PRAGMA/EXPLAIN/SHOW/DESCRIBE/WITH)." },
				format: { type: "string", enum: ["json", "table", "csv"], description: "Optional text rendering of the rows; default json." },
				limit: { type: "number", description: `Max rows (default ${SQL_MAX_ROWS_DEFAULT}, cap ${SQL_MAX_ROWS_LIMIT}).` },
			},
			required: ["connection", "sql"],
		},
		output,
		execute: async (args: { connection: string; sql: string; format?: QueryFormat; limit?: number }) =>
			envelope(async () => {
				const result = await service.query(args.connection, args.sql, args.format ?? "json", args.limit ?? SQL_MAX_ROWS_DEFAULT);
				return { connection: result.connection, columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated, ...(result.text !== undefined ? { text: result.text } : {}) };
			}),
	});

	tools.register({
		name: "sql_exec",
		timeoutMs: SQL_EXEC_TIMEOUT_MS + 30_000,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				connection: { type: "string", description: "Named database connection." },
				sql: { type: "string", description: "One or more INSERT/UPDATE statements separated by semicolons. A batch containing UPDATE prompts the user for approval before it runs." },
			},
			required: ["connection", "sql"],
		},
		output,
		execute: async (args: { connection: string; sql: string }, exec: ExecLike) =>
			envelope(async () => {
				if (service.needsApproval(args.sql)) {
					await requestWriteApproval(ctx, exec, args.connection, args.sql);
				}
				const result = await service.execute(args.connection, args.sql);
				return { connection: args.connection, statementCount: result.statementCount, affectedRows: result.affectedRows, results: result.results };
			}),
	});

	tools.register({
		name: "sql_schema",
		timeoutMs: SQL_QUERY_TIMEOUT_MS + 10_000,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				connection: { type: "string", description: "Named database connection." },
				table: { type: "string", description: "Table name to describe; omit to list all tables and views." },
			},
			required: ["connection"],
		},
		output,
		execute: async (args: { connection: string; table?: string }) =>
			envelope(async () => ({ ...(await service.schema(args.connection, args.table)) })),
	});

	tools.register({
		name: "sql_stats",
		timeoutMs: SQL_EXEC_TIMEOUT_MS + 10_000,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: { connection: { type: "string", description: "Named database connection." } },
			required: ["connection"],
		},
		output,
		execute: async (args: { connection: string }) =>
			envelope(async () => ({ ...(await service.stats(args.connection)) })),
	});

	tools.register({
		name: "sql_health",
		timeoutMs: SQL_EXEC_TIMEOUT_MS,
		description: TOOL_DESCRIPTION,
		parameters: { type: "object", properties: {} },
		output,
		execute: async () =>
			envelope(async () => ({
				connections: await service.health(),
				readOnlyMode: true,
				writeGate: "ask_user_question",
				maxRowsDefault: SQL_MAX_ROWS_DEFAULT,
				maxRowsLimit: SQL_MAX_ROWS_LIMIT,
				queryTimeoutMs: SQL_QUERY_TIMEOUT_MS,
				execTimeoutMs: SQL_EXEC_TIMEOUT_MS,
			})),
	});

	tools.register({
		name: "sql_connections",
		timeoutMs: SQL_QUERY_TIMEOUT_MS + 10_000,
		description: TOOL_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "add", "remove", "test"], description: "Operation to perform." },
				name: { type: "string", description: "Connection name (add/remove/test)." },
				engine: { type: "string", enum: ["sqlite", "postgres", "mysql"], description: "Database engine (add)." },
				path: { type: "string", description: "sqlite only: ABSOLUTE database file path." },
				mode: { type: "string", enum: ["parameters", "url-env"], description: "postgres/mysql connection method; default parameters." },
				urlEnv: { type: "string", description: "url-env mode: environment variable NAME holding the full DSN." },
				host: { type: "string", description: "postgres/mysql host name or IP." },
				port: { type: "number", description: "Optional port (5432 for PostgreSQL, 3306 for MySQL by default)." },
				database: { type: "string", description: "postgres/mysql database name." },
				username: { type: "string", description: "postgres/mysql user name." },
				passwordEnv: { type: "string", description: "Environment variable NAME holding the password; never ask for a password in chat." },
				ssl: { type: "boolean", description: "Enable TLS/SSL." },
			},
			required: ["action"],
		},
		output,
		execute: async (args: {
			action: "list" | "add" | "remove" | "test";
			name?: string;
			engine?: "sqlite" | "postgres" | "mysql";
			path?: string;
			mode?: "parameters" | "url-env";
			urlEnv?: string;
			host?: string;
			port?: number;
			database?: string;
			username?: string;
			passwordEnv?: string;
			ssl?: boolean;
		}) =>
			envelope(async () => {
				if (args.action === "list") return { connections: service.list() };
				if (!args.name) throw new SqlGuardError("DB_INVALID_CONFIG", "name is required for add/remove/test");
				if (args.action === "test") return { name: args.name, result: await service.test(args.name) };
				if (args.action === "remove") {
					const removed = await service.remove(args.name);
					if (!removed) throw new DbConnectionError("DB_CONNECTION_NOT_FOUND", `no database connection named "${args.name}"`);
					return { removed: args.name };
				}
				if (!args.engine) throw new SqlGuardError("DB_INVALID_CONFIG", "action=add requires name and engine");
				const summary = await service.add({
					name: args.name,
					engine: args.engine,
					...(args.path ? { path: args.path } : {}),
					...(args.mode ? { mode: args.mode } : {}),
					...(args.urlEnv ? { urlEnv: args.urlEnv } : {}),
					...(args.host ? { host: args.host } : {}),
					...(args.port !== undefined ? { port: args.port } : {}),
					...(args.database ? { database: args.database } : {}),
					...(args.username ? { username: args.username } : {}),
					...(args.passwordEnv ? { passwordMode: "environment" as const, passwordEnv: args.passwordEnv } : {}),
					...(args.ssl !== undefined ? { ssl: args.ssl } : {}),
				});
				return { added: { name: summary.name, engine: summary.engine }, note: "connection registered; run action=\"test\" before first real use" };
			}),
	});
}

/** Ask the human before an UPDATE batch runs; fail closed when no question UI is available. */
async function requestWriteApproval(ctx: PluginContext, exec: ExecLike, connection: string, sql: string): Promise<void> {
	const questions = (ctx as unknown as {
		get?: (name: string, optional?: boolean) => { ask: (request: unknown) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> } | undefined;
	}).get?.("userQuestions", true);
	if (!questions?.ask) {
		throw new SqlGuardError("DB_CONFIRMATION_REQUIRED", "sql_exec needs the ask_user_question confirmation gate, which is unavailable in this session");
	}
	const agent = (exec as { agent?: unknown } | undefined)?.agent;
	if (!agent) {
		throw new SqlGuardError("DB_CONFIRMATION_REQUIRED", "sql_exec needs a live session to ask for confirmation");
	}
	const answer = await questions.ask({
		questions: [{
			id: "approve-sql-write",
			header: "SQL 写入确认",
			question: `连接 ${connection} 上即将执行包含 UPDATE 的语句：\n\n${sql}\n\n批准后立即执行。`,
			options: [
				{ label: "批准", description: "执行这批 INSERT/UPDATE 语句。" },
				{ label: "拒绝", description: "不执行，语句不会发送到数据库。" },
			],
		}],
		agent,
		signal: (exec as { signal?: AbortSignal } | undefined)?.signal,
	});
	const selected = answer.answers.find((item) => item.id === "approve-sql-write")?.selected ?? [];
	if (!selected.includes("批准")) {
		throw new SqlGuardError("DB_CONFIRMATION_REQUIRED", "the user rejected the UPDATE batch");
	}
}
