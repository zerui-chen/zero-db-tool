import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { DatabaseConnectionsPage } from "../client/src/DatabaseConnectionsPage.js";

describe("workbench page", () => {
	it("renders the ported shell and header", () => {
		const html = renderToString(<DatabaseConnectionsPage workspaceId="dsh" />);
		expect(html).toContain("数据库工作台");
		expect(html).toContain("database-workbench-shell");
		expect(html).toContain("database-connection-rail");
		expect(html).toContain("新增连接");
	});

	it("renders the connection form when opened via props state", () => {
		const html = renderToString(<DatabaseConnectionsPage workspaceId="dsh" />);
		expect(html).not.toContain("database-connection-form");
	});
});
