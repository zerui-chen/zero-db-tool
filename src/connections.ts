/**
 * Operator Chat — governed database connection registry (2026-09-12).
 *
 * Manages NAMED database connection configs persisted in Console app-data
 * (`db/connections.json` under the Console-global app-data namespace). Credentials NEVER live in
 * the config: sqlite stores an absolute file path; postgres/mysql store safe
 * host/port/database/user metadata or the NAME of a DSN environment variable.
 * Password/DSN values are never persisted, echoed, listed, or exported.
 *
 * Engines:
 *   - sqlite: Node built-in `node:sqlite` (DatabaseSync) — zero npm deps.
 *   - postgres / mysql: packaged pg/mysql2 drivers loaded dynamically; a broken
 *     installation maps to DB_ENGINE_UNAVAILABLE instead of crashing Console.
 */

import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

/** Atomic 0600 JSON write; the Console app-data helper is not available inside a DSH plugin. */
async function writeSecureJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		try {
			await rename(tmp, filePath);
		} catch {
			await rm(filePath, { force: true });
			await rename(tmp, filePath);
		}
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => undefined);
		throw error;
	}
}

export type DbEngine = "sqlite" | "postgres" | "mysql";
export type DbConnectionMode = "parameters" | "url-env";
export type DbPasswordMode = "runtime" | "environment" | "encrypted";

/** Persisted connection config. Password and DSN values are never stored. */
export type DbConnectionConfig = {
	name: string;
	engine: DbEngine;
	/** sqlite only: absolute path to the database file. */
	path?: string;
	/** postgres/mysql advanced mode: environment variable NAME holding the DSN. */
	urlEnv?: string;
	/** postgres/mysql connection method. Legacy urlEnv configs load as url-env. */
	mode?: DbConnectionMode;
	/** Parameter mode fields. */
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	passwordMode?: DbPasswordMode;
	/** Stable reference into the encrypted local credential vault. */
	passwordRef?: string;
	passwordEnv?: string;
	ssl?: boolean;
	createdAt: string;
};

/** Sanitized API view. Password material is never included. */
export type DbConnectionSummary = DbConnectionConfig & {
	passwordStatus?: "runtime" | "environment" | "encrypted" | "required";
};

export type DbConnectionInput = {
	name: string;
	engine: DbEngine;
	path?: string;
	mode?: DbConnectionMode;
	urlEnv?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	passwordMode?: DbPasswordMode;
	passwordRef?: string;
	passwordEnv?: string;
	password?: string;
	ssl?: boolean;
	createdAt?: string;
};

export type DbConnectionExportV1 = {
	schemaVersion: 1;
	exportedAt: string;
	connections: DbConnectionConfig[];
};

export type DbConnectionImportResult = {
	imported: number;
	updated: number;
	skipped: number;
	total: number;
};

export type DbTableSummary = { name: string; type: "table" | "view"; schema?: string };
export type DbColumnSummary = { name: string; type: string; nullable: boolean; primaryKey: boolean };
export type DbTablePage = {
	connection: string;
	table: string;
	columns: DbColumnSummary[];
	rows: Array<Record<string, unknown>>;
	page: number;
	pageSize: number;
	hasNext: boolean;
};

export type DbQueryPage = {
	connection: string;
	sql: string;
	columns: string[];
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	truncated: boolean;
};

export type DbConnectionErrorCode =
	| "DB_CONNECTION_NOT_FOUND"
	| "DB_ENV_MISSING"
	| "DB_ENGINE_UNAVAILABLE"
	| "DB_ENGINE_ERROR"
	| "DB_PERSISTENCE_ERROR"
	| "DB_INVALID_CONFIG"
	| "DB_READ_ONLY_VIOLATION";

export class DbConnectionError extends Error {
	constructor(
		readonly code: DbConnectionErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "DbConnectionError";
	}
}

/** Minimal structural supertype of node:sqlite DatabaseSync / pg PoolClient-like drivers used by tools. */
export type DbQueryHandle = {
	/** Run a read-only query returning all rows. */
	query(sql: string): Promise<Array<Record<string, unknown>>>;
	/** Run one statement returning affected-row count. */
	run(sql: string): Promise<number>;
	close(): void;
};

/** SQLite handle additionally exposing the raw DatabaseSync (prepare/columns metadata). */
export type SqliteHandle = DbQueryHandle & {
	/** Prepare a raw statement (column metadata via stmt.columns()). */
	prepare(sql: string): import("node:sqlite").StatementSync;
};

