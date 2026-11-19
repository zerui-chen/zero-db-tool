import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import { App as AntdApp, ConfigProvider } from "antd";
import { AntdWorkbench } from "../client/src/AntdWorkbench.js";

describe("antd workbench", () => {
	it("renders the shell and header", () => {
		const html = renderToString(
			<ConfigProvider>
				<AntdApp>
					<AntdWorkbench />
				</AntdApp>
			</ConfigProvider>,
		);
		expect(html).toContain("数据库工作台");
		expect(html).toContain("新建");
		expect(html).toContain("ant-card");
	});
});
