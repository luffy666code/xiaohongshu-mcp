import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { XHS_SITE } from "../config.js";
import { typeInto } from "../humanize/typing.js";
import { readStateAt, waitForInitialState } from "./state.js";
import type { NotificationCount, NotificationItem, NotificationList } from "./types.js";

/** 通知页的三个分区。 */
export type NotificationTab = "mentions" | "likes" | "connections";

const TAB_LABEL: Record<string, string> = {
  mentions: "评论和@",
  likes: "赞和收藏",
  connections: "新增关注",
};

/** 内容状态里表示「正常可见」的取值。 */
const STATUS_NORMAL = "NORMAL";
/** 关联对象是笔记时的类型标记。 */
const ITEM_TYPE_NOTE = "note_info";

/** 解析分区名，空值默认为「评论和@」。 */
export function parseNotificationTab(s: string): NotificationTab {
  const v = (s ?? "").trim().toLowerCase();
  if (v === "" || v === "mentions") return "mentions";
  if (v === "likes") return "likes";
  if (v === "connections") return "connections";
  throw new Error(`未知的通知分区 "${s}"，可选：mentions / likes / connections`);
}

interface RawUser {
  userid?: string;
  nickname?: string;
  xsecToken?: string;
}

interface RawNotification {
  id?: string;
  type?: string;
  title?: string;
  time?: number;
  userInfo?: RawUser;
  user?: RawUser;
  commentInfo?: {
    id?: string;
    content?: string;
    liked?: boolean;
    illegalInfo?: { illegalStatus?: string };
  };
  itemInfo?: {
    id?: string;
    type?: string;
    content?: string;
    xsecToken?: string;
    illegalInfo?: { illegalStatus?: string };
  };
}

interface NotificationPayload {
  hasMore?: boolean;
  messageList?: RawNotification[];
}

/** 读指定分区的原始通知。 */
async function readTab(page: Page, tab: NotificationTab): Promise<NotificationPayload> {
  const payload = await readStateAt<NotificationPayload>(page, `notification.notificationMap.${tab}`, 10_000);
  if (!payload) throw new Error(`页面状态里没有分区 ${tab}，可能未登录或页面结构已变化`);
  return payload;
}

function visible(raw: RawNotification): boolean {
  const commentStatus = raw.commentInfo?.illegalInfo?.illegalStatus ?? "";
  if (raw.commentInfo?.id && commentStatus && commentStatus !== STATUS_NORMAL) return false;

  const itemStatus = raw.itemInfo?.illegalInfo?.illegalStatus ?? "";
  if (raw.itemInfo?.id && itemStatus && itemStatus !== STATUS_NORMAL) return false;

  return true;
}

function from(raw: RawNotification): RawUser {
  const u = raw.userInfo ?? {};
  if (u.userid || u.nickname) return u;
  return raw.user ?? {};
}

/** 过滤掉不可见条目并转成对外结构。 */
function convert(raw: RawNotification[], limit: number): { items: NotificationItem[]; filtered: number } {
  const items: NotificationItem[] = [];
  let filtered = 0;

  for (const r of raw) {
    if (items.length >= limit) break;
    if (!visible(r)) {
      filtered++;
      continue;
    }

    const u = from(r);
    const item: NotificationItem = {
      id: r.id ?? "",
      type: r.type ?? "",
      title: r.title,
      time: r.time,
      from: { user_id: u.userid ?? "", nickname: u.nickname ?? "", xsec_token: u.xsecToken },
      comment_id: r.commentInfo?.id,
      comment_text: r.commentInfo?.content,
      liked: r.commentInfo?.liked === true,
      feed_title: r.itemInfo?.content,
    };

    if (r.itemInfo?.type === ITEM_TYPE_NOTE) {
      item.feed_id = r.itemInfo.id;
      item.feed_xsec_token = r.itemInfo.xsecToken;
    }

    items.push(item);
  }

  return { items, filtered };
}

/** 三个分区各自的未读数。 */
export async function unreadCount(page: Page): Promise<NotificationCount> {
  await gotoWithRetry(page, `${XHS_SITE}/explore`);
  await waitForInitialState(page, 15_000);

  const raw = await readStateAt<{
    mentions?: number;
    likes?: number;
    connections?: number;
    unreadCount?: number;
  }>(page, "notification.notificationCount", 10_000);

  if (!raw) throw new Error("页面状态里没有未读数，可能未登录或页面结构已变化");

  return {
    mentions: raw.mentions ?? 0,
    likes: raw.likes ?? 0,
    connections: raw.connections ?? 0,
    unread: raw.unreadCount ?? 0,
  };
}

/** 切到目标分区。「评论和@」是默认分区，无需点击。 */
async function switchTab(page: Page, tab: NotificationTab): Promise<void> {
  if (tab === "mentions") return;

  const label = TAB_LABEL[tab];
  const items = page.locator(".reds-tab-item");
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
    await page.waitForTimeout(1200);
    return;
  }

  throw new Error(`未找到分区标签 "${label}"`);
}

/** 滚动加载，直到条目数够用或没有更多。 */
async function loadUntil(page: Page, tab: NotificationTab, limit: number): Promise<void> {
  for (let round = 0; round < 20; round++) {
    const payload = await readTab(page, tab);
    const loaded = payload.messageList?.length ?? 0;
    if (loaded >= limit || !payload.hasMore) return;

    await page.mouse.wheel(0, 800).catch(() => undefined);
    await delay("between_scroll");
  }
}

