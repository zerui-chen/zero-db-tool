import React from "react";
import { createRoot } from "react-dom/client";
import baseCss from "../client/src/base.css";
import fixesCss from "../client/src/theme-fixes.css";
import workbenchCss from "../client/src/database-workbench.css";
import { DatabaseConnectionsPage } from "../client/src/DatabaseConnectionsPage";

const CSS = baseCss + "\n" + workbenchCss + "\n" + fixesCss;
const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

const params = new URLSearchParams(location.search);
const dark = params.get("scheme") === "dark";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
if (dark) {
	// 模拟 DSH 深色主题的 --dsw-alias-* 令牌，验证弹窗与表格在深色下仍不透明。
	const host = document.body.style;
	host.setProperty("--dsw-alias-bg-layer-1", "#1f1f1f");
	host.setProperty("--dsw-alias-bg-layer-2", "#2a2a2a");
	host.setProperty("--dsw-alias-label-primary", "#ececec");
	host.setProperty("--dsw-alias-label-secondary", "#a0a0a0");
	host.setProperty("--dsw-alias-border-l1", "#383838");
	host.setProperty("--dsw-alias-border-l3", "#4a4a4a");
	host.setProperty("--dsw-alias-state-business-primary", "#6ec6a8");
	host.setProperty("--dsw-alias-state-business-tertiary", "#8ad7bb");
	host.setProperty("--dsw-alias-state-success-primary", "#5fbf8a");
	host.setProperty("--dsw-alias-state-error-primary", "#e06c5f");
	host.setProperty("--dsw-alias-state-warn-primary", "#d9a05b");
	host.setProperty("--dsw-alias-state-warn-secondary", "#e8b273");
	host.setProperty("--dsw-alias-interactive-bg-hover", "#2f2f2f");
}

const connection = { name: "demo", engine: "sqlite", path: "D:\\data\\demo.db", createdAt: new Date().toISOString() };
const tablePage = {
	connection: "demo", table: "users", page: 1, pageSize: 50, hasNext: false,
	columns: [{ name: "id", type: "INTEGER", nullable: false, primaryKey: true }, { name: "name", type: "TEXT", nullable: false, primaryKey: false }],
	rows: [{ id: 1, name: "ada" }, { id: 2, name: "lin" }],
};

window.fetch = async (input: RequestInfo | URL) => {
	const url = String(input);
	const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
	if (url.includes("/browse") && !url.includes("table=")) return json({ ok: true, databases: ["main"], tables: [{ name: "users", type: "table" }] });
	if (url.includes("/browse")) return json({ ok: true, result: tablePage });
	if (url.includes("/catalog")) return json({ ok: true, databases: ["main"], tables: [{ name: "users", type: "table" }] });
	if (url.endsWith("/test")) return json({ ok: true, result: { elapsedMs: 3 } });
	if (url.includes("/query")) return json({ ok: true, result: { connection: "demo", columns: ["n"], rows: [{ n: 1 }], rowCount: 1, truncated: false } });
	if (url.endsWith("/connections")) return json({ ok: true, connections: [connection] });
	return json({ ok: true });
};

const width = Number(params.get("width") ?? "420");
const root = createRoot(document.getElementById("root")!);
root.render(
	<div className="dbw-scope" style={{ width, height: "100%", borderRight: "1px solid #8884", boxSizing: "border-box" }}>
		<DatabaseConnectionsPage workspaceId="dsh" />
	</div>,
);

setTimeout(() => {
	if (params.get("modal") === "1") {
		const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("新增连接"));
		button?.click();
		return;
	}
	if (params.get("select") === "1") {
		const card = document.querySelector<HTMLElement>(".database-connection-card, .database-connection-rail li, .database-connection-rail button");
		card?.click();
		setTimeout(() => {
			if (params.get("tab") === "sql") {
				const tab = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "SQL 查询");
				tab?.click();
			}
		}, 400);
	}
}, 80);