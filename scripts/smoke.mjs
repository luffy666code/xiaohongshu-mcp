#!/usr/bin/env node
/**
 * stdio 冒烟测试。
 *
 * 起一个真实进程走 MCP 握手（initialize → notifications/initialized → tools/list），
 * 校验 18 个工具都注册上了，再挑一个只读工具确认错误路径不会把进程打死。
 *
 * 不碰真实站点，不需要登录态。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");

if (!fs.existsSync(entry)) {
  console.error("dist/index.js 不存在，请先执行 npm run build");
  process.exit(1);
}

const EXPECTED_TOOLS = [
  "check_login_status",
  "get_login_qrcode",
  "delete_cookies",
  "publish_content",
  "list_feeds",
  "search_feeds",
  "get_feed_detail",
  "user_profile",
  "post_comment_to_feed",
  "reply_comment_in_feed",
  "publish_with_video",
  "like_feed",
  "favorite_feed",
  "get_my_profile",
  "get_unread_count",
  "list_notifications",
  "reply_notification",
  "like_notification",
];

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, XHS_DEBUG: "1" },
});

let stderrLog = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrLog += chunk;
});

const pending = new Map();
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let seq = 0;

function request(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 30_000);

    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function fail(msg) {
  console.error(`\n[FAIL] ${msg}`);
  if (stderrLog.trim()) console.error(`--- server stderr ---\n${stderrLog.trim()}`);
  child.kill("SIGKILL");
  process.exit(1);
}

function pass(msg) {
  console.log(`[OK]   ${msg}`);
}

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "1.0.0" },
});

if (init.error) fail(`initialize 返回错误: ${JSON.stringify(init.error)}`);
pass(`initialize 成功: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);

notify("notifications/initialized", {});

const list = await request("tools/list", {});
if (list.error) fail(`tools/list 返回错误: ${JSON.stringify(list.error)}`);

const names = (list.result?.tools ?? []).map((t) => t.name);
const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED_TOOLS.includes(n));

if (missing.length > 0) fail(`缺少工具: ${missing.join(", ")}`);
pass(`tools/list 返回 ${names.length} 个工具，18 个预期工具齐全`);
if (extra.length > 0) console.log(`       其余工具: ${extra.join(", ")}`);

// 每个工具都得有 inputSchema，否则客户端无法构造参数
const noSchema = (list.result?.tools ?? []).filter((t) => !t.inputSchema);
if (noSchema.length > 0) fail(`以下工具缺少 inputSchema: ${noSchema.map((t) => t.name).join(", ")}`);
pass("所有工具都带 inputSchema");

// 参数校验应当在不打开浏览器的情况下就报错，不应该把进程拖死
const bad = await request("tools/call", {
  name: "get_feed_detail",
  arguments: { feed_id: "", xsec_token: "" },
});
if (!bad.result?.isError) fail("get_feed_detail 传空参数时应返回 isError");
pass(`参数校验生效: ${bad.result?.content?.[0]?.text}`);

child.stdin.end();
await Promise.race([
  new Promise((r) => child.on("exit", r)),
  new Promise((r) => setTimeout(r, 3000)),
]);
child.kill("SIGKILL");

console.log("\n冒烟测试通过。");
process.exit(0);
