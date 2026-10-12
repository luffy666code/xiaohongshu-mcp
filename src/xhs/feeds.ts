import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { XHS_SITE } from "../config.js";
import { readStateArray, waitForInitialState } from "./state.js";
import { onlyNotes, type Feed } from "./types.js";

/**
 * 首页推荐列表。
 *
 * 数据来自页面注入的 __INITIAL_STATE__.feed.feeds，不是接口。
 * 注水有快慢，固定等待会偶发读空，所以按间隔轮询。
 */
export async function listFeeds(page: Page): Promise<Feed[]> {
  await gotoWithRetry(page, XHS_SITE);
  await waitForInitialState(page);

  const feeds = await readStateArray<Feed>(page, "feed.feeds", 12_000);
  if (!feeds || feeds.length === 0) throw new Error("没有捕获到 feeds 数据");

  return onlyNotes(feeds);
}
