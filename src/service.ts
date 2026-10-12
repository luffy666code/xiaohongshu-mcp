import fs from "node:fs";
import {
  SCHEDULE_MAX_OFFSET,
  SCHEDULE_MIN_OFFSET,
  TITLE_MAX_LENGTH,
  cookiesFilePath,
  profileDir,
} from "./config.js";
import { openBrowser, withBrowser, type BrowserSession } from "./browser/launcher.js";
import { log } from "./log.js";
import { deleteSession, loadSession, saveCookies, saveSeed } from "./session/cookies.js";
import { loginSessions } from "./session/loginSessions.js";
import {
  currentUser,
  fetchQrcodeImage,
  isLoggedIn,
  openExplore,
  openLoginWindow,
  waitForLogin,
} from "./xhs/login.js";
import { listFeeds } from "./xhs/feeds.js";
import { searchFeeds } from "./xhs/search.js";
import { getFeedDetail } from "./xhs/feedDetail.js";
import { toggleInteract } from "./xhs/interact.js";
import { postComment, replyToComment } from "./xhs/comment.js";
import { myProfile, parseProfileTab, userProfile, type ProfileTab } from "./xhs/userProfile.js";
import {
  listNotifications,
  likeNotification,
  parseNotificationTab,
  replyNotification,
  unreadCount,
  type NotificationTab,
} from "./xhs/notification.js";
import { publishImage, publishVideo } from "./xhs/publish.js";
import { processImages } from "./util/images.js";
import type {
  CommentLoadConfig,
  Feed,
  FeedDetailResponse,
  FilterOption,
  NotificationCount,
  NotificationList,
  UserProfileResponse,
} from "./xhs/types.js";
import { DEFAULT_COMMENT_CONFIG } from "./xhs/types.js";

/** 一次扫码登录的等待上限。 */
/**
 * 等待扫码的上限。
 *
 * 这个调用是阻塞的，等待期间客户端拿不到任何响应，所以不宜过长——
 * 两分钟足够大多数人拿手机扫码；超时后窗口会关闭并提示重试。
 */
export const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

// ------------------------------------------------------------------ 响应结构

export interface LoginStatusResponse {
  is_logged_in: boolean;
  username?: string;
  user_id?: string;
}

export interface LoginQrcodeResponse {
  timeout: string;
  is_logged_in: boolean;
  /** 是否已在浏览器窗口里打开登录页（有头模式）。 */
  opened_in_browser: boolean;
  /** 只有无头模式才返回二维码 data URL；有头模式人在窗口里扫，不给图片。 */
  img?: string;
  /** 有头模式下的异常说明：命中风控、或没检测到二维码。窗口仍然开着。 */
  warning?: string;
}


export interface PublishResponse {
  title: string;
  content: string;
  images: number;
  status: string;
}

export interface PublishVideoResponse {
  title: string;
  content: string;
  video: string;
  status: string;
}

export interface FeedsListResponse {
  feeds: Feed[];
  count: number;
}

export interface ActionResult {
  feed_id: string;
  success: boolean;
  message: string;
}

export interface PostCommentResponse {
  feed_id: string;
  success: boolean;
  message: string;
}

export interface ReplyCommentResponse {
  feed_id: string;
  target_comment_id?: string;
  target_user_id?: string;
  success: boolean;
  message: string;
}

// ------------------------------------------------------------------ 参数校验

/**
 * 小红书标题长度规则：非 ASCII 记 2 字节、ASCII 记 1 字节，结果除以 2 向上取整。
 * 也就是一个汉字算 1 个字，两个英文字母算 1 个字。
 */
export function calcTitleLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    bytes += s.charCodeAt(i) > 127 ? 2 : 1;
  }
  return Math.floor((bytes + 1) / 2);
}

function formatDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 解析并校验定时发布时间：必须在 1 小时之后、14 天之内。 */
export function parseSchedule(raw: string): Date {
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) {
    throw new Error("定时发布时间格式错误，请使用 ISO8601 格式");
  }

  const now = Date.now();
  const min = new Date(now + SCHEDULE_MIN_OFFSET);
  const max = new Date(now + SCHEDULE_MAX_OFFSET);

  if (t.getTime() < min.getTime()) {
    throw new Error(
      `定时发布时间必须至少在1小时后，当前设置: ${formatDateTime(t)}，最早可选: ${formatDateTime(min)}`,
    );
  }
  if (t.getTime() > max.getTime()) {
    throw new Error(
      `定时发布时间不能超过14天，当前设置: ${formatDateTime(t)}，最晚可选: ${formatDateTime(max)}`,
    );
  }

  return t;
}

function checkTitle(title: string): void {
  if (calcTitleLength(title) > TITLE_MAX_LENGTH) {
    throw new Error(`标题长度超过限制（最多 ${TITLE_MAX_LENGTH} 个字，当前 ${calcTitleLength(title)}）`);
  }
}

// ------------------------------------------------------------------ 登录相关

/** 检查登录状态。 */
export async function checkLoginStatus(): Promise<LoginStatusResponse> {
  return withBrowser(async ({ page }) => {
    await openExplore(page);

    const ok = await isLoggedIn(page);
    if (!ok) return { is_logged_in: false };

    const user = await currentUser(page).catch(() => undefined);
    if (!user) {
      log.warn("已登录但读不到账号信息，仅返回登录状态");
      return { is_logged_in: true };
    }

    return { is_logged_in: true, username: user.nickname, user_id: user.userId };
  });
}

/**
 * 阻塞等扫码完成，成功后落盘登录态。
 *
 * 这里必须阻塞：不阻塞的话工具会立刻返回"已打开窗口"，
 * 调用方以为结束了就把对话停下来，用户扫完码还得手动再发一条消息。
 * 返回前由调用方负责关掉浏览器——profile 目录同一时刻只能被一个实例打开，
 * 留着不关会让用户接下来的每一次调用都拿不到锁。
 */
async function waitScanAndSave(session: BrowserSession, timeoutMs: number): Promise<boolean> {
  let ok = await waitForLogin(session.page, timeoutMs);

  if (!ok) {
    // 兜底：扫码成功后页面绝大多数情况会自己切到已登录态；万一没切，
    // 这里刷新确认一次。放在超时之后是刻意的——此时用户已经不在扫码，
    // 刷新不会把二维码刷掉打断他。
    log.info("等待扫码超时，做最后一次刷新确认");
    await openExplore(session.page).catch(() => undefined);
    ok = await isLoggedIn(session.page).catch(() => false);
  }

  if (!ok) return false;

  try {
    await saveCookies(await session.context.cookies());
    log.info("扫码登录成功，cookies 已保存");
  } catch (err) {
    // 存不下来不算登录失败：登录态本来就还在 profile 里，
    // 只是换机器/清 profile 后没法靠文件恢复
    log.error(`扫码成功但保存 cookies 失败: ${String(err)}`);
  }

  return true;
}

/**
 * 取登录二维码。
 *
 * 默认有头：开一个浏览器窗口停在登录页，人拿 App 扫就行——
 * 不再把二维码转手交给客户端渲染，少一次编码转换，也不依赖客户端能显示图片。
 * 工具会**一直阻塞到扫码完成或超时**，扫完即刻返回，对话可以直接往下走。
 *
 * 需要无人值守（纯 headless 环境）时显式传 headless: true，才返回 base64。
 */
