import { build } from "esbuild";
await build({
	entryPoints: ["preview/entry.tsx"],
	outfile: "preview/bundle.js",
	bundle: true,
	format: "iife",
	platform: "browser",
	target: ["es2020"],
	loader: { ".css": "text" },
	jsxFactory: "React.createElement",
	jsxFragment: "React.Fragment",
	define: { "process.env.NODE_ENV": '"development"' },
	logLevel: "warning",
});
console.log("preview bundle written");
