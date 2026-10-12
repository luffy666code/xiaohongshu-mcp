#!/usr/bin/env node
/**
 * 环境自检。
 *
 * 这里只做探测，不下载任何浏览器二进制——本项目的约定是复用部署机器上已有的浏览器。
 * 探测不到就明确报错并提示如何指定，不静默回退。
 */
import fs from "node:fs";
import { cookiesFilePath, isHeadless, profileDir, proxy, actionTimeout } from "./config.js";
import { detectBrowser } from "./browser/detect.js";
import { hostLabel } from "./browser/fingerprint.js";
import { loadSession } from "./session/cookies.js";

function line(label: string, value: string): void {
  process.stderr.write(`${label.padEnd(18)}${value}\n`);
}

function check(label: string, ok: boolean, detail: string): void {
  process.stderr.write(`${ok ? "[OK]  " : "[FAIL]"} ${label.padEnd(14)}${detail}\n`);
}

async function main(): Promise<void> {
  const launchRequested = process.argv.includes("--launch");

  process.stderr.write("\n=== xiaohongshu-mcp 环境自检 ===\n\n");
  line("运行环境", hostLabel());
  line("无头模式", String(isHeadless()));
  line("动作超时", `${actionTimeout()} ms`);
  line("代理", proxy() || "(未设置)");
  process.stderr.write("\n");

  let browserOk = true;
  try {
    const b = detectBrowser();
    check("浏览器", true, `${b.name} — ${b.executablePath}（来源: ${b.source}）`);
    if (!fs.existsSync(b.executablePath)) {
      check("可执行文件", false, "路径不存在");
      browserOk = false;
    }
  } catch (err) {
    check("浏览器", false, err instanceof Error ? err.message : String(err));
    browserOk = false;
  }

  const cookiePath = cookiesFilePath();
  const session = loadSession();
  check(
    "cookies",
    session.cookies.length > 0,
    `${cookiePath}（${session.cookies.length} 条${session.seed > 0 ? `，指纹 seed=${session.seed}` : ""}）`,
  );

  const profile = profileDir();
  check("profile 目录", fs.existsSync(profile), `${profile}${fs.existsSync(profile) ? "" : "（尚未创建）"}`);

  process.stderr.write("\n");
  if (!browserOk) {
    process.stderr.write(
      [
        "未探测到可用浏览器。处理方式（任选其一）：",
        "  1. 安装 Chrome / Edge / Chromium；",
        "  2. 设置环境变量指定路径：XHS_BROWSER_PATH=C:\\...\\chrome.exe",
        "本项目不会下载浏览器。\n",
      ].join("\n"),
    );
  }
  if (session.cookies.length === 0) {
    process.stderr.write("未找到登录态，请先调用 get_login_qrcode 扫码登录。\n");
  }

  if (launchRequested && browserOk) {
    process.stderr.write("\n尝试实际启动浏览器…\n");
    const { openBrowser } = await import("./browser/launcher.js");
    const session2 = await openBrowser();
    try {
      await session2.page.goto("https://www.xiaohongshu.com/explore", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      process.stderr.write(`启动成功，页面标题: ${await session2.page.title()}\n`);
    } finally {
      await session2.close();
    }
  }

  process.stderr.write("\n自检结束。\n");
  if (!browserOk) process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`自检失败: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
