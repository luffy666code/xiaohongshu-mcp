import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { XHS_SITE } from "../config.js";
import { readStateAt, userProfileUrl, waitForInitialState } from "./state.js";
import type { Feed, UserBasicInfo, UserInteractions, UserProfileResponse } from "./types.js";

/** 个人主页的子 tab。 */
export type ProfileTab = "note" | "fav" | "liked";

/** 子 tab 在页面上的文字。 */
const TAB_LABEL: Record<string, string> = {
  note: "笔记",
  fav: "收藏",
  liked: "点赞",
};

/** 解析 tab 名，空值默认为「笔记」。 */
export function parseProfileTab(s: string): ProfileTab {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "" || v === "note" || v === "notes" || v === "笔记") return "note";
  if (v === "fav" || v === "favorites" || v === "favorite" || v === "收藏") return "fav";
  if (v === "liked" || v === "like" || v === "点赞") return "liked";
  throw new Error(`未知的主页 tab "${s}"，可选：note / fav / liked`);
}

/** 从页面状态里提取用户资料。 */
async function extract(page: Page, tab: ProfileTab): Promise<UserProfileResponse> {
  await waitForInitialState(page);

  const pageData = await readStateAt<{ interactions?: UserInteractions[]; basicInfo?: UserBasicInfo }>(
    page,
    "user.userPageData",
    10_000,
  );
  if (!pageData) throw new Error("页面状态里没有用户信息，可能未登录或页面结构已变化");

  const notesData = await readStateAt<{ notes?: Feed[][]; index?: number; query?: string }>(page, "user.notes", 10_000);
  if (!notesData) throw new Error("页面状态里没有用户笔记，可能未登录或页面结构已变化");

  // tab 不符时报错，避免把别的 tab 的内容当成结果返回
  if (notesData.query && notesData.query !== tab) {
    throw new Error(`当前 tab 为 "${notesData.query}"，与请求的 "${tab}" 不符`);
  }

  const feeds: Feed[] = [];
  const idx = notesData.index ?? 0;
  if (notesData.notes && idx >= 0 && idx < notesData.notes.length) {
    feeds.push(...(notesData.notes[idx] ?? []));
  }

  return {
    userBasicInfo: pageData.basicInfo ?? {},
    interactions: pageData.interactions ?? [],
    feeds,
  };
}

/** 切到目标子 tab。「笔记」是默认 tab，无需点击。 */
async function selectTab(page: Page, tab: ProfileTab): Promise<void> {
  if (tab === "note") return;

  const label = TAB_LABEL[tab];
  const items = page.locator(".reds-tab-item.sub-tab-list");
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const text = (await item.innerText().catch(() => "")).trim();
    if (text !== label) continue;

    await delay("before_click");
    await item.click({ timeout: 10_000 }).catch(async () => {
      await item.click({ timeout: 10_000, force: true });
    });
    await delay("after_click");
    await page.waitForTimeout(1500);
    return;
  }

  throw new Error(`未找到子 tab "${label}"`);
}

/** 打开指定用户的主页并读取。 */
export async function userProfile(
  page: Page,
  userId: string,
  xsecToken: string,
  tab: ProfileTab,
): Promise<UserProfileResponse> {
  await gotoWithRetry(page, userProfileUrl(userId, xsecToken, tab));
  await page.waitForLoadState("load").catch(() => undefined);
  return extract(page, tab);
}

/** 通过侧边栏进入「我」的主页并读取。 */
export async function myProfile(page: Page, tab: ProfileTab): Promise<UserProfileResponse> {
  await gotoWithRetry(page, `${XHS_SITE}/explore`);
  await page.waitForSelector("div#app", { timeout: 30_000 }).catch(() => undefined);

  const link = page.locator("div.main-container li.user.side-bar-component a.link-wrapper span.channel").first();
  await link.waitFor({ timeout: 15_000 }).catch(() => undefined);
  await delay("before_click");
  await link.click({ timeout: 15_000 }).catch(async () => {
    await link.click({ timeout: 15_000, force: true });
  });

  await page.waitForLoadState("load").catch(() => undefined);
  await page.waitForTimeout(1500);

  await selectTab(page, tab);
  return extract(page, tab);
}
