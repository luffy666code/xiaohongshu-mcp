import type { ElementHandle, Locator, Page } from "playwright-core";
import { sleep } from "./delay.js";
import { sampleKeystroke } from "./profile.js";

/** 可以接收键盘输入的目标。 */
export type TypingTarget = Locator | ElementHandle<Node>;

/**
 * 逐字输入，每个字符之间的间隔独立采样。
 *
 * 用键盘逐字符而不是一次性 fill：站点靠输入事件做联想与字数校验，
 * fill 直接改 DOM 会绕过这些逻辑，标签联想就弹不出来。
 */
export async function typeInto(page: Page, target: TypingTarget, text: string): Promise<void> {
  if (!text) return;

  await target.click({ timeout: 10_000 });

  for (const ch of Array.from(text)) {
    await page.keyboard.type(ch);
    await sleep(sampleKeystroke());
  }
}

/** 全选当前输入框内容（跨平台：Windows/Linux 用 Ctrl，macOS 用 Meta）。 */
export async function selectAll(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+a");
}
