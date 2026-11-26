/**
 * 工作台 HTTP API（挂载在 DSH webServer 的 /zero-db-tool/api 前缀），供右侧栏使用。
 * 成功 { ok: true, ... }；失败 { ok: false, error: { code, message } }。
 */
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DbConnectionError, type DbConnectionInput } from "./connections.js";
import { WorkbenchService } from "./manager.js";
import { SqlGuardError, assertWriteStatement, splitStatements } from "./sql-guard.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const WRITE_CHALLENGE_TTL_MS = 2 * 60_000;

type WriteChallenge = { connection: string; hash: string; expiresAt: number };
const pendingWrites = new Map<string, WriteChallenge>();

function sqlHash(sql: string): string {
	return createHash("sha256").update(sql.trim()).digest("hex");
}

function takeChallenge(id: string, connection: string, sql: string): void {
	const now = Date.now();
	for (const [key, value] of pendingWrites) if (value.expiresAt <= now) pendingWrites.delete(key);
	const challenge = pendingWrites.get(id);
	if (!challenge) throw new SqlGuardError("DB_CONFIRMATION_REQUIRED", "确认已过期，请重新执行 UPDATE");
	if (challenge.connection !== connection || challenge.hash !== sqlHash(sql)) {
		pendingWrites.delete(id);
		throw new SqlGuardError("DB_CONFIRMATION_REQUIRED", "确认与当前语句不匹配，请重新执行 UPDATE");
	}
	pendingWrites.delete(id);
}

export type HttpOptions = {
	trustedHosts: string[];
	version: string;
};

function isLoopbackHostname(hostname: string): boolean {
	const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function originHostPort(origin: string): { host: string; port: string } | null {
	try {
		const url = new URL(origin);
		return { host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: url.port || (url.protocol === "https:" ? "443" : "80") };
	} catch {
		return null;
	}
}

/** Host must be loopback or trusted; when Origin/Referer exists it must match. */
export function isTrustedRequest(req: IncomingMessage, trustedHosts: string[]): boolean {
	const hostHeader = req.headers.host;
	if (!hostHeader) return false;
	let host: URL;
	try { host = new URL(`http://${hostHeader}`); } catch { return false; }
	const reqHost = host.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	const trusted = Array.isArray(trustedHosts) ? trustedHosts : [];
	const hostOk = isLoopbackHostname(reqHost) || trusted.some((entry) => entry === hostHeader || entry === host.hostname || entry === host.host);
	if (!hostOk) return false;
	const origin = String(req.headers.origin ?? req.headers.referer ?? "");
	if (origin === "") return true;
	const parsed = originHostPort(origin);
	if (!parsed) return false;
	if (isLoopbackHostname(parsed.host) && isLoopbackHostname(reqHost)) {
		const reqPort = host.port || "80";
		return parsed.port === "" || parsed.port === reqPort;
	}
	return trusted.some((entry) => entry === parsed.host || entry === origin || entry === `${parsed.host}:${parsed.port}`);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(payload));
}

function statusFor(error: unknown): number {
	if (error instanceof SqlGuardError) return 400;
	if (error instanceof DbConnectionError) {
		switch (error.code) {
			case "DB_CONNECTION_NOT_FOUND": return 404;
			case "DB_INVALID_CONFIG": return 400;
			case "DB_READ_ONLY_VIOLATION": return 400;
			case "DB_PERSISTENCE_ERROR": return 500;
			default: return 502;
		}
	}
	return 500;
}

