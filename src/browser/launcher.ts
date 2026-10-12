import { chromium, type BrowserContext, type Page } from "playwright-core";
import { actionTimeout, fingerprintSeedFromEnv, isHeadless, profileDir, proxy } from "../config.js";
import { detectBrowser } from "./detect.js";
import { deriveFingerprint, stealthScript, type Fingerprint } from "./fingerprint.js";
import { loadSession, saveSeed } from "../session/cookies.js";
import { log } from "../log.js";

/** 打开后的浏览器会话句柄。 */
export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  fingerprint: Fingerprint;
  close(): Promise<void>;
}

/** 启动参数。 */
export interface OpenOptions {
  headless?: boolean;
  /** 是否注入已保存的 cookies，默认注入。 */
  withCookies?: boolean;
  seed?: number;
}

function launchArgs(): string[] {
  const args = [
    "--disable-blink-features=AutomationControlled",
    "--lang=zh-CN",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
  ];

  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
    // 容器/root 环境没有 sandbox 权限
    try {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        args.push("--no-sandbox");
      }
    } catch {
      // Windows 上没有 getuid
    }
  }

  return args;
}

/** 把 http://user:pass@host:port 拆成 playwright 的代理配置。 */
function proxyOption(raw: string): { server: string; username?: string; password?: string } | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const opt: { server: string; username?: string; password?: string } = { server: `${url.protocol}//${url.host}` };
    if (url.username) opt.username = decodeURIComponent(url.username);
    if (url.password) opt.password = decodeURIComponent(url.password);
    return opt;
  } catch {
    // 不是标准 URL 就按原样交给 playwright
    return { server: raw };
  }
}

/**
 * 确定本次使用的指纹 seed：显式指定 > 环境变量 > 会话文件里存过的 > 随机生成并写回。
 *
 * 写回这一步不能省：同一账号每次启动的屏幕分辨率、CPU 核数若都不同，
 * 指纹就失去了"稳定"的意义，反而更像自动化。
 */
function resolveSeed(explicit: number | undefined, saved: number): number {
  if (explicit && explicit > 0) return explicit;

  const fromEnv = fingerprintSeedFromEnv();
  if (fromEnv > 0) return fromEnv;

  if (saved > 0) return saved;

  const fresh = Math.floor(Math.random() * 1_000_000) + 1;
  try {
    saveSeed(fresh);
  } catch (err) {
    log.warn(`写入指纹 seed 失败（本次仍使用随机值）: ${String(err)}`);
  }
  return fresh;
}

/**
 * 打开本机浏览器。
 *
 * 用独立的 user-data-dir：既不抢用户正在运行的 Chrome 的锁，
 * 也不会把自动化痕迹写进用户自己的 profile。登录态由 cookies.json 注入。
 */
export async function openBrowser(opts: OpenOptions = {}): Promise<BrowserSession> {
  const detected = detectBrowser();
  const saved = loadSession();
  const seed = resolveSeed(opts.seed, saved.seed);
  const fp = deriveFingerprint(seed);
  const headless = opts.headless ?? isHeadless();

  log.info(
    `launch browser: ${detected.name} (${detected.source}) headless=${headless} seed=${fp.seed} path=${detected.executablePath}`,
  );

  const context = await chromium.launchPersistentContext(profileDir(), {
    executablePath: detected.executablePath,
    headless,
    args: launchArgs(),
    viewport: fp.viewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    proxy: proxyOption(proxy()),
    ignoreHTTPSErrors: true,
  });

  context.setDefaultTimeout(actionTimeout());

  await context.addInitScript(stealthScript(fp));

  if (opts.withCookies !== false) {
    const cookies = saved.cookies;
    if (cookies.length > 0) {
      try {
        await context.addCookies(cookies);
        log.debug(`injected ${cookies.length} cookies`);
      } catch (err) {
        log.warn(`注入 cookies 失败（继续，但可能需要重新登录）: ${String(err)}`);
      }
    }
  }

  const page = context.pages()[0] ?? (await context.newPage());

  return {
    context,
    page,
    fingerprint: fp,
    async close() {
      try {
        await context.close();
      } catch (err) {
        log.debug(`关闭浏览器失败（忽略）: ${String(err)}`);
      }
    },
  };
}

/**
 * 跑一段需要浏览器的逻辑，结束或出错都保证关掉浏览器。
 * 需要长期持有浏览器（如等待扫码）的场景不要用这个函数，直接 openBrowser。
 */
export async function withBrowser<T>(
  fn: (session: BrowserSession) => Promise<T>,
  opts: OpenOptions = {},
): Promise<T> {
  const session = await openBrowser(opts);
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}
