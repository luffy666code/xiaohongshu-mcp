import os from "node:os";

/** 由 seed 派生的稳定指纹。同一 seed 每次启动得到同一套参数。 */
export interface Fingerprint {
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemory: number;
  platform: string;
  seed: number;
}

/** 常见的桌面分辨率，按 seed 挑一个，避免每台机器都是同一个 1280x720。 */
const VIEWPORTS: Array<{ width: number; height: number }> = [
  { width: 1440, height: 900 },
  { width: 1512, height: 945 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1728, height: 1080 },
  { width: 1920, height: 1080 },
];

/** 按运行平台给出 navigator.platform 的合理取值。 */
function platformString(): string {
  const arch = process.arch;
  switch (process.platform) {
    case "win32":
      return "Win32";
    case "darwin":
      return "MacIntel";
    default:
      return arch === "arm64" ? "Linux aarch64" : "Linux x86_64";
  }
}

/** 由 seed 稳定地派生一套指纹参数。 */
export function deriveFingerprint(seed: number): Fingerprint {
  const s = seed > 0 ? seed : 1;

  const viewport = VIEWPORTS[s % VIEWPORTS.length]!;
  // 浏览器窗口不会占满整屏，屏幕再比视口大一圈
  const screen = { width: viewport.width, height: viewport.height + 80 };
  const hardwareConcurrency = [4, 6, 8, 10, 12, 16][s % 6]!;
  const deviceMemory = [4, 8, 16][s % 3]!;

  return {
    viewport,
    screen,
    hardwareConcurrency,
    deviceMemory,
    platform: platformString(),
    seed: s,
  };
}

/**
 * 生成反自动化脚本，在每个页面加载前注入。
 *
 * 只覆盖最常被拿来判定的几个字段，不做过度伪装：
 * 站点真正依赖的是登录态与行为节奏，把 navigator 改得越离谱越容易露馅。
 */
export function stealthScript(fp: Fingerprint): string {
  return `
(() => {
  const define = (obj, prop, value) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });
    } catch (_) {}
  };
  define(navigator, 'webdriver', undefined);
  define(navigator, 'hardwareConcurrency', ${fp.hardwareConcurrency});
  define(navigator, 'deviceMemory', ${fp.deviceMemory});
  define(navigator, 'platform', ${JSON.stringify(fp.platform)});
  define(navigator, 'language', 'zh-CN');
  define(navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en']);
  define(navigator, 'maxTouchPoints', 0);
  define(screen, 'width', ${fp.screen.width});
  define(screen, 'height', ${fp.screen.height});
  define(screen, 'availWidth', ${fp.screen.width});
  define(screen, 'availHeight', ${fp.screen.height - 40});

  // Chrome 受控时会挂上这个属性，主动删掉
  try {
    define(window, 'chrome', { runtime: {}, app: { isInstalled: false }, csi: () => {}, loadTimes: () => {} });
  } catch (_) {}

  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(p);
  }
})();
`;
}

/** 本机 CPU 信息，仅用于日志。 */
export function hostLabel(): string {
  return `${process.platform}/${process.arch} node=${process.version} cpus=${os.cpus().length}`;
}
