import type { Page } from "playwright-core";
import { log } from "../log.js";

/**
 * 页面里执行的取值表达式：按路径取 __INITIAL_STATE__ 里的字段，并解开 mobx 的包装。
 *
 * 必须是**真正的函数**，不能写成字符串：`page.evaluate` 收到字符串时是当表达式求值，
 * `"(path) => {...}"` 求值出来是个函数对象、无法序列化，会直接抛错；
 * 错误一旦被吞掉，表现就是"数据明明在页面上，却一直读不到、直到超时"。
 */
function readPathInPage(path: string): string {
  const s = window.__INITIAL_STATE__;
  if (!s) return "";

  let cur: unknown = s;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur == null) return "";

  let v: unknown = cur;
  if (typeof cur === "object") {
    const o = cur as { value?: unknown; _value?: unknown };
    if (o.value !== undefined) v = o.value;
    else if (o._value !== undefined) v = o._value;
  }

  try {
    return JSON.stringify(v);
  } catch {
    // 循环引用等无法序列化的情况：当作没读到，外层会重试
    return "";
  }
}

/** 判断 __INITIAL_STATE__ 是否已注水。 */
export async function waitForInitialState(page: Page, timeoutMs = 15_000): Promise<boolean> {
  try {
    await page.waitForFunction("() => window.__INITIAL_STATE__ !== undefined", undefined, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮询读取 __INITIAL_STATE__ 里的某个路径。
 *
 * 列表页注水有快慢，固定 sleep 会偶发读空，所以这里按间隔轮询直到拿到值。
 */
export async function readStateAt<T>(page: Page, path: string, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = (await page.evaluate(readPathInPage, path)) as string;
    } catch {
      raw = "";
    }

    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    }

    await page.waitForTimeout(300);
  }

  // 读不到要说出来：静默返回 undefined 会让人以为是"页面没有数据"，
  // 实际多半是路径写错、或该字段含环形引用序列化不了。
  log.warn(`读取 ${path} 超时（${Math.round(timeoutMs / 1000)}s 内没拿到值）`);
  return undefined;
}

/**
 * 读一个数组字段，直到拿到**非空**数组。
 *
 * 列表页注水是分步的：`search.feeds` / `feed.feeds` 会先作为空数组存在，
 * 数据随后才填进去。直接用 readStateAt 读到 `[]` 就返回，调用方会误判成
 * "没有搜索结果"。这里把空数组当作"还没到"，继续轮询。
 *
 * 超时后返回最后一次读到的值（可能是空数组），由调用方决定怎么处理。
 */
export async function readStateArray<T>(page: Page, path: string, timeoutMs = 10_000): Promise<T[] | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T[] | undefined;

  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = (await page.evaluate(readPathInPage, path)) as string;
    } catch {
      raw = "";
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          if (parsed.length > 0) return parsed as T[];
          last = parsed as T[];
        }
      } catch {
        // 解析失败就当没读到，继续等
      }
    }

    await page.waitForTimeout(300);
  }

  return last;
}

/** 直接取某个对象路径（不做 value/_value 解包），用于 noteDetailMap 这类普通对象。 */
export async function readStateMap<T>(page: Page, path: string, timeoutMs = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let raw = "";
    try {
      raw = (await page.evaluate(
        (p) => {
          const s = window.__INITIAL_STATE__;
          if (!s) return "";
          const segs = String(p).split(".");
          let cur: unknown = s;
          for (const seg of segs) {
            if (cur == null || typeof cur !== "object") return "";
            cur = (cur as Record<string, unknown>)[seg];
          }
          return cur == null ? "" : JSON.stringify(cur);
        },
        path,
      )) as string;
    } catch {
      raw = "";
    }

    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    }

    await page.waitForTimeout(300);
  }

  return undefined;
}

/** 详情页地址。 */
export function feedDetailUrl(feedId: string, xsecToken: string): string {
  return `https://www.xiaohongshu.com/explore/${encodeURIComponent(feedId)}?xsec_token=${encodeURIComponent(
    xsecToken,
  )}&xsec_source=pc_feed`;
}

/** 用户主页地址。 */
export function userProfileUrl(userId: string, xsecToken: string, tab?: string): string {
  let url = `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(
    userId,
  )}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_note`;
  if (tab && tab !== "note") url += `&tab=${encodeURIComponent(tab)}&subTab=note`;
  return url;
}

/** 搜索地址。带尾部斜杠，省掉一次 302 往返（站点会重定向到带斜杠的路径）。 */
export function searchUrl(keyword: string): string {
  const params = new URLSearchParams({ keyword, source: "web_explore_feed" });
  return `https://www.xiaohongshu.com/search_result/?${params.toString()}`;
}
