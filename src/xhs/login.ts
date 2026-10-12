import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { XHS_SITE } from "../config.js";
import { readStateAt } from "./state.js";
import { assertNotBlocked, detectRiskBlock, type RiskDetection } from "./risk.js";

/** 登录后侧边栏才会出现这个节点，用它判断登录态。 */
export const LOGGED_IN_SELECTOR = ".main-container .user .link-wrapper .channel";
/** 未登录时弹出的二维码图片。 */
const QRCODE_SELECTOR = ".login-container .qrcode-img";

/**
 * 等二维码出现的超时。
 *
 * 不能用 context 的默认超时（120s）：那是给正常动作兜底的量级，
 * 二维码不出来说明页面本身不对（风控、结构变化），早失败早报错。
 */
const QRCODE_TIMEOUT_MS = 15_000;

/**
 * 打开首页。
 *
 * 重试次数比别处少：登录流程整体有超时预算，导航占太多会把留给用户扫码的
 * 时间挤没。被风控时 gotoWithRetry 会直接抛错，不必等重试跑完。
 */
export async function openExplore(page: Page): Promise<void> {
  await gotoWithRetry(page, `${XHS_SITE}/explore`, { attempts: 2, timeoutMs: 25_000 });
  await page.waitForTimeout(1000);
  await assertNotBlocked(page);
}

/** 当前是否已登录。 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  return (await page.$(LOGGED_IN_SELECTOR)) !== null;
}

/**
 * 等二维码出现，期间持续查风控。
 *
 * 不能用一次 waitForSelector 了事：风控跳转是**延迟**发生的——
 * 页面先正常打开，前端发现二维码接口被拒后才跳到错误页。
 * 只在导航后查一次会漏掉，只在超时后查一次则要白等一整轮。
 * 边等边查，跳了就立刻失败。
 */
async function waitForQrcode(
  page: Page,
  timeoutMs: number,
): Promise<{ visible: boolean; risk?: RiskDetection }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const risk = await detectRiskBlock(page);
    if (risk.blocked) return { visible: false, risk };

    if ((await page.$(QRCODE_SELECTOR)) !== null) return { visible: true };

    await page.waitForTimeout(500);
  }

  const risk = await detectRiskBlock(page);
  return { visible: false, risk: risk.blocked ? risk : undefined };
}

/** 二维码没出现时的报错文案。 */
function qrcodeMissingError(waitedMs: number, risk?: RiskDetection): string {
  if (risk) {
    return `小红书拒绝了本次登录请求（${risk.message}）。请更换可靠网络环境后重试，或改用有头模式人工处理。`;
  }
  return `登录二维码未出现（已等 ${Math.round(waitedMs / 1000)} 秒）。可能是页面结构已变化，或二维码接口被限流；建议改用有头模式在窗口里扫码。`;
}

/** 当前登录用户的基础信息。未登录或读不到时返回 undefined。 */
export async function currentUser(page: Page): Promise<{ nickname: string; userId: string } | undefined> {
  // 只读 user.userInfo 这一层，不要读整个 user：
  // user 里含 Vue Ref（__v_isRef / _rawValue）和环形引用，整个对象序列化会失败，
  // 表现就是"已登录但读不到账号信息"。userInfo 本身是干净的。
  const info = await readStateAt<{ nickname?: string; userId?: string; user_id?: string; guest?: boolean }>(
    page,
    "user.userInfo",
    8_000,
  );
  if (!info || info.guest) return undefined;

  const nickname = info.nickname ?? "";
  const userId = info.userId ?? info.user_id ?? "";
  if (!nickname && !userId) return undefined;

  return { nickname, userId };
}

/** 开窗结果。 */
export interface LoginWindow {
  /** 是否已经登录。 */
  loggedIn: boolean;
  /** 二维码是否真的出现在页面上。 */
  qrcodeVisible: boolean;
  /** 命中风控时的站点提示；正常为 undefined。 */
  riskMessage?: string;
}

/**
 * 打开登录页让人扫码（有头浏览器场景）。
 *
 * 导航到首页会弹出二维码浮层；这里等浮层真正出现再返回，
 * 否则调用方一返回就可能把窗口关掉，用户根本来不及扫。
 *
 * 被风控时**不抛错**：窗口就在用户面前，把提示带回去让上层决定，
 * 用户可以在同一个窗口里换网络或完成验证，后台仍在等登录。
 */
export async function openLoginWindow(page: Page, timeoutMs = QRCODE_TIMEOUT_MS): Promise<LoginWindow> {
  await openExplore(page).catch(() => undefined);
  await page.waitForTimeout(1000);

  if (await isLoggedIn(page)) return { loggedIn: true, qrcodeVisible: false };

  const { visible, risk } = await waitForQrcode(page, timeoutMs);
  if (risk) return { loggedIn: false, qrcodeVisible: false, riskMessage: risk.message };

  return { loggedIn: await isLoggedIn(page), qrcodeVisible: visible };
}

/** 取登录二维码（data URL）。已登录时 img 为空。 */
export async function fetchQrcodeImage(
  page: Page,
  timeoutMs = QRCODE_TIMEOUT_MS,
): Promise<{ img: string; loggedIn: boolean }> {
  await openExplore(page);

  if (await isLoggedIn(page)) return { img: "", loggedIn: true };

  const { visible, risk } = await waitForQrcode(page, timeoutMs);
  if (!visible) throw new Error(qrcodeMissingError(timeoutMs, risk));

  // 必须显式限时：getAttribute 默认吃 context 的 120s，
  // 二维码图片接口被拒时会一直空转到超时，表现为整个调用"挂死"。
  const img = await page.getAttribute(QRCODE_SELECTOR, "src", { timeout: 5_000 }).catch(() => null);
  if (!img) throw new Error("二维码节点已出现但取不到图片地址，二维码接口可能被限流");

  return { img, loggedIn: false };
}

/**
 * 轮询等待扫码完成。返回 true 表示登录成功。
 *
 * 这里**只被动观察，绝不主动刷新页面**。
 * 登录页上的二维码是活码，页面一刷新它就会重新生成，用户扫到一半就失效了
 * （曾因此在等待期间每 6 秒重新导航一次，导致"扫到一半页面就刷新"）。
 * 扫码成功后小红书前端自己会切到已登录状态，等着就行。
 *
 * 万一遇到页面不自动跳转的兜底放在调用方：等超时后再刷新确认一次，
 * 那时用户已经不在扫了，刷新不会打断他。
 */
export async function waitForLogin(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return true;
    await page.waitForTimeout(800);
  }

  return false;
}
