import fs from "node:fs";
import path from "node:path";
import type { Cookie } from "playwright-core";
import { cookiesFilePath } from "../config.js";
import { log } from "../log.js";

/** 会话文件（v2）结构。cookies 原样透传，不解析不重组。 */
interface SessionFileV2 {
  version: number;
  seed?: number;
  saved_at?: string;
  cookies: unknown[];
}

/** 读取结果。文件不存在或格式不对时返回空。 */
export interface LoadedSession {
  cookies: Cookie[];
  seed: number;
}

/** playwright 的 sameSite 取值。 */
type SameSite = "Strict" | "Lax" | "None";

/** 把任意来源的 cookie 记录归一化成 playwright 需要的形状。 */
function toPlaywrightCookie(raw: Record<string, unknown>): Cookie | null {
  const name = typeof raw.name === "string" ? raw.name : undefined;
  const value = typeof raw.value === "string" ? raw.value : undefined;
  const domain = typeof raw.domain === "string" ? raw.domain : undefined;
  const cookiePath = typeof raw.path === "string" ? raw.path : undefined;

  // 这四个字段缺任何一个 playwright 都会拒绝，直接丢掉这条
  if (!name || value === undefined || !domain || !cookiePath) return null;

  let expires = -1;
  const rawExpires = raw.expires;
  if (typeof rawExpires === "number" && Number.isFinite(rawExpires)) {
    expires = rawExpires > 0 ? rawExpires : -1;
  } else if (typeof rawExpires === "string") {
    const n = Number(rawExpires);
    if (Number.isFinite(n)) expires = n > 0 ? n : -1;
  }

  let sameSite: SameSite = "Lax";
  const rawSame = typeof raw.sameSite === "string" ? raw.sameSite : "";
  if (rawSame === "Strict" || rawSame === "strict") sameSite = "Strict";
  else if (rawSame === "None" || rawSame === "no_restriction" || rawSame === "none") sameSite = "None";

  return {
    name,
    value,
    domain,
    path: cookiePath,
    expires,
    httpOnly: raw.httpOnly === true,
    secure: raw.secure === true,
    sameSite,
  };
}

/** 读取会话文件。兼容 v2（带外层对象）与 v1（裸数组，Go 版老文件）。 */
export function loadSession(): LoadedSession {
  const file = cookiesFilePath();

  let data: string;
  try {
    data = fs.readFileSync(file, "utf8");
  } catch {
    return { cookies: [], seed: 0 };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    log.warn(`会话文件不是合法 JSON，按空会话处理: ${String(err)}`);
    return { cookies: [], seed: 0 };
  }

  let rawCookies: unknown[] = [];
  let seed = 0;

  if (Array.isArray(parsed)) {
    rawCookies = parsed;
  } else if (parsed && typeof parsed === "object") {
    const f = parsed as Partial<SessionFileV2>;
    if (Array.isArray(f.cookies)) rawCookies = f.cookies;
    if (typeof f.seed === "number" && f.seed > 0) seed = f.seed;
  }

  const cookies: Cookie[] = [];
  for (const item of rawCookies) {
    if (!item || typeof item !== "object") continue;
    const c = toPlaywrightCookie(item as Record<string, unknown>);
    if (c) cookies.push(c);
  }

  return { cookies, seed };
}

/** 落盘，保留文件里已有的 seed。 */
export function saveCookies(cookies: Cookie[]): void {
  write(cookies, loadSession().seed);
}

/** 只写 seed，保留已有 cookies。 */
export function saveSeed(seed: number): void {
  write(loadSession().cookies, seed);
}

/** 删除会话文件。文件不存在视为已删除。 */
export function deleteSession(): void {
  const file = cookiesFilePath();
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    throw new Error(`删除 cookies 文件失败: ${String(err)}`);
  }
}

function write(cookies: Cookie[], seed: number): void {
  const file = cookiesFilePath();

  const payload: SessionFileV2 = {
    version: 2,
    seed: seed > 0 ? seed : undefined,
    saved_at: new Date().toISOString(),
    cookies: cookies as unknown[],
  };

  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  log.info(`会话已保存: ${file}`);
}