/** 读指定分区的通知列表。 */
export async function listNotifications(page: Page, tab: NotificationTab, limit: number): Promise<NotificationList> {
  const size = limit > 0 ? limit : 20;

  await gotoWithRetry(page, `${XHS_SITE}/notification`);
  await delay("after_navigate");
  await switchTab(page, tab);
  await loadUntil(page, tab, size);

  const payload = await readTab(page, tab);
  const { items, filtered } = convert(payload.messageList ?? [], size);

  return { tab, filtered, items };
}

/** 定位目标评论在当前分区里的位置，必要时滚动加载。 */
async function locate(page: Page, commentId: string): Promise<{ raw: RawNotification; index: number }> {
  for (let round = 0; round < 20; round++) {
    const payload = await readTab(page, "mentions");
    const list = payload.messageList ?? [];

    for (let i = 0; i < list.length; i++) {
      const r = list[i]!;
      if (r.commentInfo?.id !== commentId) continue;
      if (!visible(r)) throw new Error(`该评论已删除或不可见，不能回复: ${commentId}`);
      return { raw: r, index: i };
    }

    if (!payload.hasMore) throw new Error(`未找到评论 ${commentId}，它可能不在「评论和@」里或已被清理`);

    await page.mouse.wheel(0, 800).catch(() => undefined);
    await delay("between_scroll");
  }

  throw new Error(`翻找多轮仍未定位到评论 ${commentId}`);
}

/** 回复「评论和@」里的一条评论。 */
export async function replyNotification(
  page: Page,
  commentId: string,
  content: string,
): Promise<{ comment_id: string; nickname: string; feed_id?: string; content: string }> {
  await gotoWithRetry(page, `${XHS_SITE}/notification`);
  await delay("after_navigate");

  const target = await locate(page, commentId);

  const items = page.locator(".tabs-content-container > .container");
  if (target.index >= (await items.count())) {
    throw new Error("通知条目渲染数少于目标位置，页面可能未加载完");
  }
  const item = items.nth(target.index);

  await delay("reading");

  const replyBtn = await item.locator(".action-reply").first().elementHandle().catch(() => null);
  if (!replyBtn) throw new Error("该通知没有回复入口（评论可能已删除或不可回复）");

  await delay("before_click");
  await replyBtn.click({ timeout: 10_000, force: true }).catch(async () => {
    await replyBtn.click({ timeout: 10_000 });
  });
  await delay("after_click");

  const input = await item.locator("textarea.comment-input").first().elementHandle().catch(() => null);
  if (!input) throw new Error("回复输入框未出现");

  const nickname = from(target.raw).nickname ?? "";
  const placeholder = await input.getAttribute("placeholder").catch(() => null);
  if (!placeholder) throw new Error("读不到回复框提示文字，无法确认回复对象，已中止");
  if (nickname && !placeholder.includes(nickname)) {
    throw new Error(`回复对象不符：期望 "${nickname}"，实际提示为 "${placeholder}"，已中止`);
  }

  await typeInto(page, input, content);
  await delay("after_type");

  const submit = await item.locator("button.submit").first().elementHandle().catch(() => null);
  if (!submit) throw new Error("未找到发送按钮");

  await delay("before_submit");
  await submit.click({ timeout: 10_000 }).catch(async () => {
    await submit.click({ timeout: 10_000, force: true });
  });

  // 输入框收起即认为提交成功
  const accepted = await item
    .locator("textarea.comment-input")
    .first()
    .waitFor({ state: "detached", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!accepted) throw new Error("回复未确认成功：发送后输入框仍未收起（可能被限制或发送失败）");

  await delay("after_interact");

  return {
    comment_id: commentId,
    nickname,
    feed_id: target.raw.itemInfo?.type === ITEM_TYPE_NOTE ? target.raw.itemInfo.id : undefined,
    content,
  };
}

/** 给「评论和@」里的一条评论点赞或取消点赞。 */
export async function likeNotification(
  page: Page,
  commentId: string,
  unlike: boolean,
): Promise<{ comment_id: string; liked: boolean }> {
  const want = !unlike;

  await gotoWithRetry(page, `${XHS_SITE}/notification`);
  await delay("after_navigate");

  // 已是目标状态时直接返回
  const current = await readTab(page, "mentions");
  const found = (current.messageList ?? []).find((r) => r.commentInfo?.id === commentId);
  if (found && (found.commentInfo?.liked === true) === want) {
    return { comment_id: commentId, liked: want };
  }

  const target = await locate(page, commentId);

  const items = page.locator(".tabs-content-container > .container");
  if (target.index >= (await items.count())) {
    throw new Error("通知条目渲染数少于目标位置，页面可能未加载完");
  }
  const item = items.nth(target.index);

  const btn = await item.locator(".action-like .like-wrapper").first().elementHandle().catch(() => null);
  if (!btn) throw new Error("该通知没有点赞入口（评论可能已删除或不可点赞）");

  await delay("before_click");
  await btn.click({ timeout: 10_000, force: true }).catch(async () => {
    await btn.click({ timeout: 10_000 });
  });
  await delay("after_interact");

  // 轮询状态确认
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const payload = await readTab(page, "mentions").catch(() => null);
    const r = (payload?.messageList ?? []).find((x) => x.commentInfo?.id === commentId);
    if (r && (r.commentInfo?.liked === true) === want) {
      return { comment_id: commentId, liked: want };
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `点赞状态在 15s 内未变为 ${want ? "已点赞" : "未点赞"}，请先用 list_notifications 读一次当前状态再决定是否重试`,
  );
}
