import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { typeInto } from "../humanize/typing.js";
import { openFeedDetail } from "./feedDetail.js";

/** 评论输入框（未激活时的占位）。 */
const SELECTOR_INPUT_BOX = "div.input-box div.content-edit span";
/** 评论输入框（激活后的可编辑段落）。 */
const SELECTOR_INPUT_FIELD = "div.input-box div.content-edit p.content-input";
/** 提交按钮。 */
const SELECTOR_SUBMIT = "div.bottom button.submit";

/** 提交后评论应出现在评论区；不出现就判定失败，避免假成功。 */
async function waitCommentRendered(page: Page, content: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const ok = await page
      .evaluate((txt) => {
        const c = document.querySelector(".comments-container");
        return c ? (c.textContent ?? "").includes(txt) : false;
      }, content)
      .catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(300);
  }

  return false;
}

/** 发表评论到笔记。 */
export async function postComment(page: Page, feedId: string, xsecToken: string, content: string): Promise<void> {
  await openFeedDetail(page, feedId, xsecToken);

  const box = await page.waitForSelector(SELECTOR_INPUT_BOX, { timeout: 10_000 }).catch(() => null);
  if (!box) throw new Error("未找到评论输入框，该帖子可能不支持评论或网页端不可访问");
  await box.click({ timeout: 10_000 });
  await delay("after_click");

  await typeInto(page, page.locator(SELECTOR_INPUT_FIELD), content);
  await delay("after_type");

  const submit = await page.waitForSelector(SELECTOR_SUBMIT, { timeout: 10_000 }).catch(() => null);
  if (!submit) throw new Error("未找到提交按钮");
  await submit.click({ timeout: 10_000 });
  await delay("after_click");

  if (!(await waitCommentRendered(page, content))) {
    throw new Error("评论未确认成功：提交后未在评论区出现（可能账号被限制或发送失败）");
  }
}

/** 在当前已渲染的评论里查找目标。 */
async function lookupComment(page: Page, commentId: string, userId: string): Promise<boolean> {
  if (commentId) {
    const found = await page.locator(`#comment-${commentId}`).count().catch(() => 0);
    if (found > 0) return true;
  }
  if (userId) {
    const found = await page.locator(`.comment-item [data-user-id="${userId}"]`).count().catch(() => 0);
    if (found > 0) return true;
  }
  return false;
}

/** 展开视野内的楼中楼，二级评论未展开时不在 DOM 里。 */
async function expandNearbyReplies(page: Page): Promise<number> {
  const buttons = page.locator(".comments-container .show-more");
  const count = await buttons.count().catch(() => 0);

  let clicked = 0;
  for (let i = 0; i < count && clicked < 3; i++) {
    const btn = buttons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
    clicked++;
  }
  return clicked;
}

/** 滚动查找目标评论。 */
async function findComment(page: Page, commentId: string, userId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let stagnant = 0;
  let lastCount = 0;

  while (Date.now() < deadline) {
    if (await lookupComment(page, commentId, userId)) return;

    if ((await expandNearbyReplies(page)) > 0) {
      await delay("reading");
      if (await lookupComment(page, commentId, userId)) return;
      continue;
    }

    const count = await page.locator(".comment-item").count().catch(() => 0);
    if (count === lastCount) {
      stagnant++;
      if (stagnant >= 6) break;
    } else {
      stagnant = 0;
      lastCount = count;
    }

    await page.mouse.wheel(0, 800).catch(() => undefined);
    await delay("between_scroll");
  }

  throw new Error(`未找到评论 (commentId: ${commentId || "-"}, userId: ${userId || "-"})`);
}

/** 回复指定评论。commentId 与 userId 至少提供一个。 */
export async function replyToComment(
  page: Page,
  feedId: string,
  xsecToken: string,
  commentId: string,
  userId: string,
  content: string,
): Promise<void> {
  await openFeedDetail(page, feedId, xsecToken);
  await page.waitForTimeout(1500);

  await findComment(page, commentId, userId);

  const target = commentId
    ? page.locator(`#comment-${commentId}`).first()
    : page.locator(`.comment-item [data-user-id="${userId}"]`).first();

  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await delay("between_scroll");

  const replyBtn = await target.locator(".right .interactions .reply").first().elementHandle().catch(() => null);
  if (!replyBtn) throw new Error("无法找到回复按钮");
  await replyBtn.click({ timeout: 10_000, force: true }).catch(async () => {
    await replyBtn.click({ timeout: 10_000 });
  });
  await delay("after_click");

  await typeInto(page, page.locator(SELECTOR_INPUT_FIELD), content);
  await delay("after_type");

  const submit = await page.waitForSelector(SELECTOR_SUBMIT, { timeout: 10_000 }).catch(() => null);
  if (!submit) throw new Error("未找到提交按钮");
  await submit.click({ timeout: 10_000 });
  await delay("after_click");

  if (!(await waitCommentRendered(page, content))) {
    throw new Error("回复未确认成功：提交后未在评论区出现（可能账号被限制或发送失败）");
  }
}
