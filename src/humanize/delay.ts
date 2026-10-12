import type { Action } from "./profile.js";
import { sampleDelay } from "./profile.js";

/**
 * 按动作类型等待一段拟人的时间。
 * ctx 被取消时立即返回，不留悬空的定时器。
 */
export function delay(action: Action, signal?: AbortSignal): Promise<void> {
  const ms = sampleDelay(action);

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 固定毫秒的等待；仅在"动画必须走完"这类技术性等待里使用。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
