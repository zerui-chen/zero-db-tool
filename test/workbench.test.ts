import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DbConnectionRegistry } from "../src/connections.js";
import { handleRequest } from "../src/http.js";
import { WorkbenchService } from "../src/manager.js";

let root = "";
let databaseFile = "";
let registry: DbConnectionRegistry;
let service: WorkbenchService;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "zero-db-tool-"));
	databaseFile = path.join(root, "app.db");
	const db = new DatabaseSync(databaseFile);
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
	db.exec("CREATE INDEX idx_users_name ON users(name)");
	db.exec("INSERT INTO users (name) VALUES ('ada'), ('lin')");
	db.close();
	registry = new DbConnectionRegistry(path.join(root, "config"));
	service = new WorkbenchService(registry);
	await registry.add({ name: "main", engine: "sqlite", path: databaseFile });
});

afterEach(async () => {
	registry.dispose();
	await rm(root, { recursive: true, force: true });
});

describe("connection registry", () => {
	it("persists connections and never returns secrets", async () => {
		const listed = registry.list();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("main");
		expect(JSON.stringify(listed)).not.toContain("password");
	});

	it("keeps a stable order after updating a connection", async () => {
		await registry.add({ name: "second", engine: "sqlite", path: databaseFile });
		const before = registry.list().map((item) => item.name);
		await registry.update("main", { name: "main", engine: "sqlite", path: databaseFile });
		expect(registry.list().map((item) => item.name)).toEqual(before);
	});

	it("reports a health probe", async () => {
		const health = await service.health();
		expect(health[0]?.ok).toBe(true);
	});
});

describe("queries", () => {
	it("runs a read-only query with columns and JSON-safe rows", async () => {
		const result = await service.query("main", "SELECT id, name FROM users ORDER BY id");
		expect(result.columns).toEqual(["id", "name"]);
		expect(result.rowCount).toBe(2);
	});

	it("rejects writes through the read path", async () => {
		await expect(service.query("main", "DELETE FROM users")).rejects.toThrow(/not read-only/);
	});

	it("executes INSERTs and asks nothing for them", async () => {
		const result = await service.execute("main", "INSERT INTO users (name) VALUES ('new')");
		expect(result.affectedRows).toBe(1);
		expect(service.needsApproval("INSERT INTO users (name) VALUES ('x')")).toBe(false);
	});

	it("reopens once when the mysql driver reports a closed connection", async () => {
		let attempts = 0;
		const handle = {
			query: async () => {
				attempts += 1;
				if (attempts === 1) {
					throw Object.assign(new Error("Can't add new command when connection is in closed state"), { code: "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR" });
				}
				return [{ n: 1 }];
			},
			run: async () => 0,
			close: async () => undefined,
		};
		const fakeRegistry = {
			connect: async () => handle,
			evict: () => undefined,
		};
		const fakeService = new WorkbenchService(fakeRegistry as unknown as DbConnectionRegistry);
		const result = await fakeService.query("main", "SELECT 1 AS n");
		expect(attempts).toBe(2);
		expect(result.rows[0]).toEqual({ n: 1 });
	});

	it("flags UPDATE batches for approval", () => {
		expect(service.needsApproval("UPDATE users SET name = 'x'")).toBe(true);
		expect(service.needsApproval("INSERT INTO users (name) VALUES ('a'); UPDATE users SET name = 'b'")).toBe(true);
	});
});

describe("browse and schema", () => {
	it("lists tables and describes columns", async () => {
		const tables = await service.listTables("main");
		expect(tables.map((table) => table.name)).toContain("users");
		const schema = await service.schema("main", "users");
		expect("columns" in schema && schema.columns.map((column) => column.name)).toEqual(["id", "name"]);
	});

	it("pages table rows", async () => {
		const page = await service.browse("main", "users", 1, 1);
		expect(page.rows).toHaveLength(1);
		expect(page.hasNext).toBe(true);
	});

	it("lists indexes with columns and uniqueness", async () => {
		const indexes = await service.indexes("main", "users");
		const nameIndex = indexes.find((index) => index.name === "idx_users_name");
		expect(nameIndex?.columns).toEqual(["name"]);
		expect(nameIndex?.unique).toBe(false);
	});

	it("counts rows per table", async () => {
		const stats = await service.stats("main");
		expect(stats.tableCount).toBe(1);
		expect(stats.tables.users).toBe(2);
	});
});