export async function getLoginQrcode(
  opts: { headless?: boolean; timeoutMs?: number } = {},
): Promise<LoginQrcodeResponse> {
  const headless = opts.headless ?? false;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : LOGIN_TIMEOUT_MS;
  const timeoutLabel = `${Math.round(timeoutMs / 1000)}s`;
  const session = await openBrowser({ headless });

  // 重复调用时把上一个还开着的登录窗口关掉，否则它会一直占着 profile
  const seq = loginSessions.start(() => {
    void session.close();
  });

  try {
    if (headless) {
      const { img, loggedIn } = await fetchQrcodeImage(session.page);
      if (loggedIn) return { timeout: "0s", is_logged_in: true, opened_in_browser: false };

      const ok = await waitScanAndSave(session, timeoutMs);
      if (ok) return { timeout: "0s", is_logged_in: true, opened_in_browser: false };

      return {
        timeout: timeoutLabel,
        is_logged_in: false,
        opened_in_browser: false,
        img,
        warning: `已等待 ${timeoutLabel} 未检测到扫码完成。`,
      };
    }

    const win = await openLoginWindow(session.page);
    if (win.loggedIn) {
      try {
        await saveCookies(await session.context.cookies());
      } catch (err) {
        log.warn(`已在登录态但保存 cookies 失败（登录态仍在 profile 里）: ${String(err)}`);
      }
      return { timeout: "0s", is_logged_in: true, opened_in_browser: true };
    }

    log.info(`已打开登录窗口，等待扫码（${timeoutLabel}）`);
    const ok = await waitScanAndSave(session, timeoutMs);
    if (ok) {
      return { timeout: timeoutLabel, is_logged_in: true, opened_in_browser: true };
    }

    return {
      timeout: timeoutLabel,
      is_logged_in: false,
      opened_in_browser: true,
      warning: win.riskMessage
        ? `小红书提示：${win.riskMessage}；已等待 ${timeoutLabel} 未完成登录。请更换可靠网络环境后重试。`
        : `已等待 ${timeoutLabel} 未检测到扫码完成。`,
    };
  } finally {
    // 一定要关：profile 目录被占着的话，后续任何工具调用都开不起浏览器
    loginSessions.finish(seq);
    await session.close();
  }
}
/** 删除 cookies，重置登录状态。返回被删除的文件路径。 */
/** 重置登录状态的结果。 */
export interface DeleteCookiesResponse {
  /** cookies 文件路径。 */
  cookies_path: string;
  /** 浏览器 profile 目录路径（登录态主要存在这里）。 */
  profile_path: string;
  /** 是否成功清掉了 profile 里的登录态。 */
  profile_cleared: boolean;
  message: string;
}

/** 递归删目录，Windows 上文件可能被占用，多试几次。 */
function removeDirWithRetry(dir: string): void {
  if (!fs.existsSync(dir)) return;

  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    throw new Error(
      `清理浏览器数据目录失败（可能有浏览器正在使用它）：${String(err)}\n` +
        `请先关闭所有由本工具打开的浏览器窗口，再重试；或手动删除该目录：${dir}`,
    );
  }
}

/**
 * 重置登录状态，用于重新登录或切换账号。
 *
 * 为什么不能只删 cookies.json：登录态**主要存在浏览器 profile 里**
 * （Chrome 的 Cookie 数据库 + Local Storage），cookies.json 只是同一份登录态的
 * 一个副本。只删文件的话，重新打开浏览器依然是原来那个账号——
 * 表现就是"删了 cookies 却没效果，还是以前的账号信息"。
 *
 * 所以这里连 profile 一起清掉，确保换账号时是干净的。
 */
