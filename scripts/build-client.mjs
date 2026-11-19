#!/usr/bin/env node
/**
 * 把 client/src 下的 TSX 与样式打成 DSH 需要的单文件 IIFE 模块。
 * 产物 client/client.js 与 dsh-db-tool 的发布形态一致：window.__ModuleLoader__.load + factory(require)。
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

const result = await build({
	entryPoints: ["client/src/main.tsx"],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "browser",
	target: ["es2020"],
	external: ["react"],
	loader: { ".css": "text" },
	jsxFactory: "React.createElement",
	jsxFragment: "React.Fragment",
	logLevel: "warning",
	minify: true,
	legalComments: "none",
});

const code = result.outputFiles[0].text;
const wrapped = [
	"/* zero-db-tool 客户端产物：由 scripts/build-client.mjs 生成，勿手改。 */",
	"window.__ModuleLoader__.load({",
	'\tid: "zero-db-tool",',
	"\tfactory: (require) => {",
	"\t\tvar module = { exports: {} };",
	"\t\tvar exports = module.exports;",
	code.split("\n").map((line) => "\t\t" + line).join("\n"),
	"\t\treturn module.exports;",
	"\t},",
	"});",
	"",
].join("\n");

await mkdir("client", { recursive: true });
await writeFile("client/client.js", wrapped);
console.log("client/client.js written:", wrapped.length, "bytes");