describe("http api", () => {
	it("serves connections over a loopback server and rejects a foreign Host", async () => {
		const server = createServer((req, res) => {
			void handleRequest(req, res, service, { trustedHosts: [], version: "0.1.0" });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const ok = await fetch(`http://127.0.0.1:${port}/zero-db-tool/api/connections`);
			expect(ok.status).toBe(200);
			const payload = await ok.json() as { ok: boolean; connections: unknown[] };
			expect(payload.ok).toBe(true);
			expect(payload.connections).toHaveLength(1);

			// 同一个 browse 端点：不带 table 是目录，带 table 是分页数据。
			const catalog = await (await fetch(`http://127.0.0.1:${port}/zero-db-tool/api/connections/main/browse`)).json() as { tables: Array<{ name: string }> };
			expect(catalog.tables.map((table) => table.name)).toContain("users");

			// 回归：table= 为空也必须走目录分支，不能落到 browseTable(name, "")。
			for (const query of ["?table=", "?table=%20", "?table=&page=1"]) {
				const empty = await fetch(`http://127.0.0.1:${port}/zero-db-tool/api/connections/main/browse${query}`);
				expect(empty.status).toBe(200);
				const payload = await empty.json() as { ok: boolean; tables?: Array<{ name: string }>; error?: { message?: string } };
				expect(payload.ok).toBe(true);
				expect(payload.tables?.map((table) => table.name)).toContain("users");
			}
			const pageResponse = await (await fetch(`http://127.0.0.1:${port}/zero-db-tool/api/connections/main/browse?table=users&page=1&pageSize=1`)).json() as { result: { rows: unknown[]; hasNext: boolean } };
			expect(pageResponse.result.rows).toHaveLength(1);
			expect(pageResponse.result.hasNext).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("allows INSERT, challenges UPDATE once, and refuses DELETE", async () => {
		const server = createServer((req, res) => {
			void handleRequest(req, res, service, { trustedHosts: [], version: "0.1.0" });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const endpoint = `http://127.0.0.1:${port}/zero-db-tool/api/connections/main/execute`;
		const post = (body: Record<string, unknown>) => fetch(endpoint, {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
		});
		try {
			const insert = await post({ sql: "INSERT INTO users (name) VALUES ('new')" });
			expect(insert.status).toBe(200);
			const insertPayload = await insert.json() as { ok: boolean; result?: { affectedRows: number } };
			expect(insertPayload.result?.affectedRows).toBe(1);

			const deleted = await post({ sql: "DELETE FROM users" });
			expect(deleted.status).toBe(400);
			const deletedPayload = await deleted.json() as { ok: boolean; error?: { code?: string } };
			expect(deletedPayload.ok).toBe(false);
			expect(deletedPayload.error?.code).toBe("DB_READ_ONLY_VIOLATION");

			const update = await post({ sql: "UPDATE users SET name = 'renamed' WHERE id = 1" });
			const updatePayload = await update.json() as { ok: boolean; needsConfirmation?: boolean; challengeId?: string };
			expect(updatePayload.needsConfirmation).toBe(true);
			expect(typeof updatePayload.challengeId).toBe("string");

			const confirmed = await post({ sql: "UPDATE users SET name = 'renamed' WHERE id = 1", confirmationId: updatePayload.challengeId });
			const confirmedPayload = await confirmed.json() as { ok: boolean; result?: { affectedRows: number } };
			expect(confirmedPayload.result?.affectedRows).toBe(1);

			const replay = await post({ sql: "UPDATE users SET name = 'renamed' WHERE id = 1", confirmationId: updatePayload.challengeId });
			expect(replay.status).toBe(400);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