export async function deleteCookies(): Promise<DeleteCookiesResponse> {
  const path = cookiesFilePath();
  const profile = profileDir();

  // 设备指纹 seed 不是登录态，单独留住：指纹突变反而更容易触发风控
  const { seed } = loadSession();

  deleteSession();
  if (seed > 0) {
    try {
      saveSeed(seed);
    } catch (err) {
      log.warn(`保留指纹 seed 失败（不影响重置登录）: ${String(err)}`);
    }
  }

  let profileCleared = false;
  if (fs.existsSync(profile)) {
    removeDirWithRetry(profile);
    profileCleared = true;
    log.info(`已清理浏览器数据目录: ${profile}`);
  }

  return {
    cookies_path: path,
    profile_path: profile,
    profile_cleared: profileCleared,
    message: [
      "登录状态已重置。",
      "",
      `cookies 文件: ${path}`,
      `浏览器数据目录: ${profile}${profileCleared ? "（已清空）" : "（原本不存在）"}`,
      "",
      "说明：登录态主要保存在浏览器数据目录里，本次已一并清理，",
      "因此重新登录时不会带上之前账号的信息，可以放心切换账号。",
      seed > 0 ? "（设备指纹 seed 已保留，避免指纹突变触发风控）" : "",
      "",
      "下次操作时，需要重新扫码登录。",
    ]
      .filter((s) => s !== "")
      .join("\n"),
  };
}

// ------------------------------------------------------------------ 发布

export interface PublishRequest {
  title: string;
  content: string;
  images: string[];
  tags?: string[];
  schedule_at?: string;
  is_original?: boolean;
  visibility?: string;
  products?: string[];
}

export async function publishContent(req: PublishRequest): Promise<PublishResponse> {
  checkTitle(req.title);

  const imagePaths = await processImages(req.images ?? []);
  if (imagePaths.length === 0) throw new Error("图片不能为空");

  const scheduleAt = req.schedule_at ? parseSchedule(req.schedule_at) : undefined;

  await withBrowser(async ({ page }) => {
    await publishImage(page, imagePaths, {
      title: req.title,
      content: req.content,
      tags: req.tags ?? [],
      scheduleAt,
      isOriginal: req.is_original ?? false,
      visibility: req.visibility ?? "",
      products: req.products ?? [],
    });
  });

  return {
    title: req.title,
    content: req.content,
    images: imagePaths.length,
    status: "发布完成",
  };
}

export interface PublishVideoRequest {
  title: string;
  content: string;
  video: string;
  tags?: string[];
  schedule_at?: string;
  visibility?: string;
  products?: string[];
}

export async function publishVideoContent(req: PublishVideoRequest): Promise<PublishVideoResponse> {
  checkTitle(req.title);

  if (!req.video) throw new Error("必须提供本地视频文件");

  const scheduleAt = req.schedule_at ? parseSchedule(req.schedule_at) : undefined;

  await withBrowser(async ({ page }) => {
    await publishVideo(page, req.video, {
      title: req.title,
      content: req.content,
      tags: req.tags ?? [],
      scheduleAt,
      visibility: req.visibility ?? "",
      products: req.products ?? [],
    });
  });

  return {
    title: req.title,
    content: req.content,
    video: req.video,
    status: "发布完成",
  };
}

// ------------------------------------------------------------------ 读取

export async function getFeedsList(): Promise<FeedsListResponse> {
  const feeds = await withBrowser(({ page }) => listFeeds(page));
  return { feeds, count: feeds.length };
}

export async function searchFeedsList(keyword: string, filters: FilterOption[] = []): Promise<FeedsListResponse> {
  if (!keyword) throw new Error("缺少关键词参数");

  const feeds = await withBrowser(({ page }) => searchFeeds(page, keyword, filters));
  return { feeds, count: feeds.length };
}

export async function getFeedDetailById(
  feedId: string,
  xsecToken: string,
  loadAllComments: boolean,
  config: CommentLoadConfig = DEFAULT_COMMENT_CONFIG,
): Promise<FeedDetailResponse> {
  if (!feedId) throw new Error("缺少 feed_id 参数");
  if (!xsecToken) throw new Error("缺少 xsec_token 参数");

  return withBrowser(({ page }) => getFeedDetail(page, feedId, xsecToken, loadAllComments, config));
}

