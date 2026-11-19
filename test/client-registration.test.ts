// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";

type Registered = { id?: string; kind?: string; guide?: unknown[]; keepMounted?: boolean };

function loadClient() {
	const source = readFileSync(path.join(process.cwd(), "client", "client.js"), "utf8");
	const registrations: { tabs: Registered[]; slots: Array<{ name: string; key: string }> } = { tabs: [], slots: [] };
	let pluginExports: { inject: string[]; apply: (ctx: unknown) => void } | undefined;
	const host = window as unknown as { __ModuleLoader__?: unknown };
	host.__ModuleLoader__ = {
		load: (entry: { id: string; factory: (require: (id: string) => unknown) => unknown }) => {
			pluginExports = entry.factory((id: string) => (id === "react" ? React : {})) as typeof pluginExports;
		},
	};
	// eslint-disable-next-line no-new-func
	new Function(source)();
	const ctx = {
		effect: (fn: () => unknown) => fn(),
		sidebarRightTabs: { register: (definition: Registered) => { registrations.tabs.push(definition); return () => {}; }, get: () => undefined },
		slots: {
			inject: (_name: string, fn: () => unknown) => fn(),
			register: (options: { name: string; key: string }, _component: unknown) => { registrations.slots.push(options); return () => {}; },
		},
	};
	pluginExports!.apply(ctx);
	return { exports: pluginExports!, registrations };
}

describe("client registration", () => {
	it("injects the sidebar and slot services", () => {
		const { exports } = loadClient();
		expect(exports.inject).toEqual(["slots", "sidebarRightTabs"]);
	});

	it("registers one tab type plus body and title slots", () => {
		const { registrations } = loadClient();
		expect(registrations.tabs).toHaveLength(1);
		expect(registrations.tabs[0]).toMatchObject({ id: "zero-db-tool", kind: "zero-db-tool", keepMounted: true });
		expect(Array.isArray(registrations.tabs[0]!.guide)).toBe(true);
		expect(registrations.slots).toEqual([
			{ name: "sidebar.right.pane.tab", key: "zero-db-tool" },
			{ name: "sidebar.right.pane.tab.title", key: "zero-db-tool" },
		]);
	});
});