function codeFor(error: unknown): string {
	if (error instanceof SqlGuardError) return error.code;
	if (error instanceof DbConnectionError) return error.code;
	const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
	return code || "DB_ENGINE_ERROR";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new SqlGuardError("DB_INVALID_CONFIG", "request body too large");
		chunks.push(buffer);
	}
	if (size === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		throw new SqlGuardError("DB_INVALID_CONFIG", "request body is not valid JSON");
	}
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, service: WorkbenchService, options: HttpOptions): Promise<void> {
	if (!isTrustedRequest(req, options.trustedHosts)) {
		send(res, 403, { ok: false, error: { code: "FORBIDDEN", message: "untrusted request origin" } });
		return;
	}
	const rawUrl = req.url ?? "/";
	const queryIndex = rawUrl.indexOf("?");
	const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
	const query = new URLSearchParams(queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1));
	const apiIndex = rawPath.indexOf("/api/");
	const path = (apiIndex >= 0 ? rawPath.slice(apiIndex) : rawPath).replace(/\/+$/, "") || "/";
	const method = (req.method ?? "GET").toUpperCase();

	try {
		if (method === "GET" && path === "/api/version") {
			send(res, 200, { ok: true, version: options.version });
			return;
		}
		if (method === "GET" && path === "/api/health") {
			send(res, 200, { ok: true, connections: await service.health() });
			return;
		}
		if (method === "GET" && path === "/api/connections") {
			send(res, 200, { ok: true, connections: service.list() });
			return;
		}
		if (method === "POST" && path === "/api/connections") {
			const body = await readJson(req);
			const summary = await service.add(connectionInput(body));
			send(res, 200, { ok: true, connection: summary });
			return;
		}
		if (method === "GET" && path === "/api/export") {
			send(res, 200, { ok: true, document: service.exportConfig() });
			return;
		}
		if (method === "POST" && path === "/api/import") {
			const body = await readJson(req);
			const conflict = body.conflict === "overwrite" ? "overwrite" : "skip";
			const result = await service.importConfig(body.document, conflict);
			send(res, 200, { ok: true, result });
			return;
		}

		const itemMatch = /^\/api\/connections\/([^/]+)(?:\/(test|catalog|browse|query|indexes|execute))?$/.exec(path);
		if (itemMatch) {
			const name = decodeURIComponent(itemMatch[1]!);
			const action = itemMatch[2];
			if (method === "POST" && action === "test") {
				send(res, 200, { ok: true, result: await service.test(name) });
				return;
			}
			if (method === "GET" && action === "catalog") {
				const database = query.get("database") ?? undefined;
				const [databases, tables] = await Promise.all([service.listDatabases(name), service.listTables(name, database)]);
				send(res, 200, { ok: true, databases, tables });
				return;
			}
			if (method === "GET" && action === "browse") {
				const database = query.get("database") ?? undefined;
				const table = (query.get("table") ?? "").trim();
				// 同一端点：不带 table（或只有空白）返回目录，带 table 返回分页数据。
				if (table === "") {
					const [databases, tables] = await Promise.all([service.listDatabases(name), service.listTables(name, database)]);
					send(res, 200, { ok: true, databases, tables });
					return;
				}
				const page = Number(query.get("page") ?? "1");
				const pageSize = Number(query.get("pageSize") ?? "50");
				send(res, 200, { ok: true, result: await service.browse(name, table, page, pageSize, database) });
				return;
			}
			if (method === "GET" && action === "indexes") {
				const database = query.get("database") ?? undefined;
				const table = (query.get("table") ?? "").trim();
				if (table === "") throw new SqlGuardError("DB_INVALID_CONFIG", "未选择表：请先刷新表目录再选择表或视图");
				send(res, 200, { ok: true, indexes: await service.indexes(name, table, database) });
				return;
			}
			if (method === "POST" && action === "execute") {
				const body = await readJson(req);
				const sql = String(body.sql ?? "");
				const database = typeof body.database === "string" && body.database !== "" ? body.database : undefined;
				const statements = splitStatements(sql);
				if (statements.length === 0) throw new SqlGuardError("DB_INVALID_CONFIG", "sql is empty");
				// 只放行 INSERT / UPDATE；DELETE、DDL、事务等在这里就被拒绝。
				const kinds = statements.map((statement) => assertWriteStatement(statement));
				const needsApproval = kinds.includes("UPDATE");
				const confirmationId = String(body.confirmationId ?? "");
				if (needsApproval && confirmationId === "") {
					const challengeId = randomUUID();
					pendingWrites.set(challengeId, { connection: name, hash: sqlHash(sql), expiresAt: Date.now() + WRITE_CHALLENGE_TTL_MS });
					send(res, 200, { ok: true, needsConfirmation: true, challengeId, statements, kinds, database });
					return;
				}
				if (needsApproval) takeChallenge(confirmationId, name, sql);
				const result = await service.execute(name, sql, database);
				send(res, 200, { ok: true, result });
				return;
			}
			if (method === "POST" && action === "query") {
				const body = await readJson(req);
				const sql = String(body.sql ?? "");
				const maxRows = Number(body.maxRows ?? 500);
				const database = typeof body.database === "string" && body.database !== "" ? body.database : undefined;
				send(res, 200, { ok: true, result: await service.queryReadOnly(name, sql, maxRows, database) });
				return;
			}
			if (action === undefined && method === "PATCH") {
				const body = await readJson(req);
				// 页面允许改名：body.name 优先，缺省沿用 URL 里的当前名。
				const summary = await service.update(name, connectionInput({ name, ...body }));
				send(res, 200, { ok: true, connection: summary });
				return;
			}
			if (action === undefined && method === "DELETE") {
				const removed = await service.remove(name);
				if (!removed) throw new DbConnectionError("DB_CONNECTION_NOT_FOUND", `no database connection named "${name}"`);
				send(res, 200, { ok: true });
				return;
			}
		}
		send(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `unknown route ${method} ${path}` } });
	} catch (error) {
		send(res, statusFor(error), { ok: false, error: { code: codeFor(error), message: error instanceof Error ? error.message : String(error) } });
	}
}

function connectionInput(body: Record<string, unknown>): DbConnectionInput {
	const text = (key: string): string | undefined => {
		const value = body[key];
		return typeof value === "string" && value.trim() !== "" ? value : undefined;
	};
	const mode = body.mode === "url-env" ? "url-env" as const : body.mode === "parameters" ? "parameters" as const : undefined;
	const passwordMode: "runtime" | "environment" | "encrypted" | undefined = body.passwordMode === "runtime" || body.passwordMode === "environment" || body.passwordMode === "encrypted" ? body.passwordMode : undefined;
	return {
		name: String(body.name ?? ""),
		engine: (body.engine === "postgres" || body.engine === "mysql" || body.engine === "sqlite" ? body.engine : "sqlite") as "sqlite" | "postgres" | "mysql",
		...(text("path") ? { path: text("path") } : {}),
		...(mode ? { mode } : {}),
		...(text("urlEnv") ? { urlEnv: text("urlEnv") } : {}),
		...(text("host") ? { host: text("host") } : {}),
		...(typeof body.port === "number" ? { port: body.port } : {}),
		...(text("database") ? { database: text("database") } : {}),
		...(text("username") ? { username: text("username") } : {}),
		...(passwordMode ? { passwordMode } : {}),
		...(typeof body.password === "string" && body.password !== "" ? { password: body.password } : {}),
		...(text("passwordEnv") ? { passwordEnv: text("passwordEnv") } : {}),
		...(typeof body.ssl === "boolean" ? { ssl: body.ssl } : {}),
	};
}
