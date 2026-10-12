import type { Page } from "playwright-core";
import { log } from "../log.js";
import { assertNotBlocked } from "./risk.js";

/** 导航重试配置。 */
export interface NavOptions {
  /** 总尝试次数，含首次。默认 3。 */
  attempts?: number;
  /** 单次导航超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 等页面到什么程度，默认 domcontentloaded。 */
  waitUntil?: "commit" | "domcontentloaded" | "load";
}

/** 站点偶发挂起时的默认参数。 */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 打开页面，失败自动重试。
 *
 * 为什么需要重试：小红书偶发地"接了连接但不回响应"（页面停在 about:blank、
 * 标题显示 Loading），跟代码无关、时好时坏。这种情况下傻等 60 秒没有意义——
 * 快速失败再来一次，往往第二次就通了。
 *
 * 另外统一用 domcontentloaded 而不是 load：小红书页面挂着各种长连接和埋点，
 * `load` 事件可能要等几十秒甚至永不触发，而我们要的数据在 JS 注水后才出现，
 * 用 waitForInitialState 之类的方式等更准确。
 */
export async function gotoWithRetry(page: Page, url: string, opts: NavOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitUntil = opts.waitUntil ?? "domcontentloaded";

  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      // 跳转后立刻查一次风控：被拦时重试也没用，早失败早报错
      await assertNotBlocked(page);
      return;
    } catch (err) {
      lastError = err;

      // 风控是确定性失败，重试只会加重限流，直接抛
      if (err instanceof Error && err.name === "RiskBlockedError") throw err;

      const reason = String(err instanceof Error ? err.message : err).split("\n")[0];
      if (i < attempts) {
        log.warn(`打开页面失败（第 ${i}/${attempts} 次），准备重试: ${url.slice(0, 80)} — ${reason}`);
        await page.waitForTimeout(800 * i);
      } else {
        log.error(`打开页面失败（已重试 ${attempts} 次）: ${url.slice(0, 80)} — ${reason}`);
      }
    }
  }

  const reason = String(lastError instanceof Error ? lastError.message : lastError).split("\n")[0];
  throw new Error(`页面打开失败（重试 ${attempts} 次）：${url}\n最后一次错误：${reason}`);
}
