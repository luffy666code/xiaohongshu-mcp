import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { openFeedDetail } from "./feedDetail.js";
import { readStateMap } from "./state.js";

/** 点赞按钮。 */
const SELECTOR_LIKE = ".interact-container .left .like-lottie";
/** 收藏按钮。 */
const SELECTOR_COLLECT = ".interact-container .left .reds-icon.collect-icon";

interface InteractState {
  liked: boolean;
  collected: boolean;
}

/** 从页面状态里读点赞/收藏状态。 */
export async function getInteractState(page: Page, feedId: string): Promise<InteractState> {
  const detail = await readStateMap<{
    note?: { interactInfo?: { liked?: boolean; collected?: boolean } };
  }>(page, `note.noteDetailMap.${feedId}`, 8_000);

  if (!detail?.note?.interactInfo) throw new Error("没有捕获到 feed 详情数据");

  return {
    liked: detail.note.interactInfo.liked === true,
    collected: detail.note.interactInfo.collected === true,
  };
}

/**
 * 点赞/收藏或取消，带状态校验。
 *
 * 点击后必须轮询到目标状态才算成功，最多点两次——
 * 消除"点了没报错就算成功"的假阳性。
 */
export async function toggleInteract(
  page: Page,
  feedId: string,
  xsecToken: string,
  kind: "like" | "favorite",
  want: boolean,
): Promise<void> {
  await openFeedDetail(page, feedId, xsecToken);

  const selector = kind === "like" ? SELECTOR_LIKE : SELECTOR_COLLECT;
  const pick = (s: InteractState): boolean => (kind === "like" ? s.liked : s.collected);

  let current: InteractState | undefined;
  try {
    current = await getInteractState(page, feedId);
  } catch {
    // 读不到状态也照常尝试点击，靠点击后的校验兜底
  }

  if (current && pick(current) === want) return;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const btn = await page.waitForSelector(selector, { timeout: 10_000 }).catch(() => null);
    if (!btn) throw new Error(`未找到交互元素 ${selector}`);

    await delay("before_click");
    await btn.click({ timeout: 10_000 }).catch(async () => {
      await btn.click({ timeout: 10_000, force: true });
    });

    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const state = await getInteractState(page, feedId).catch(() => undefined);
      if (state && pick(state) === want) {
        await delay("after_interact");
        return;
      }
      await page.waitForTimeout(500);
    }
  }

  const action = kind === "like" ? (want ? "点赞" : "取消点赞") : want ? "收藏" : "取消收藏";
  throw new Error(`${action}失败：点击后状态始终未变为预期`);
}
