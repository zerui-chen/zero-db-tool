import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/");
const WebSocket = require("ws");
const token = process.argv[2];
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page");
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map(); let nextId = 0;
socket.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => socket.on("open", r));
const send = (method, params = {}) => new Promise((r) => { const id = ++nextId; pending.set(id, r); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(n, Buffer.from(s.result.data, "base64")); console.log("shot", n); };
async function clickAt(x, y) { await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }); }
const center = (expr) => evaluate(`(() => { const el=${expr}; if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:4099/?token=" + token });
await wait(8000);
await evaluate("(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续'); b&&b.click(); })()");
await wait(400);
await evaluate("(() => { const b=document.querySelector('[aria-label=\"打开右侧边栏\"]'); b&&b.click(); })()");
await wait(1200);
let rect = await center("[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim().startsWith('数据库工作台'))");
if (rect) { await clickAt(rect.x, rect.y); await wait(3000); }
await shot("preview/ui-tree.png");
// 选择连接
rect = await center("document.querySelector('.dbw-connbar .ant-select')");
console.log("select", JSON.stringify(rect));
if (rect) {
	await clickAt(rect.x, rect.y); await wait(800);
	const option = await center("[...document.querySelectorAll('.ant-select-item-option')].find(x=>(x.innerText||'').includes('demo'))");
	console.log("option", JSON.stringify(option));
	if (option) { await clickAt(option.x, option.y); await wait(3500); }
}
await shot("preview/ui-tree-loaded.png");
// 点击树里的 users
rect = await center("[...document.querySelectorAll('.ant-tree-node-content-wrapper')].find(x=>(x.innerText||'').trim()==='users')");
console.log("node", JSON.stringify(rect));
if (rect) { await clickAt(rect.x, rect.y); await wait(2500); }
await shot("preview/ui-tree-data.png");
// 结构 tab
rect = await center("[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').trim()==='结构')");
if (rect) { await clickAt(rect.x, rect.y); await wait(1000); await shot("preview/ui-tree-schema.png"); }
// 新建弹框
rect = await center("[...document.querySelectorAll('.dbw-header button')].find(x=>(x.innerText||'').includes('新建'))");
if (rect) { await clickAt(rect.x, rect.y); await wait(1000); await shot("preview/ui-tree-modal.png"); }
socket.close();
