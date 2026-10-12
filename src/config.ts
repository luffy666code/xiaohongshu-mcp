import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** 小红书站点地址。 */
export const XHS_SITE = "https://www.xiaohongshu.com";
/** 创作者中心地址，发布功能走这里。 */
export const CREATOR_SITE = "https://creator.xiaohongshu.com";
/** 发布页地址。 */
export const PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish?source=official";
/** 创作者中心首页，用来建立创作者会话。 */
export const CREATOR_HOME_URL = "https://creator.xiaohongshu.com/?source=official";

/** 小红书标题上限（中文字数/英文单词数）。 */
export const TITLE_MAX_LENGTH = 20;
/** 小红书正文上限。 */
export const CONTENT_MAX_LENGTH = 1000;
/** 单次最多携带的话题标签数。 */
export const TAGS_MAX = 10;

/** 定时发布允许的区间。 */
export const SCHEDULE_MIN_OFFSET = 60 * 60 * 1000;
export const SCHEDULE_MAX_OFFSET = 14 * 24 * 60 * 60 * 1000;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** 是否无头模式。默认无头；登录也靠二维码图片返回，不需要界面。 */
export function isHeadless(): boolean {
  const raw = env("XHS_HEADLESS");
  if (raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

/** 代理地址，支持 http/https/socks5。留空表示不启用。 */
export function proxy(): string {
  return env("XHS_PROXY");
}

/** 指纹 seed；>0 时固定指纹，0 表示每次随机。 */
export function fingerprintSeedFromEnv(): number {
  const raw = env("XHS_FP_SEED");
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 应用数据目录（绝对路径，不随 cwd 漂移）。 */
export function appDataDir(): string {
  return path.join(os.homedir(), ".xiaohongshu-mcp");
}

/**
 * cookies 文件路径。
 *
 * 为什么优先用用户目录而不是相对路径：MCP 客户端拉起 server 时的 cwd 是不确定的
 * （可能落在客户端自己的目录），用 `path.resolve("cookies.json")` 会导致
 * 登录态写到一个地方、下次读到另一个地方——表现就是"刚登录完又说没登录"。
 *
 * 优先级：显式指定 > 已存在的候选（兼容手工放置的旧文件）> 用户目录。
 */
export function cookiesFilePath(): string {
  const explicit = env("COOKIES_PATH");
  if (explicit) return path.resolve(explicit);

  const candidates = [
    path.resolve("cookies.json"),
    path.join(appDataDir(), "cookies.json"),
    path.join(os.tmpdir(), "cookies.json"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return path.join(appDataDir(), "cookies.json");
}

/**
 * 浏览器用户数据目录。用独立目录而不是本机默认 profile，
 * 避免和正在运行的 Chrome 抢锁，也不会污染用户自己的浏览器数据。
 *
 * 注意：同一个 profile 目录**不能被两个浏览器实例同时打开**，
 * 所以调用方必须保证用完即关，否则后续调用会拿不到锁。
 */
export function profileDir(): string {
  const explicit = env("XHS_PROFILE_DIR");
  if (explicit) return path.resolve(explicit);
  return path.join(appDataDir(), "profile");
}

/** 网络图片下载后的落盘目录。 */
export function imagesDir(): string {
  return path.join(os.tmpdir(), "xiaohongshu_images");
}

/** 通用超时（毫秒），给单个浏览器动作兜底。 */
export function actionTimeout(): number {
  const raw = env("XHS_TIMEOUT_MS");
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120_000;
}
