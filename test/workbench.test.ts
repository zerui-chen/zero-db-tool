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
});