/** Narrow a handle to the sqlite-specific surface (prepare/columns). */
export function isSqliteHandle(handle: DbQueryHandle): handle is SqliteHandle {
	return (
		typeof (handle as Partial<SqliteHandle>).prepare === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toDbEngine(value: string): DbEngine {
	if (value === "sqlite" || value === "postgres" || value === "mysql") {
		return value;
	}
	throw new DbConnectionError(
		"DB_INVALID_CONFIG",
		`engine must be one of sqlite|postgres|mysql (got "${value}")`,
	);
}

/** Split a possibly multi-statement SQL script into trimmed statements. */
function normalizePersisted(
	raw: unknown,
): Map<string, DbConnectionConfig> {
	const map = new Map<string, DbConnectionConfig>();
	if (!Array.isArray(raw)) return map;
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const name = typeof entry.name === "string" ? entry.name : undefined;
		const engine =
			typeof entry.engine === "string" ? toDbEngine(entry.engine) : undefined;
		if (!name || !engine) continue;
		const createdAt =
			typeof entry.createdAt === "string" && entry.createdAt
				? entry.createdAt
				: new Date(0).toISOString();
		try {
			map.set(name, normalizeConnectionInput({
				name,
				engine,
				createdAt,
				...(typeof entry.path === "string" ? { path: entry.path } : {}),
				...(entry.mode === "parameters" ? { mode: "parameters" as const } : {}),
				...(typeof entry.urlEnv === "string" ? { urlEnv: entry.urlEnv } : {}),
				...(typeof entry.host === "string" ? { host: entry.host } : {}),
				...(typeof entry.port === "number" ? { port: entry.port } : {}),
				...(typeof entry.database === "string" ? { database: entry.database } : {}),
				...(typeof entry.username === "string" ? { username: entry.username } : {}),
				...(entry.passwordMode === "environment" || entry.passwordMode === "encrypted" ? { passwordMode: entry.passwordMode } : {}),
				...(typeof entry.passwordRef === "string" ? { passwordRef: entry.passwordRef } : {}),
				...(typeof entry.passwordEnv === "string" ? { passwordEnv: entry.passwordEnv } : {}),
				...(typeof entry.ssl === "boolean" ? { ssl: entry.ssl } : {}),
			}));
		} catch {
			// Skip malformed persisted entries without preventing other connections from loading.
		}
	}
	return map;
}

function envName(value: unknown): string {
	const name = typeof value === "string" ? value.trim() : "";
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new DbConnectionError("DB_INVALID_CONFIG", "environment variable name is invalid");
	}
	return name;
}

function requiredText(value: unknown, label: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw new DbConnectionError("DB_INVALID_CONFIG", label + " is required");
	return text;
}

function normalizeConnectionInput(input: DbConnectionInput): DbConnectionConfig {
	const name = requiredText(input.name, "connection name");
	const engine = toDbEngine(input.engine);
	const createdAt =
		typeof input.createdAt === "string" && !Number.isNaN(Date.parse(input.createdAt))
			? input.createdAt
			: new Date().toISOString();
	if (engine === "sqlite") {
		const dbPath = typeof input.path === "string" ? input.path.trim() : "";
		if (!dbPath || !path.isAbsolute(dbPath)) {
			throw new DbConnectionError("DB_INVALID_CONFIG", "sqlite connection requires an absolute file path");
		}
		return { name, engine, path: dbPath, createdAt };
	}
	const mode: DbConnectionMode = input.mode === "parameters" ? "parameters" : "url-env";
	if (mode === "url-env") {
		return { name, engine, mode, urlEnv: envName(input.urlEnv), createdAt };
	}
	const rawPort = input.port ?? (engine === "postgres" ? 5432 : 3306);
	if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
		throw new DbConnectionError("DB_INVALID_CONFIG", "port must be an integer between 1 and 65535");
	}
	const passwordMode: DbPasswordMode = input.passwordMode === "environment"
		? "environment"
		: input.passwordMode === "encrypted" ? "encrypted" : "runtime";
	const passwordRef = passwordMode === "encrypted"
		? (typeof input.passwordRef === "string" && input.passwordRef.trim() ? input.passwordRef.trim() : credentialRefFor(name))
		: undefined;
	return {
		name,
		engine,
		mode,
		host: requiredText(input.host, "host"),
		port: rawPort,
		...(typeof input.database === "string" && input.database.trim() ? { database: input.database.trim() } : {}),
		username: requiredText(input.username, "username"),
		passwordMode,
		...(passwordMode === "encrypted" ? { passwordRef } : {}),
		...(passwordMode === "environment" ? { passwordEnv: envName(input.passwordEnv) } : {}),
		ssl: input.ssl === true,
		createdAt,
	};
}
/** Fail-closed SQL gate shared by every driver query handle. */
export function assertDatabaseWriteSql(sql: string): "INSERT" | "UPDATE" {
	let executable = sql
		.replace(/--[^\r\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/'(?:''|[^'])*'/g, "''")
		.trim();
	const statements = executable.split(";").map((part) => part.trim()).filter(Boolean);
	if (statements.length === 0) throw new DbConnectionError("DB_READ_ONLY_VIOLATION", "database write is empty");
	let first: "INSERT" | "UPDATE" | undefined;
	for (const statement of statements) {
		const token = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(statement)?.[1]?.toUpperCase();
		if (token !== "INSERT" && token !== "UPDATE") throw new DbConnectionError("DB_READ_ONLY_VIOLATION", "database writes allow only INSERT or UPDATE (got " + (token || "unknown") + ")");
		first ??= token;
	}
	return first!;
}

export function assertDatabaseReadOnlySql(sql: string): void {
	let executable = sql
		.replace(/--[^\r\n]*/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/'(?:''|[^'])*'/g, "''")
		.trim();
	const statements = executable.split(";").map((part) => part.trim()).filter(Boolean);
	if (statements.length !== 1) throw new DbConnectionError("DB_READ_ONLY_VIOLATION", "database access is read-only; multiple SQL statements are forbidden");
	executable = statements[0] ?? "";
	const token = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(executable)?.[1]?.toUpperCase() ?? "";
	if (!["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "PRAGMA"].includes(token)) {
		throw new DbConnectionError("DB_READ_ONLY_VIOLATION", `database access is read-only; ${token || "unknown"} statements are forbidden`);
	}
	const folded = executable.toUpperCase();
	if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CALL|EXECUTE|COPY|LOAD|VACUUM|REINDEX|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|USE|INTO)\b/.test(folded) || /\bFOR\s+(UPDATE|SHARE)\b/.test(folded)) {
		throw new DbConnectionError("DB_READ_ONLY_VIOLATION", "database access is read-only; write, DDL, transaction, locking, and privilege statements are forbidden");
	}
	if (token === "PRAGMA" && (/=/.test(executable) || /^PRAGMA\s+(JOURNAL_MODE|WAL_CHECKPOINT|OPTIMIZE|FOREIGN_KEYS|WRITABLE_SCHEMA)\b/i.test(executable))) {
		throw new DbConnectionError("DB_READ_ONLY_VIOLATION", "database access is read-only; writable PRAGMA statements are forbidden");
	}
}