export async function getUserProfile(userId: string, xsecToken: string, tab: string): Promise<UserProfileResponse> {
  if (!userId) throw new Error("缺少 user_id 参数");
  if (!xsecToken) throw new Error("缺少 xsec_token 参数");

  const parsed: ProfileTab = parseProfileTab(tab);
  return withBrowser(({ page }) => userProfile(page, userId, xsecToken, parsed));
}

export async function getMyProfile(tab: string): Promise<UserProfileResponse> {
  const parsed: ProfileTab = parseProfileTab(tab);
  return withBrowser(({ page }) => myProfile(page, parsed));
}

// ------------------------------------------------------------------ 互动

export async function postCommentToFeed(
  feedId: string,
  xsecToken: string,
  content: string,
): Promise<PostCommentResponse> {
  if (!feedId) throw new Error("缺少 feed_id 参数");
  if (!xsecToken) throw new Error("缺少 xsec_token 参数");
  if (!content) throw new Error("缺少 content 参数");

  await withBrowser(({ page }) => postComment(page, feedId, xsecToken, content));
  return { feed_id: feedId, success: true, message: "评论发表成功" };
}

export async function replyCommentInFeed(
  feedId: string,
  xsecToken: string,
  commentId: string,
  userId: string,
  content: string,
): Promise<ReplyCommentResponse> {
  if (!feedId) throw new Error("缺少 feed_id 参数");
  if (!xsecToken) throw new Error("缺少 xsec_token 参数");
  if (!commentId && !userId) throw new Error("缺少 comment_id 或 user_id 参数");
  if (!content) throw new Error("缺少 content 参数");

  await withBrowser(({ page }) => replyToComment(page, feedId, xsecToken, commentId, userId, content));

  return {
    feed_id: feedId,
    target_comment_id: commentId || undefined,
    target_user_id: userId || undefined,
    success: true,
    message: "评论回复成功",
  };
}

async function interact(
  feedId: string,
  xsecToken: string,
  kind: "like" | "favorite",
  revert: boolean,
): Promise<ActionResult> {
  if (!feedId) throw new Error("缺少 feed_id 参数");
  if (!xsecToken) throw new Error("缺少 xsec_token 参数");

  await withBrowser(({ page }) => toggleInteract(page, feedId, xsecToken, kind, !revert));

  const action = kind === "like" ? (revert ? "取消点赞" : "点赞") : revert ? "取消收藏" : "收藏";
  return { feed_id: feedId, success: true, message: `${action}成功` };
}

export function likeFeed(feedId: string, xsecToken: string): Promise<ActionResult> {
  return interact(feedId, xsecToken, "like", false);
}

export function unlikeFeed(feedId: string, xsecToken: string): Promise<ActionResult> {
  return interact(feedId, xsecToken, "like", true);
}

export function favoriteFeed(feedId: string, xsecToken: string): Promise<ActionResult> {
  return interact(feedId, xsecToken, "favorite", false);
}

export function unfavoriteFeed(feedId: string, xsecToken: string): Promise<ActionResult> {
  return interact(feedId, xsecToken, "favorite", true);
}

// ------------------------------------------------------------------ 通知

export async function getUnreadCount(): Promise<NotificationCount> {
  return withBrowser(({ page }) => unreadCount(page));
}

export async function listNotificationsByTab(tab: string, limit: number): Promise<NotificationList> {
  const parsed: NotificationTab = parseNotificationTab(tab);
  return withBrowser(({ page }) => listNotifications(page, parsed, limit));
}

export async function replyNotificationById(commentId: string, content: string): Promise<unknown> {
  if (!commentId) throw new Error("缺少 comment_id 参数");
  if (!content) throw new Error("缺少 content 参数");

  return withBrowser(({ page }) => replyNotification(page, commentId, content));
}

export async function likeNotificationById(commentId: string, unlike: boolean): Promise<unknown> {
  if (!commentId) throw new Error("缺少 comment_id 参数");

  return withBrowser(({ page }) => likeNotification(page, commentId, unlike));
}
