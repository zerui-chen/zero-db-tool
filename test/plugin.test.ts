import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(os.tmpdir(), "zero-db-tool-plugin-"));
process.env.ZERO_DB_TOOL_DIR = dir;
const plugin = await import("../dist/index.js");

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("plugin entry", () => {
	it("declares the host services it needs", () => {
		expect(plugin.inject).toEqual(["webServer", "tools", "sessions", "connection"]);
	});

	it("registers six tools, one HTTP route and clean disposers", () => {
		const tools: Array<{ name: string; parameters: unknown; output: unknown; execute: unknown }> = [];
		const routes: Array<{ kind: string; path: string }> = [];
		const disposers: Array<() => void> = [];
		const ctx = {
			tools: { register: (tool: never) => tools.push(tool) },
			webServer: { register: (options: never) => { routes.push(options); return () => { disposers.push(() => {}); }; } },
			sessions: { get: () => undefined },
			connection: { requestRejection: () => undefined },
			get: () => undefined,
			effect: (fn: () => unknown) => { const value = fn(); if (typeof value === "function") disposers.push(value as () => void); },
			logger: {},
		};
		plugin.apply(ctx as never);
		expect(tools.map((tool) => tool.name)).toEqual([
			"sql_query", "sql_exec", "sql_schema", "sql_stats", "sql_health", "sql_connections",
		]);
		for (const tool of tools) {
			expect(tool.parameters).toMatchObject({ type: "object" });
			expect(tool.output).toMatchObject({ schema: { type: "object" } });
		}
		expect(routes[0]).toMatchObject({ kind: "prefix", path: "/zero-db-tool/api" });
		expect(disposers.length).toBeGreaterThanOrEqual(2);
		for (const dispose of disposers) dispose();
	});

	it("fails closed when the question gate is missing", async () => {
		const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<{ text: string; isError?: boolean }> }> = [];
		const ctx = {
			tools: { register: (tool: never) => tools.push(tool) },
			webServer: { register: () => () => {} },
			sessions: { get: () => undefined },
			connection: { requestRejection: () => undefined },
			get: () => undefined,
			effect: (fn: () => unknown) => { fn(); },
			logger: {},
		};
		plugin.apply(ctx as never);
		const execTool = tools.find((tool) => tool.name === "sql_exec")!;
		const result = await execTool.execute({ connection: "missing", sql: "UPDATE t SET a = 1" }, { agent: {} });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("DB_CONFIRMATION_REQUIRED");
	});
});
