/**
 * zero-db-tool 插件入口：DSH 数据库工作台（连接下拉 + 对象树 + 数据/结构/SQL）。
 *
 *  - 六个模型工具：sql_query / sql_exec / sql_schema / sql_stats / sql_health / sql_connections
 *  - HTTP API 挂在 webServer 的 /zero-db-tool/api 前缀，右侧栏工作台使用
 *  - 连接与凭据落在 <Documents>/DSH/zero-db-tool（ZERO_DB_TOOL_DIR 可覆盖）
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DbConnectionRegistry } from "./connections.js";
import { handleRequest } from "./http.js";
import { WorkbenchService } from "./manager.js";
import type { PluginContext } from "./plugin-types.js";
import { registerTools } from "./tools.js";

export const inject = ["webServer", "tools", "sessions", "connection"];

const PLUGIN_ID = "zero-db-tool";
const API_PREFIX = "/zero-db-tool/api";

function resolveDataDir(): string {
	const explicit = process.env.ZERO_DB_TOOL_DIR?.trim();
	if (explicit) return path.resolve(explicit);
	const documents = process.env.USERPROFILE
		? path.join(process.env.USERPROFILE, "Documents")
		: path.join(os.homedir(), "Documents");
	return path.join(documents, "DSH", "zero-db-tool");
}

function readVersion(): string {
	try {
		const document = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
		return typeof document.version === "string" ? document.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export function apply(ctx: PluginContext): void {
	const log = ctx.logger ?? {};
	const root = resolveDataDir();
	const version = readVersion();
	const registry = new DbConnectionRegistry(root);
	const service = new WorkbenchService(registry);

	const trustedHosts = (): string[] => {
		try {
			const startup = ctx.get?.("webStartup", true) as { trustedHosts?: string[] } | undefined;
			const runtime = ctx.get?.("webRuntime", true) as { trustedHosts?: string[] } | undefined;
			return Array.isArray(startup?.trustedHosts) ? startup.trustedHosts : Array.isArray(runtime?.trustedHosts) ? runtime.trustedHosts : [];
		} catch {
			return [];
		}
	};

	const unregister = ctx.webServer?.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			const rejection = ctx.connection?.requestRejection?.(req);
			if (rejection !== undefined) {
				const response = res as { statusCode: number; setHeader: (name: string, value: string) => void; end: (body: string) => void };
				response.statusCode = rejection;
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.end(JSON.stringify({
					ok: false,
					error: {
						code: rejection === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
						message: rejection === 401 ? "browser authentication required" : "untrusted request",
					},
				}));
				return;
			}
			await handleRequest(
				req as Parameters<typeof handleRequest>[0],
				res as Parameters<typeof handleRequest>[1],
				service,
				{ trustedHosts: trustedHosts(), version },
			);
		},
	});
	ctx.effect?.(() => unregister ?? (() => {}), "db-workbench-http");

	ctx.effect?.(() => () => registry.dispose(), "db-workbench-dispose");
	registerTools(ctx, service);
	log.info?.(`[${PLUGIN_ID}] 已加载：6 个 sql_* 工具 + ${API_PREFIX}（数据目录 ${root}）`);
}