/** Wrap node:sqlite DatabaseSync into the engine-neutral DbQueryHandle. */
function wrapSqlite(db: import("node:sqlite").DatabaseSync): SqliteHandle {
	return {
		prepare(sql: string) {
			assertDatabaseReadOnlySql(sql);
			return db.prepare(sql);
		},
		async query(sql: string) {
			assertDatabaseReadOnlySql(sql);
			return db.prepare(sql).all() as Array<Record<string, unknown>>;
		},
		async run(sql: string) {
			assertDatabaseWriteSql(sql);
			const result = db.prepare(sql).run();
			return typeof result.changes === "bigint"
				? Number(result.changes)
				: Number(result.changes ?? 0);
		},
		close() {
			try {
				db.close();
			} catch {
				// already closed — idempotent dispose
			}
		},
	};
}

class LocalEncryptedCredentialVault {
	private readonly dataFile: string;
	private loaded: Promise<Map<string, string>> | undefined;
	constructor(private readonly root: string) {
		this.dataFile = path.join(root, "credentials.enc");
	}
	private async key(): Promise<Buffer> {
		await mkdir(this.root, { recursive: true });
		const identity = [os.userInfo().username, os.hostname(), path.resolve(this.root)].join("\0");
		return scryptSync(identity, "zero-db-tool-credentials-v1", 32);
	}
	private async values(): Promise<Map<string, string>> {
		if (!this.loaded) this.loaded = (async () => {
			try {
				const document = decryptCredentialDocument(await readFile(this.dataFile, "utf8"), await this.key());
				return new Map(Object.entries(document.entries));
			} catch { return new Map<string, string>(); }
		})();
		return this.loaded;
	}
	private async flush(values: Map<string, string>): Promise<void> {
		const entries = Object.fromEntries(values);
		const serialized = encryptCredentialDocument({ version: 1, entries }, await this.key());
		const temp = this.dataFile + ".tmp";
		await writeFile(temp, serialized, { mode: 0o600 });
		await (await import("node:fs/promises")).rename(temp, this.dataFile);
		this.loaded = Promise.resolve(new Map(values));
	}
	async set(ref: string, password: string): Promise<void> {
		const values = await this.values(); values.set(ref, password); await this.flush(values);
	}
	async get(ref: string): Promise<string | undefined> { return (await this.values()).get(ref); }
	async delete(ref: string): Promise<void> {
		const values = await this.values(); if (!values.delete(ref)) return; await this.flush(values);
	}
	async clear(): Promise<void> { this.loaded = Promise.resolve(new Map()); try { await (await import("node:fs/promises")).unlink(this.dataFile); } catch {} }
}

