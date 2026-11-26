import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire("C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/");
const WebSocket = require("ws");
const token = readFileSync("D:/kaifawork/AIWORK/zero-db-tool/.test-token", "utf8").trim();
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
const clickExpr = async (expr) => { const c = await center(expr); if (c) { await clickAt(c.x, c.y); return true; } return false; };
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:4099/?token=" + token });
await wait(9000);
await clickExpr("[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='继续')");
await wait(300);
await clickExpr("document.querySelector('[aria-label=\"打开右侧边栏\"]')");
await wait(1200);
for (let i = 0; i < 3; i++) {
  if (await evaluate("!!document.querySelector('.dbw-app')")) break;
  await clickExpr("document.querySelector('[aria-label=\"新标签页\"]')");
  await wait(900);
  const card = await center("[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim().startsWith('数据库工作台'))");
  if (card) { await clickAt(card.x, card.y); await wait(2500); }
}
await clickExpr("document.querySelector('.dbw-connbar .ant-select')");
await wait(600);
await clickExpr("[...document.querySelectorAll('.ant-select-item-option')].find(x=>(x.innerText||'').includes('演示库'))");
await wait(3000);
await clickExpr("document.querySelector('.dbw-toolbar .ant-select')");
await wait(600);
await clickExpr("[...document.querySelectorAll('.ant-select-item-option')].find(x=>(x.innerText||'').trim()==='users')");
await wait(2200);
await clickExpr("[...document.querySelectorAll('.ant-tabs-tab')].find(x=>(x.innerText||'').includes('结构'))");
await wait(800);
await shot("preview/verify-structure2.png");
socket.close();
