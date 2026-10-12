import type { Page } from "playwright-core";

/**
 * 小红书风控拦截。
 *
 * 账号/IP 触发风控时，站点会把请求重定向到错误页而不是给数据。
 * 这类拦截不抛异常、也不返回 HTTP 错误码——页面是"正常"打开的，
 * 只是内容变成了「IP存在风险」。不主动识别的话，上层就只能干等到超时。
 */
export class RiskBlockedError extends Error {
  /** 站点返回的错误码（如 300012）；从页面文本识别出来时为 "page-text"。 */
  readonly code: string;
  /** 站点给的原始提示，或命中的页面文案。 */
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(detail || "被小红书风控拦截");
    this.name = "RiskBlockedError";
    this.code = code;
    this.detail = detail;
  }
}

/** 风控错误页的路径特征。 */
const RISK_PATH = "/website-login/error";

/** 错误页上常见的文案，命中任一即认为被拦。 */
const RISK_TEXTS = [
  "IP存在风险",
  "安全限制",
  "请切换可靠网络环境",
  "操作过于频繁",
  "请完成安全验证",
  "访问异常",
];

/** 读页面可见文本，取前面一段够用。页面跳转中读失败就当没有。 */
async function bodyText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 500));
  } catch {
    return "";
  }
}

/** 页面文本里命中的风控文案；没有则返回空串。 */
async function hitRiskText(page: Page): Promise<string> {
  const text = await bodyText(page);
  for (const t of RISK_TEXTS) {
    if (text.includes(t)) return t;
  }
  return "";
}

/** 检测结果。 */
export interface RiskDetection {
  blocked: boolean;
  /** 错误码；仅从页面文案识别时为 page-text。 */
  code: string;
  /** 可读提示，已解码。 */
  message: string;
}

const NOT_BLOCKED: RiskDetection = { blocked: false, code: "", message: "" };

/**
 * 判断当前页面是不是风控错误页。
 *
 * 两条独立信号，任一命中即算拦截：
 *   1. URL：跳转到 /website-login/error 且带 error_code / error_msg
 *   2. 页面文案：出现「IP存在风险」等提示（有些场景 URL 不带参数）
 */
export async function detectRiskBlock(page: Page): Promise<RiskDetection> {
  let url: URL;
  try {
    url = new URL(page.url());
  } catch {
    return NOT_BLOCKED;
  }

  const code = (url.searchParams.get("error_code") ?? "").trim();
  const message = (url.searchParams.get("error_msg") ?? "").trim();
  const onErrorPage = url.pathname.startsWith(RISK_PATH);

  // URL 已经能确认时不必要再读页面，省一次 evaluate
  if (onErrorPage || code) {
    return {
      blocked: true,
      code: code || "page-text",
      message: message || (onErrorPage ? "被跳转到小红书安全限制页" : `小红书返回错误码 ${code}`),
    };
  }

  const text = await hitRiskText(page);
  if (text) return { blocked: true, code: "page-text", message: text };

  return NOT_BLOCKED;
}

/** 被风控拦截时抛错，否则静默返回。 */
export async function assertNotBlocked(page: Page): Promise<void> {
  const r = await detectRiskBlock(page);
  if (!r.blocked) return;
  throw new RiskBlockedError(r.code, r.message);
}

/** 判断一个错误是不是风控拦截。 */
export function isRiskBlocked(err: unknown): err is RiskBlockedError {
  return err instanceof RiskBlockedError;
}
