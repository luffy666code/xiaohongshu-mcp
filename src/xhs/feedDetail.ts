import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { feedDetailUrl, readStateMap } from "./state.js";
import type { CommentLoadConfig, FeedDetailResponse } from "./types.js";

/** 详情页已出结果的判据：正常笔记容器，或各类错误容器。 */
const READY_SELECTOR =
  ".interact-container, .note-scroller, .access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper";

/** 笔记不可访问时页面会给出的提示词。 */
const BLOCKED_KEYWORDS = [
  "当前笔记暂时无法浏览",
  "该内容因违规已被删除",
  "该笔记已被删除",
  "内容不存在",
  "笔记不存在",
  "已失效",
  "私密笔记",
  "仅作者可见",
  "因用户设置，你无法查看",
  "因违规无法查看",
];

/** 等待详情页可用：等关键容器出现即可，不要求整页静止。 */
export async function waitFeedPageReady(page: Page): Promise<void> {
  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForSelector(READY_SELECTOR, { timeout: 8_000 }).catch(() => undefined);
}

/** 笔记不可访问时抛错，避免把错误页当成有效数据返回。 */
export async function checkPageAccessible(page: Page): Promise<void> {
  await page.waitForTimeout(500);

  const wrapper = await page
    .waitForSelector(".access-wrapper, .error-wrapper, .not-found-wrapper, .blocked-wrapper", { timeout: 2_000 })
    .catch(() => null);
  if (!wrapper) return;

  const text = (await wrapper.innerText().catch(() => "")).trim();
  if (!text) return;

  for (const kw of BLOCKED_KEYWORDS) {
    if (text.includes(kw)) throw new Error(`笔记不可访问: ${kw}`);
  }

  throw new Error(`笔记不可访问: ${text}`);
}

/** 打开详情页并做可访问性检查。 */
export async function openFeedDetail(page: Page, feedId: string, xsecToken: string): Promise<void> {
  await gotoWithRetry(page, feedDetailUrl(feedId, xsecToken));
  await waitFeedPageReady(page);
  await delay("after_navigate");
  await checkPageAccessible(page);
}

/** 当前已渲染的一级评论数。 */
async function commentCount(page: Page): Promise<number> {
  return page.locator(".comments-container .parent-comment").count().catch(() => 0);
}

/** 评论列表是否已经到底。 */
async function atCommentsEnd(page: Page): Promise<boolean> {
  return page
    .locator(".comments-container .end-container")
    .first()
    .isVisible()
    .catch(() => false);
}

/** 展开视野内的楼中楼。返回实际点到的数量。 */
async function expandReplies(page: Page, threshold: number): Promise<number> {
  const buttons = page.locator(".comments-container .show-more, .comments-container .reply-container");
  const count = await buttons.count();
  if (count === 0) return 0;

  let clicked = 0;
  for (let i = 0; i < count && clicked < 3; i++) {
    const btn = buttons.nth(i);
    const text = (await btn.innerText().catch(() => "")).trim();
    if (!text.includes("展开") || !text.includes("回复")) continue;

    // 回复数过多的跳过，避免一次点开几百条
    const m = text.match(/(\d+)/);
    if (m?.[1] && threshold > 0 && Number(m[1]) > threshold) continue;

    if (!(await btn.isVisible().catch(() => false))) continue;
    await btn.click({ timeout: 3_000, noWaitAfter: true }).catch(() => undefined);
    clicked++;
  }

  return clicked;
}

/** 在评论区滚动一屏。 */
async function scrollComments(page: Page, speed: string): Promise<void> {
  const ratio = speed === "fast" ? 0.9 : speed === "slow" ? 0.35 : 0.6;
  const height = await page.evaluate(() => window.innerHeight).catch(() => 800);
  const delta = Math.round(height * ratio * (0.85 + Math.random() * 0.3));
  await page.mouse.wheel(0, delta).catch(() => undefined);
}

/**
 * 滚动加载更多评论。
 *
 * 有停滞检测：评论数连续多轮不涨就停，避免在没有更多评论的帖子上空转。
 * 加载失败不抛错——详情本身比评论重要，缺评论不该让整个调用失败。
 */
async function loadAllComments(page: Page, config: CommentLoadConfig): Promise<void> {
  const target = config.maxCommentItems > 0 ? config.maxCommentItems : 20;
  const deadline = Date.now() + 3 * 60 * 1000;

  let last = 0;
  let stagnant = 0;

  while (Date.now() < deadline) {
    const count = await commentCount(page);
    if (count >= target) return;

    if (config.clickMoreReplies) {
      const clicked = await expandReplies(page, config.maxRepliesThreshold);
      if (clicked > 0) {
        await page.waitForTimeout(800);
        continue;
      }
    }

    if (await atCommentsEnd(page)) return;

    await scrollComments(page, config.scrollSpeed);
    await delay("between_scroll");

    if (count === last) {
      stagnant++;
      if (stagnant >= 10) return;
    } else {
      stagnant = 0;
    }
    last = count;
  }
}

/** 读取笔记详情（含评论）。 */
export async function getFeedDetail(
  page: Page,
  feedId: string,
  xsecToken: string,
  loadAll: boolean,
  config: CommentLoadConfig,
): Promise<FeedDetailResponse> {
  await openFeedDetail(page, feedId, xsecToken);

  if (loadAll) await loadAllComments(page, config);

  const detail = await readStateMap<FeedDetailResponse>(page, `note.noteDetailMap.${feedId}`, 10_000);
  if (!detail) throw new Error("没有捕获到 feed 详情数据");

  return detail;
}