export class DbConnectionRegistry {
	private configs = new Map<string, DbConnectionConfig>();
	private handles = new Map<string, DbQueryHandle>();
	private runtimePasswords = new Map<string, string>();
	private readonly credentialVault: LocalEncryptedCredentialVault;
	private readonly legacyCredentialVault?: LocalEncryptedCredentialVault;
	private readonly legacyRoot?: string;
	private loaded = false;
	private write: Promise<void> | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly root: string,
		private readonly persistWriter: (file: string, value: unknown) => Promise<void> = writeSecureJson,
		private readonly driverLoader: (moduleId: string) => Promise<unknown> = (moduleId) => import(moduleId),
		legacyRoot?: string,
	) {
		this.legacyRoot = legacyRoot && path.resolve(legacyRoot) !== path.resolve(root) ? legacyRoot : undefined;
		this.credentialVault = new LocalEncryptedCredentialVault(root);
		this.legacyCredentialVault = this.legacyRoot ? new LocalEncryptedCredentialVault(this.legacyRoot) : undefined;
	}

	/** Wait for the latest persistence write to settle (tests / graceful stop). */
	async flushed(): Promise<void> {
		await this.write;
	}

	private async ensureLoaded(): Promise<void> {
		this.ensureLoadedSync();
	}

	/**
	 * Synchronous lazy loader for the name-based read APIs (list/get/add/
	 * remove): the persisted file is small JSON, so a sync read on first use
	 * keeps list()/get() synchronous. connect() keeps the async reader.
	 */
	private ensureLoadedSync(force = false): void {
		if (this.loaded && !force) return;
		const file = this.connectionsFile();
		if (!existsSync(file) && this.legacyRoot) {
			const legacyFile = path.join(this.legacyRoot, "connections.json");
			if (existsSync(legacyFile)) {
				try {
					this.configs = normalizePersisted(JSON.parse(readFileSync(legacyFile, "utf8")) as unknown);
					mkdirSync(this.root, { recursive: true, mode: 0o700 });
					writeFileSync(file, JSON.stringify([...this.configs.values()], null, 2) + "\n", { mode: 0o600 });
				} catch { this.configs = new Map(); }
				this.loaded = true;
				return;
			}
		}
		if (!existsSync(file)) {
			this.configs = new Map();
			this.loaded = true;
			return;
		}
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
			const next = normalizePersisted(raw);
			for (const [name, current] of this.configs) {
				const updated = next.get(name);
				if (!updated || JSON.stringify(updated) !== JSON.stringify(current)) this.closeHandle(name);
			}
			this.configs = next;
		} catch {
			// A concurrent atomic replace can make the file briefly unavailable.
			// Keep the last valid snapshot instead of hiding every connection.
			if (!this.loaded) this.configs = new Map();
		}
		this.loaded = true;
	}

	private connectionsFile(): string {
		return path.join(this.root, "connections.json");
	}

	private async persist(configs: Map<string, DbConnectionConfig>): Promise<void> {
		const write = this.persistWriter(this.connectionsFile(), [...configs.values()]);
		this.write = write;
		try {
			await write;
		} catch (error) {
			throw new DbConnectionError(
				"DB_PERSISTENCE_ERROR",
				`failed to save database connections: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		} finally {
			if (this.write === write) this.write = undefined;
		}
	}

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationQueue.then(operation, operation);
		this.mutationQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async add(input: DbConnectionInput): Promise<DbConnectionSummary> {
		return this.mutate(async () => {
			this.ensureLoadedSync(true);
			const config = normalizeConnectionInput(input);
			if (config.mode === "parameters" && (config.passwordMode === "runtime" || config.passwordMode === "encrypted") && typeof input.password !== "string") {
				throw new DbConnectionError("DB_INVALID_CONFIG", "password is required for a new password connection");
			}
			if (this.configs.has(config.name)) {
				throw new DbConnectionError("DB_INVALID_CONFIG", `connection "${config.name}" already exists`);
			}
			const next = new Map(this.configs);
			next.set(config.name, config);
			if (config.mode === "parameters" && config.passwordMode === "encrypted" && typeof input.password === "string") {
				await this.credentialVault.set(config.passwordRef as string, input.password);
			}
			await this.persist(next);
			this.configs = next;
			if (config.mode === "parameters" && config.passwordMode === "runtime" && typeof input.password === "string") {
				this.runtimePasswords.set(config.name, input.password);
			}
			return this.summary(config);
		});
	}

	async update(
		currentName: string,
		input: DbConnectionInput,
	): Promise<DbConnectionSummary> {
		return this.mutate(async () => {
			this.ensureLoadedSync(true);
			const current = this.configs.get(currentName);
			if (!current) {
				throw new DbConnectionError("DB_CONNECTION_NOT_FOUND", `no database connection named "${currentName}"`);
			}
			const config = normalizeConnectionInput({
				...input,
				...(input.passwordMode === "encrypted" && typeof input.passwordRef !== "string" && current.passwordRef ? { passwordRef: current.passwordRef } : {}),
				createdAt: current.createdAt,
			});
			if (config.name !== currentName && this.configs.has(config.name)) {
				throw new DbConnectionError("DB_INVALID_CONFIG", `connection "${config.name}" already exists`);
			}
			if (config.mode === "parameters" && (config.passwordMode === "runtime" || config.passwordMode === "encrypted") && typeof input.password !== "string" && config.passwordMode === "runtime" && !this.runtimePasswords.has(currentName)) {
				if (config.passwordMode === "runtime") throw new DbConnectionError("DB_INVALID_CONFIG", "password must be entered again because no runtime password is available");
			}
			const next = new Map(this.configs);
			next.delete(currentName);
			next.set(config.name, config);
			if (config.mode === "parameters" && config.passwordMode === "encrypted" && typeof input.password === "string") {
				await this.credentialVault.set(config.passwordRef as string, input.password);
			}
			await this.persist(next);
			if (current.passwordMode === "encrypted" && current.passwordRef && (config.passwordMode !== "encrypted" || config.passwordRef !== current.passwordRef)) {
				await this.credentialVault.delete(current.passwordRef);
			}
			this.closeHandle(currentName);
			const previousPassword = this.runtimePasswords.get(currentName);
			this.runtimePasswords.delete(currentName);
			if (config.mode === "parameters" && config.passwordMode === "runtime") {
				if (typeof input.password === "string") this.runtimePasswords.set(config.name, input.password);
				else if (previousPassword !== undefined) this.runtimePasswords.set(config.name, previousPassword);
			}
			this.configs = next;
			return this.summary(config);
		});
	}

	async remove(name: string): Promise<boolean> {
		return this.mutate(async () => {
			this.ensureLoadedSync(true);
			const current = this.configs.get(name);
			if (!current) return false;
			const next = new Map(this.configs);
			next.delete(name);
			await this.persist(next);
			this.closeHandle(name);
			this.runtimePasswords.delete(name);
			if (current.passwordMode === "encrypted" && current.passwordRef) await this.credentialVault.delete(current.passwordRef);
			this.configs = next;
			return true;
		});
	}

	exportConfig(): DbConnectionExportV1 {
		this.ensureLoadedSync(true);
		return {
			schemaVersion: 1,
			exportedAt: new Date().toISOString(),
			connections: [...this.configs.values()].map((config) => ({ ...config })),
		};
	}

	async importConfig(
		input: unknown,
		conflict: "skip" | "overwrite" = "skip",
	): Promise<DbConnectionImportResult> {
		return this.mutate(async () => {
			this.ensureLoadedSync(true);
			if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.connections)) {
				throw new DbConnectionError("DB_INVALID_CONFIG", "invalid database connection export document");
			}
			const parsed = input.connections.map((entry) => {
				if (!isRecord(entry) || typeof entry.engine !== "string") {
					throw new DbConnectionError("DB_INVALID_CONFIG", "invalid connection entry in import document");
				}
				return normalizeConnectionInput({
					name: typeof entry.name === "string" ? entry.name : "",
					engine: toDbEngine(entry.engine),
					...(typeof entry.path === "string" ? { path: entry.path } : {}),
					...(entry.mode === "parameters" || entry.mode === "url-env" ? { mode: entry.mode } : {}),
					...(typeof entry.urlEnv === "string" ? { urlEnv: entry.urlEnv } : {}),
					...(typeof entry.host === "string" ? { host: entry.host } : {}),
					...(typeof entry.port === "number" ? { port: entry.port } : {}),
					...(typeof entry.database === "string" ? { database: entry.database } : {}),
					...(typeof entry.username === "string" ? { username: entry.username } : {}),
					...(entry.passwordMode === "runtime" || entry.passwordMode === "environment" || entry.passwordMode === "encrypted" ? { passwordMode: entry.passwordMode } : {}),
					...(typeof entry.passwordRef === "string" ? { passwordRef: entry.passwordRef } : {}),
					...(typeof entry.passwordEnv === "string" ? { passwordEnv: entry.passwordEnv } : {}),
					...(typeof entry.ssl === "boolean" ? { ssl: entry.ssl } : {}),
					...(typeof entry.createdAt === "string" ? { createdAt: entry.createdAt } : {}),
				});
			});
			const next = new Map(this.configs);
			const handlesToClose: string[] = [];
			let imported = 0;
			let updated = 0;
			let skipped = 0;
			for (const config of parsed) {
				if (next.has(config.name)) {
					if (conflict === "skip") {
						skipped += 1;
						continue;
					}
					handlesToClose.push(config.name);
					updated += 1;
				} else {
					imported += 1;
				}
				next.set(config.name, config);
			}
			if (imported > 0 || updated > 0) {
				await this.persist(next);
				for (const name of handlesToClose) {
					this.closeHandle(name);
					this.runtimePasswords.delete(name);
				}
				this.configs = next;
			}
			return { imported, updated, skipped, total: parsed.length };
		});
	}

	private closeHandle(name: string): void {
		const handle = this.handles.get(name);
		if (!handle) return;
		this.handles.delete(name);
		handle.close();
	}

	private summary(config: DbConnectionConfig): DbConnectionSummary {
		if (config.mode !== "parameters") return { ...config };
		const passwordStatus = config.passwordMode === "environment"
			? "environment" as const
			: config.passwordMode === "encrypted" ? "encrypted" as const
			: this.runtimePasswords.has(config.name) ? "runtime" as const : "required" as const;
		return { ...config, passwordStatus };
	}

	/** Sanitized summaries — never includes any env var or password value. */
	list(): DbConnectionSummary[] {
		this.ensureLoadedSync(true);
		return [...this.configs.values()].map((config) => this.summary(config));
	}

	get(name: string): DbConnectionSummary | undefined {
		this.ensureLoadedSync(true);
		const config = this.configs.get(name);
		return config ? this.summary(config) : undefined;
	}

	/** Resolve configs lazily-loaded from disk before name-based lookups. */
	async refresh(): Promise<void> {
		await this.ensureLoaded();
	}


	async listDatabases(name: string): Promise<string[]> {
		const config = this.getConfig(name);
		if (config.engine === "sqlite") return ["main"];
		// Catalog discovery must use a server-level connection. PostgreSQL servers
		// commonly reject a database-less connection, so use the maintenance
		// database explicitly; MySQL accepts a connection without a default schema.
		const handle = await this.connect(name, config.engine === "postgres" ? "postgres" : undefined);
		const rows = config.engine === "postgres"
			? await handle.query("SELECT datname AS name FROM pg_database WHERE datistemplate = false AND has_database_privilege(datname, 'CONNECT') ORDER BY datname")
			: await handle.query("SHOW DATABASES");
		return Array.from(new Set(rows.map((row) => String(row.name ?? row.Database ?? row.database ?? "").trim()).filter(Boolean)));

	}

	async listTables(name: string, selectedDatabase?: string): Promise<DbTableSummary[]> {
		const config = this.getConfig(name);
		const effectiveDatabase = selectedDatabase?.trim() || config.database;
		const sql = config.engine === "sqlite"
			? "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
			: config.engine === "postgres"
				? "SELECT table_name AS name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name"
				: effectiveDatabase
					? "SELECT table_name AS name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type, table_schema AS schemaName FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name"
					: "SELECT table_name AS name, CASE WHEN table_type = 'VIEW' THEN 'view' ELSE 'table' END AS type, table_schema AS schemaName FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY table_schema, table_name";
		const rows = await this.queryWithReconnect(name, (handle) => handle.query(sql), effectiveDatabase);
		return rows.map((row) => ({
			name: String(row.name ?? ""),
			type: String(row.type).toLowerCase() === "view" ? "view" as const : "table" as const,
			...(typeof row.schemaName === "string" && !effectiveDatabase ? { schema: row.schemaName } : {}),
		})).filter((table) => table.name !== "");
	}

	async browseTable(name: string, requestedTable: string, page = 1, pageSize = 50, selectedDatabase?: string): Promise<DbTablePage> {
		const config = this.getConfig(name);
		const tables = await this.listTables(name, selectedDatabase);
		const table = tables.find((candidate) => (candidate.schema ? `${candidate.schema}.${candidate.name}` : candidate.name) === requestedTable);
		if (!table) throw new DbConnectionError("DB_INVALID_CONFIG", `table or view "${requestedTable}" does not exist`);
		const safePage = Number.isInteger(page) && page > 0 ? page : 1;
		const safePageSize = Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), 200) : 50;
		const offset = (safePage - 1) * safePageSize;
		const escapedName = config.engine === "mysql"
			? `\`${table.name.replaceAll("\`", "\`\`")}\``
			: `"${table.name.replaceAll('"', '""')}"`;
		const identifier = config.engine === "mysql" && table.schema
			? `\`${table.schema.replaceAll("\`", "\`\`")}\`.${escapedName}`
			: escapedName;
		const columns = await this.describeTable(config, table.name, identifier, table.schema, selectedDatabase);
		const rows = await this.queryWithReconnect(name, (handle) => handle.query(`SELECT * FROM ${identifier} LIMIT ${safePageSize + 1} OFFSET ${offset}`), selectedDatabase);
		return {
			connection: name,
			table: requestedTable,
			columns,
			rows: rows.slice(0, safePageSize).map((row) => Object.fromEntries(
				Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
			)),
			page: safePage,
			pageSize: safePageSize,
			hasNext: rows.length > safePageSize,
		};
	}

	private getConfig(name: string): DbConnectionConfig {
		this.ensureLoadedSync(true);
		const config = this.configs.get(name);
		if (!config) throw new DbConnectionError("DB_CONNECTION_NOT_FOUND", `no database connection named "${name}"`);
		return config;
	}

	private async describeTable(config: DbConnectionConfig, table: string, identifier: string, schema?: string, selectedDatabase?: string): Promise<DbColumnSummary[]> {
		if (config.engine === "sqlite") {
			const rows = await this.queryWithReconnect(config.name, (h) => h.query(`PRAGMA table_info(${identifier})`), selectedDatabase);
			return rows.map((row) => ({ name: String(row.name), type: String(row.type ?? ""), nullable: Number(row.notnull ?? 0) !== 1, primaryKey: Number(row.pk ?? 0) > 0 }));
		}
		if (config.engine === "postgres") {
			const literal = table.replaceAll("'", "''");
			const rows = await this.queryWithReconnect(config.name, (h) => h.query(`SELECT column_name AS name, data_type AS type, is_nullable AS nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${literal}' ORDER BY ordinal_position`), selectedDatabase);
			return rows.map((row) => ({ name: String(row.name), type: String(row.type ?? ""), nullable: String(row.nullable).toUpperCase() === "YES", primaryKey: false }));
		}
		const literal = table.replaceAll("'", "''");
		const schemaFilter = schema ? `'${schema.replaceAll("'", "''")}'` : "DATABASE()";
		const rows = await this.queryWithReconnect(config.name, (h) => h.query(`SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS columnKey FROM information_schema.columns WHERE table_schema = ${schemaFilter} AND table_name = '${literal}' ORDER BY ordinal_position`), selectedDatabase);
		return rows.map((row) => ({ name: String(row.name), type: String(row.type ?? ""), nullable: String(row.nullable).toUpperCase() === "YES", primaryKey: String(row.columnKey).toUpperCase() === "PRI" }));
	}

	async connect(name: string, databaseOverride?: string): Promise<DbQueryHandle> {
		await this.ensureLoaded();
		const cached = databaseOverride ? undefined : this.handles.get(name);
		if (cached) return cached;
		const config = this.configs.get(name);
		if (!config) {
			throw new DbConnectionError(
				"DB_CONNECTION_NOT_FOUND",
				`no database connection named "${name}"`,
			);
		}
		const handle = await this.openHandle(config, databaseOverride);
		if (!databaseOverride) this.handles.set(name, handle);
		return handle;
	}

	/**
	 * Public read-only query entry point with transparent one-shot reconnect.
	 * Tools should prefer this over raw connect()+query so idle-killed
	 * sessions heal without operator intervention.
	 */
	async query(name: string, sql: string): Promise<Array<Record<string, unknown>>> {
		return this.queryWithReconnect(name, (handle) => handle.query(sql));
	}

	/** Bounded read-only query used by the Console database workbench. */
	async queryPage(
		name: string,
		sql: string,
		maxRows = 500,
		selectedDatabase?: string,
	): Promise<DbQueryPage> {
		const safeMaxRows = Number.isInteger(maxRows) ? Math.min(Math.max(maxRows, 1), 500) : 500;
		const rows = await this.queryWithReconnect(name, (handle) => handle.query(sql), selectedDatabase);
		const limited = rows.slice(0, safeMaxRows);
		const columns = limited.length > 0 ? Object.keys(limited[0] as object) : [];
		return {
			connection: name,
			sql,
			columns,
			rows: limited.map((row) => Object.fromEntries(
				Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? value.toString() : value]),
			)),
			rowCount: limited.length,
			truncated: rows.length > safeMaxRows,
		};
	}

	/** Execute one approved INSERT or UPDATE and return affected rows. */
	async executeWrite(name: string, sql: string): Promise<number> {
		assertDatabaseWriteSql(sql);
		return this.queryWithReconnect(name, (handle) => handle.run(sql));
	}

	/**
	 * Drop the cached connection for `name` (if any) so the next connect()
	 * reopens it. Callers that hold a raw handle across queries can use this
	 * after a connection-level failure to force a fresh session.
	 */
	evict(name: string): void {
		this.closeHandle(name);
	}

	/**
	 * Query through the cached connection for `name`, transparently reopening it
	 * once when the server has dropped the idle session (MySQL wait_timeout,
	 * TCP reset, pool death). Reopen uses the exact same config, so credential
	 * rules are unchanged; only connection-level failures trigger the retry.
	 */
	private async queryWithReconnect<T>(
		name: string,
		run: (handle: DbQueryHandle) => Promise<T>,
		databaseOverride?: string,
	): Promise<T> {
		const handle = await this.connect(name, databaseOverride);
		try {
			return await run(handle);
		} catch (error) {
			if (!isConnectionLossError(error)) throw error;
			// Evict the dead cached handle and reopen once with the same config.
			this.closeHandle(name);
			const reopened = await this.connect(name, databaseOverride);
			return run(reopened);
		}
	}

	private async openHandle(config: DbConnectionConfig, databaseOverride?: string): Promise<DbQueryHandle> {
		if (config.engine === "sqlite") {
			const { DatabaseSync } = await import("node:sqlite");
			try {
					// node:sqlite CREATES missing files by default — require an existing file.
			if (!existsSync(config.path as string)) {
				throw new DbConnectionError(
					"DB_ENGINE_ERROR",
					`sqlite database file does not exist: ${config.path}`,
				);
			}
			const db = new DatabaseSync(config.path as string, { timeout: 5_000, readOnly: false });
			return wrapSqlite(db);
			} catch (error) {
				if (error instanceof DbConnectionError) throw error;
				throw new DbConnectionError(
					"DB_ENGINE_ERROR",
					`sqlite failed to open ${config.path}: ${
						error instanceof Error ? error.message : String(error)
				}`,
					{ cause: error },
				);
			}
		}
		let connectionOptions: string | DbParameterConnection;
		if (config.mode === "parameters") {
			let password: string | undefined;
			if (config.passwordMode === "environment") {
				password = config.passwordEnv ? process.env[config.passwordEnv] : undefined;
				if (password === undefined) {
					throw new DbConnectionError("DB_ENV_MISSING", `password environment variable ${config.passwordEnv} for connection "${config.name}" is not set`);
				}
			} else if (config.passwordMode === "encrypted") {
				password = config.passwordRef ? await this.credentialVault.get(config.passwordRef) : undefined;
				if (password === undefined && this.legacyCredentialVault && config.passwordRef) {
					password = await this.legacyCredentialVault.get(config.passwordRef);
					if (password !== undefined) await this.credentialVault.set(config.passwordRef, password);
				}
				if (password === undefined) {
					throw new DbConnectionError("DB_ENV_MISSING", `encrypted password for connection "${config.name}" is not configured; edit the connection and enter it again`);
				}
			} else {
				password = this.runtimePasswords.get(config.name);
				if (password === undefined) {
					throw new DbConnectionError("DB_ENV_MISSING", `runtime password for connection "${config.name}" is required; edit the connection and enter it again`);
				}
			}
			connectionOptions = {
				host: config.host as string,
				port: config.port as number,
				...(databaseOverride || config.database ? { database: databaseOverride || config.database } : {}),
				user: config.username as string,
				password,
				ssl: config.ssl === true,
			};
		} else {
			const urlEnv = config.urlEnv as string;
			const dsn = process.env[urlEnv];
			if (!dsn || !dsn.trim()) {
				throw new DbConnectionError("DB_ENV_MISSING", `environment variable ${urlEnv} (DSN for connection "${config.name}") is not set`);
			}
			connectionOptions = dsn;
		}
		const moduleId = config.engine === "postgres" ? "pg" : "mysql2/promise";
		let driver: unknown;
		try {
			driver = await this.driverLoader(moduleId);
		} catch (error) {
			throw new DbConnectionError(
				"DB_ENGINE_UNAVAILABLE",
				`driver "${moduleId}" could not be loaded for connection "${config.name}"`,
				{ cause: error },
			);
		}
		try {
			if (config.engine === "postgres") {
				return await connectPostgres(driver, connectionOptions);
			}
			return await connectMysql(driver, connectionOptions);
		} catch (error) {
			if (error instanceof DbConnectionError) throw error;
			throw new DbConnectionError(
				"DB_ENGINE_ERROR",
				`${config.engine} connect failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
				{ cause: error },
			);
		}
	}

	async test(name: string): Promise<{
		ok: true;
		name: string;
		engine: DbEngine;
		elapsedMs: number;
	}> {
		const start = Date.now();
		const rows = await this.queryWithReconnect(name, (handle) => handle.query("SELECT 1 AS one"));
		if (!Array.isArray(rows) || rows.length < 1) {
			throw new DbConnectionError(
				"DB_ENGINE_ERROR",
				`connectivity probe for "${name}" returned no rows`,
			);
		}
		return {
			ok: true,
			name,
			engine: this.configs.get(name)?.engine ?? "sqlite",
			elapsedMs: Date.now() - start,
		};
	}

	dispose(): void {
		for (const handle of this.handles.values()) handle.close();
		this.handles.clear();
		this.runtimePasswords.clear();
	}
}

type DbParameterConnection = {
	host: string;
	port: number;
	database?: string;
	user: string;
	password: string;
	ssl: boolean;
};

type EncryptedCredentialDocument = { version: 1; entries: Record<string, string> };

function credentialRefFor(name: string): string {
	return "local:" + createHash("sha256").update(name).digest("hex").slice(0, 24);
}

function encryptCredentialDocument(document: EncryptedCredentialDocument, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(document), "utf8"), cipher.final()]);
	return JSON.stringify({ version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
}

function decryptCredentialDocument(serialized: string, key: Buffer): EncryptedCredentialDocument {
	const raw = JSON.parse(serialized) as { version?: number; iv?: string; tag?: string; ciphertext?: string };
	if (raw.version !== 1 || !raw.iv || !raw.tag || !raw.ciphertext) throw new Error("invalid encrypted credential document");
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(raw.iv, "base64url"));
	decipher.setAuthTag(Buffer.from(raw.tag, "base64url"));
	const plaintext = Buffer.concat([decipher.update(Buffer.from(raw.ciphertext, "base64url")), decipher.final()]);
	const document = JSON.parse(plaintext.toString("utf8")) as EncryptedCredentialDocument;
	if (document.version !== 1 || !isRecord(document.entries)) throw new Error("invalid encrypted credential entries");
	return document;
}

/** Errors that mean the underlying server session is gone and a reopen may heal it. */
function isConnectionLossError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const err = error as { code?: unknown; message?: unknown; errno?: unknown };
	const code = typeof err.code === "string" ? err.code.toUpperCase() : "";
	const message = typeof err.message === "string" ? err.message : "";
	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		code === "ETIMEDOUT" ||
		code === "ECONNREFUSED" ||
		code === "PROTOCOL_CONNECTION_LOST" ||
		code === "CONNECTION_LOST" ||
		code === "57P01" || // postgres: admin_shutdown
		code === "57P03" || // postgres: cannot_connect_now
		code === "08003" || // SQLSTATE connection_does_not_exist
		code === "08006"    // SQLSTATE connection_failure
	) {
		return true;
	}
	return /connection lost|connection (?:is )?closed|connection ended|connection terminated|server closed the connection unexpectedly|can[\'’]?t add new command when\s*connection is in closed state|closed state/i.test(message);
}

/** PostgreSQL driver adapter (`pg`). */
async function connectPostgres(
	driver: unknown,
	options: string | DbParameterConnection,
): Promise<DbQueryHandle> {
	const mod = driver as {
		default?: { Pool?: unknown };
		Pool?: unknown;
	};
	const PoolCtor = (mod?.default as { Pool?: unknown } | undefined)?.Pool ?? mod?.Pool;
	if (typeof PoolCtor !== "function") {
		throw new DbConnectionError(
			"DB_ENGINE_UNAVAILABLE",
			'installed "pg" module does not expose a Pool constructor',
		);
	}
	const poolConfig = typeof options === "string"
		? { connectionString: options }
		: { host: options.host, port: options.port, ...(options.database ? { database: options.database } : {}), user: options.user, password: options.password, ssl: options.ssl };
	const pool = new (PoolCtor as new (config: Record<string, unknown>) => {
		query(text: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
		end(): Promise<void>;
	})(poolConfig);
	return {
		async query(sql) {
			assertDatabaseReadOnlySql(sql);
			const result = await pool.query(sql);
			return result.rows;
		},
		async run(sql) {
			assertDatabaseWriteSql(sql);
			const result = await pool.query(sql);
			return result.rowCount ?? 0;
		},
		close() {
			void pool.end().catch(() => undefined);
		},
	};
}

/** MySQL driver adapter (`mysql2/promise`). */
async function connectMysql(
	driver: unknown,
	options: string | DbParameterConnection,
): Promise<DbQueryHandle> {
	const mod = driver as {
		default?: { createConnection?: unknown };
		createConnection?: unknown;
	};
	const create = (mod?.default as { createConnection?: unknown } | undefined)
		?.createConnection ?? mod?.createConnection;
	if (typeof create !== "function") {
		throw new DbConnectionError(
			"DB_ENGINE_UNAVAILABLE",
			'installed "mysql2/promise" module does not expose createConnection',
		);
	}
	const conn = await (
		create as (config: string | Record<string, unknown>) => Promise<{
			query(sql: string): Promise<[Array<Record<string, unknown>> | { affectedRows?: number }, unknown]>;
			end(): Promise<void>;
			on?(event: string, listener: (...args: unknown[]) => void): unknown;
		}>
	)(typeof options === "string" ? options : {
		host: options.host,
		port: options.port,
		...(options.database ? { database: options.database } : {}),
		user: options.user,
		password: options.password,
		...(options.ssl ? { ssl: {} } : {}),
	});
	// mysql2 emits 'error' asynchronously when the server kills an idle
	// session; without a listener that becomes an unhandled 'error' event
	// that can take the whole Console process down.
	if (typeof conn.on === "function") {
		conn.on("error", () => {
			// Swallow: the query wrapper surfaces real failures and the
			// registry reconnect logic reopens the connection on demand.
		});
	}
	return {
		async query(sql) {
			assertDatabaseReadOnlySql(sql);
			const [rows] = await conn.query(sql);
			return Array.isArray(rows) ? rows : [];
		},
		async run(sql) {
			assertDatabaseWriteSql(sql);
			const [result] = await conn.query(sql);
			if (!Array.isArray(result) && typeof result.affectedRows === "number") return result.affectedRows;
			return Array.isArray(result) ? result.length : 0;
		},
		close() {
			void conn.end().catch(() => undefined);
		},
	};
}
