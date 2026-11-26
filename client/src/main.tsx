/**
 * 右侧栏入口：antd 数据库工作台。主题令牌从宿主 --dsw-alias-* 解析。
 */
import React, { useEffect } from "react";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { AntdWorkbench } from "./AntdWorkbench";
import { isDarkTheme, opaqueColor, resolveColor } from "./theme";
import css from "./workbench.css";

const TAB_ID = "zero-db-tool";
let styleInjected = false;

function ensureStyle(): void {
	if (styleInjected || typeof document === "undefined") return;
	const node = document.createElement("style");
	node.setAttribute("data-zero-db-tool", "1");
	node.textContent = css;
	document.head.appendChild(node);
	styleInjected = true;
}

function Body(): React.JSX.Element {
	useEffect(() => { ensureStyle(); }, []);
	const dark = isDarkTheme();
	const solidBackground = opaqueColor(resolveColor("--dsw-alias-bg-base", "#ffffff"), dark ? "#1b1b1b" : "#ffffff");
	const solidLayer = opaqueColor(resolveColor("--dsw-alias-bg-layer-1", "#ffffff"), dark ? "#1b1b1b" : "#ffffff");
	useEffect(() => { document.documentElement.style.setProperty("--dbw-solid-bg", solidBackground); }, [solidBackground]);
	const token = {
		colorPrimary: resolveColor("--dsw-alias-button-primary-fill", "#1677ff"),
		colorInfo: resolveColor("--dsw-alias-state-business-primary", "#1677ff"),
		colorBgBase: solidBackground,
		colorBgContainer: solidLayer,
		colorBgElevated: solidLayer,
		colorText: resolveColor("--dsw-alias-label-primary", "#1a1a1a"),
		colorTextSecondary: resolveColor("--dsw-alias-label-secondary", "#6b7280"),
		colorBorder: resolveColor("--dsw-alias-border-l3", "#d9d9d9"),
		colorBorderSecondary: resolveColor("--dsw-alias-border-l1", "#e5e7eb"),
		borderRadius: 8,
		fontSize: 12,
		controlHeightSM: 24,
	};
	return (
		<ConfigProvider
			locale={zhCN}
			theme={{ algorithm: [dark ? theme.darkAlgorithm : theme.defaultAlgorithm, theme.compactAlgorithm], token }}
		>
			<AntdApp>
				<div className="dbw-host">
					<AntdWorkbench />
				</div>
			</AntdApp>
		</ConfigProvider>
	);
}

function Title(): React.JSX.Element {
	return <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>数据库</span>;
}

export const inject = ["slots", "sidebarRightTabs"];

export function apply(ctx: {
	effect: (fn: () => unknown, label?: string) => void;
	sidebarRightTabs: { register: (definition: unknown) => unknown };
	slots: { inject: (name: string, fn: () => unknown) => unknown; register: (options: { name: string; key: string }, component: unknown) => unknown };
}): void {
	ctx.effect(() => ctx.sidebarRightTabs.register({
		id: TAB_ID,
		kind: TAB_ID,
		keepMounted: true,
		priority: "extension",
		title: () => "数据库",
		guide: [{
			id: TAB_ID,
			order: 46,
			title: () => "数据库工作台",
			description: () => "连接管理、表浏览与只读 SQL",
		}],
	}), "zero-db-tool: register tab type");

	ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () =>
		ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, Body)), "zero-db-tool: register tab body");

	ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () =>
		ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: TAB_ID }, Title)), "zero-db-tool: register tab title");
}
