/**
 * 工作台业务层：把 DbConnectionRegistry 收窄成工具/HTTP 需要的能力。
 * 写入语义：只读查询、INSERT 直通、UPDATE 需人类批准、其余写一律拒绝。
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import {
	DbConnectionError,
	type DbConnectionRegistry,
	type DbConnectionSummary,
	type DbIndexSummary,
	type DbQueryHandle,
	type DbTablePage,
	type DbTableSummary,
	isSqliteHandle,
} from "./connections.js";
import {
	SqlGuardError,
	assertReadOnlyStatement,
	assertSafeIdentifier,
	assertSingleStatement,
	assertWriteStatement,
	formatTable,
	isDbConnectionLoss,
	jsonSafeRows,
	splitStatements,
	toCsv,
} from "./sql-guard.js";

export const SQL_QUERY_TIMEOUT_MS = 30_000;
export const SQL_EXEC_TIMEOUT_MS = 60_000;
export const SQL_MAX_ROWS_DEFAULT = 200;
export const SQL_MAX_ROWS_LIMIT = 1_000;
const STATS_TABLE_LIMIT = 100;

export type QueryFormat = "json" | "table" | "csv";

export type WorkbenchQueryResult = {
	connection: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	truncated: boolean;
	text?: string;
};

export type SchemaResult =
	| { connection: string; tables: DbTableSummary[] }
	| { connection: string; table: string; columns: Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }> };

export type StatsResult = {
	connection: string;
	tableCount: number;
	tables: Record<string, number>;
	truncated: boolean;
	sizeBytes?: number;
};

export class WorkbenchService {
	constructor(readonly registry: DbConnectionRegistry) {}

	list(): DbConnectionSummary[] {
		return this.registry.list();
	}

	get(name: string): DbConnectionSummary | undefined {
		return this.registry.get(name);
	}

	add(input: Parameters<DbConnectionRegistry["add"]>[0]): Promise<DbConnectionSummary> {
		return this.registry.add(input);
	}

	update(name: string, input: Parameters<DbConnectionRegistry["update"]>[1]): Promise<DbConnectionSummary> {
		return this.registry.update(name, input);
	}

	remove(name: string): Promise<boolean> {
		return this.registry.remove(name);
	}

	test(name: string): Promise<{ elapsedMs: number }> {
		return this.registry.test(name) as Promise<{ elapsedMs: number }>;
	}

	exportConfig() {
		return this.registry.exportConfig();
	}

	importConfig(document: unknown, conflict: "skip" | "overwrite") {
		return this.registry.importConfig(document, conflict);
	}

	listDatabases(name: string): Promise<string[]> {
		return this.registry.listDatabases(name);
	}

	listTables(name: string, database?: string): Promise<DbTableSummary[]> {
		return this.registry.listTables(name, database);
	}

	browse(name: string, table: string, page: number, pageSize: number, database?: string): Promise<DbTablePage> {
		if (table.trim() === "") {
			throw new SqlGuardError("DB_INVALID_CONFIG", "未选择表：请先刷新表目录再选择表或视图");
		}
		return this.registry.browseTable(name, table, page, pageSize, database);
	}

	/** Read-only, row-capped query used by the workbench UI (supports a database override). */
	queryPage(name: string, sql: string, maxRows = 500, database?: string) {
		return this.registry.queryPage(name, sql, maxRows, database);
	}

	/** Guarded single-statement read for the UI, with an optional database override. */
	queryReadOnly(name: string, sql: string, maxRows = 500, database?: string) {
		const statements = splitStatements(sql ?? "");
		assertSingleStatement(statements);
		if (statements.length === 0) throw new SqlGuardError("DB_INVALID_CONFIG", "sql is empty");
		assertReadOnlyStatement(statements[0]!);
		return this.withTimeout(this.registry.queryPage(name, statements[0]!, maxRows, database), SQL_QUERY_TIMEOUT_MS);
	}

	async query(connection: string, sql: string, format: QueryFormat = "json", limit = SQL_MAX_ROWS_DEFAULT): Promise<WorkbenchQueryResult> {
		const statements = splitStatements(sql ?? "");
		assertSingleStatement(statements);
		if (statements.length === 0) throw new SqlGuardError("DB_INVALID_CONFIG", "sql is empty");
		assertReadOnlyStatement(statements[0]!);
		const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : SQL_MAX_ROWS_DEFAULT, 1), SQL_MAX_ROWS_LIMIT);
		const { columns, all } = await this.withTimeout(
			this.withReconnect(connection, async () => {
				const handle = await this.registry.connect(connection);
				if (isSqliteHandle(handle)) {
					const stmt = handle.prepare(statements[0]!.trim());
					return { columns: stmt.columns().map((column) => column.name), all: stmt.all() as Array<Record<string, unknown>> };
				}
				const rows = await handle.query(statements[0]!.trim());
				return { columns: rows.length > 0 ? Object.keys(rows[0] as object) : [], all: rows };
			}),
			SQL_QUERY_TIMEOUT_MS,
			() => this.registry.evict(connection),
		);
		const truncated = all.length > safeLimit;
		const rows = jsonSafeRows(truncated ? all.slice(0, safeLimit) : all);
		const text = format === "table" ? formatTable(columns, rows) : format === "csv" ? toCsv(columns, rows) : undefined;
		return { connection, columns, rows, rowCount: rows.length, truncated, ...(text !== undefined ? { text } : {}) };
	}

	/** Execute an INSERT/UPDATE batch. Callers own the UPDATE approval gate. */
	async execute(connection: string, sql: string, database?: string): Promise<{ statementCount: number; affectedRows: number; results: Array<{ operation: "INSERT" | "UPDATE"; affectedRows: number }> }> {
		const statements = splitStatements(sql ?? "");
		if (statements.length === 0) throw new SqlGuardError("DB_INVALID_CONFIG", "sql is empty");
		const kinds = statements.map(assertWriteStatement);
		return this.withTimeout(
			(async () => {
				const results: Array<{ operation: "INSERT" | "UPDATE"; affectedRows: number }> = [];
				for (let index = 0; index < statements.length; index += 1) {
					const affectedRows = await this.withReconnect(connection, () => this.registry.executeWrite(connection, statements[index]!, database));
					results.push({ operation: kinds[index]!, affectedRows });
				}
				return {
					statementCount: results.length,
					affectedRows: results.reduce((sum, item) => sum + item.affectedRows, 0),
					results,
				};
			})(),
			SQL_EXEC_TIMEOUT_MS,
			() => this.registry.evict(connection),
		);
	}

	/** Indexes for one table (read-only metadata). */
	async indexes(connection: string, table: string, database?: string): Promise<DbIndexSummary[]> {
		if (!table || table.trim() === "") throw new SqlGuardError("DB_INVALID_CONFIG", "未选择表：请先刷新表目录再选择表或视图");
		return this.withTimeout(this.registry.listIndexes(connection, table, database), SQL_QUERY_TIMEOUT_MS);
	}

	/** Whether a batch needs human approval before it may run. */
	needsApproval(sql: string): boolean {
		return splitStatements(sql ?? "").some((statement) => assertWriteStatement(statement) === "UPDATE");
	}

	async schema(connection: string, table?: string): Promise<SchemaResult> {
		const tables = await this.withTimeout(this.registry.listTables(connection), SQL_QUERY_TIMEOUT_MS);
		if (table === undefined || table.trim() === "") return { connection, tables };
		const safeTable = assertSafeIdentifier(table);
		const page = await this.withTimeout(this.registry.browseTable(connection, safeTable, 1, 1), SQL_QUERY_TIMEOUT_MS);
		return { connection, table: safeTable, columns: page.columns };
	}

	async stats(connection: string): Promise<StatsResult> {
		const tables = await this.withTimeout(this.registry.listTables(connection), SQL_QUERY_TIMEOUT_MS);
		const rowsByTable: Record<string, number> = {};
		let truncated = false;
		for (const [index, table] of tables.entries()) {
			if (index >= STATS_TABLE_LIMIT) { truncated = true; break; }
			const name = assertSafeIdentifier(table.name);
			const rows = await this.withTimeout(
				this.registry.query(connection, `SELECT COUNT(*) AS n FROM ${name}`),
				SQL_QUERY_TIMEOUT_MS,
			).catch(() => [{ n: -1 }]);
			rowsByTable[name] = Number(rows[0]?.n ?? -1);
		}
		const config = this.registry.get(connection);
		let sizeBytes: number | undefined;
		if (config?.path) {
			try { sizeBytes = (await stat(path.resolve(config.path))).size; } catch { sizeBytes = undefined; }
		}
		return { connection, tableCount: tables.length, tables: rowsByTable, truncated, ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
	}

	async health(): Promise<Array<{ name: string; engine: string; ok: boolean; elapsedMs?: number; code?: string; message?: string }>> {
		const results = [];
		for (const summary of this.registry.list()) {
			try {
				const probe = await this.registry.test(summary.name);
				results.push({ name: summary.name, engine: summary.engine, ok: true, elapsedMs: probe.elapsedMs });
			} catch (error) {
				results.push({
					name: summary.name,
					engine: summary.engine,
					ok: false,
					code: error instanceof DbConnectionError ? error.code : "DB_ENGINE_ERROR",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	private async withReconnect<T>(connection: string, operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (!isDbConnectionLoss(error)) throw error;
			this.registry.evict(connection);
			return operation();
		}
	}

	private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						onTimeout?.();
						reject(new SqlGuardError("DB_TIMEOUT", `database operation timed out after ${timeoutMs}ms`));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

export type { DbQueryHandle };
