import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

/** 浏览器探测结果。 */
export interface DetectedBrowser {
  /** 可执行文件的绝对路径。 */
  executablePath: string;
  /** 浏览器品牌，仅用于日志。 */
  name: string;
  /** 来源说明，排查问题时有用。 */
  source: string;
}

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

function expand(p: string): string {
  // Windows 上 %LOCALAPPDATA% 之类的变量不会被 Node 自动展开。
  return p.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? "");
}

function firstExisting(candidates: string[]): string | undefined {
  for (const raw of candidates) {
    const p = expand(raw);
    if (p && fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Windows 注册表里登记的 Chrome/Edge 安装路径。 */
function fromRegistry(): string | undefined {
  if (!isWin) return undefined;

  const keys = [
    String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`,
    String.raw`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`,
    String.raw`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`,
    String.raw`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe`,
  ];

  for (const key of keys) {
    try {
      const out = execFileSync("reg", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = out.match(/REG_SZ\s+(.+)$/m);
      if (match?.[1]) {
        const p = match[1].trim();
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // 没有该键，或 reg 不可用，继续下一个候选
    }
  }
  return undefined;
}

/** 在 PATH 里找可执行命令（Linux 主要靠这条）。 */
function fromPath(names: string[]): string | undefined {
  const sep = isWin ? ";" : ":";
  const dirs = (process.env.PATH ?? "").split(sep).filter(Boolean);

  for (const name of names) {
    // 已带完整路径时直接判定
    if (name.includes(path.sep) || name.includes("/")) {
      if (fs.existsSync(name)) return name;
      continue;
    }
    for (const dir of dirs) {
      const p = path.join(dir, isWin ? `${name}.exe` : name);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

/** 各平台按优先级排列的候选路径。 */
function candidates(): Array<{ name: string; paths: string[] }> {
  if (isWin) {
    return [
      {
        name: "Google Chrome",
        paths: [
          String.raw`%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`,
          String.raw`%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe`,
          String.raw`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`,
        ],
      },
      {
        name: "Microsoft Edge",
        paths: [
          String.raw`%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe`,
          String.raw`%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe`,
          String.raw`%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`,
        ],
      },
      {
        name: "Chromium",
        paths: [
          String.raw`%PROGRAMFILES%\Chromium\Application\chrome.exe`,
          String.raw`%LOCALAPPDATA%\Chromium\Application\chrome.exe`,
        ],
      },
    ];
  }

  if (isMac) {
    const home = os.homedir();
    return [
      {
        name: "Google Chrome",
        paths: [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ],
      },
      {
        name: "Microsoft Edge",
        paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
      },
      {
        name: "Chromium",
        paths: [
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/opt/homebrew/bin/chromium",
          "/usr/local/bin/chromium",
        ],
      },
    ];
  }

  return [
    {
      name: "Google Chrome",
      paths: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/snap/bin/google-chrome",
        "/opt/google/chrome/chrome",
      ],
    },
    {
      name: "Chromium",
      paths: [
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
        "/usr/lib/chromium/chromium",
      ],
    },
    {
      name: "Microsoft Edge",
      paths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"],
    },
  ];
}

/**
 * 探测本机可用的 Chromium 系浏览器。
 *
 * 顺序：环境变量 XHS_BROWSER_PATH / BROWSER_PATH > 已知安装路径 > 注册表 > PATH 命令。
 * 找不到就抛错，绝不去下载浏览器——那是旧版的行为，这里不需要。
 */
export function detectBrowser(): DetectedBrowser {
  const explicit = (process.env.XHS_BROWSER_PATH ?? process.env.BROWSER_PATH ?? "").trim();
  if (explicit) {
    const p = path.resolve(explicit);
    if (!fs.existsSync(p)) {
      throw new Error(`XHS_BROWSER_PATH 指向的文件不存在: ${p}`);
    }
    return { executablePath: p, name: path.basename(p), source: "环境变量" };
  }

  for (const c of candidates()) {
    const found = firstExisting(c.paths);
    if (found) return { executablePath: found, name: c.name, source: "已知安装路径" };
  }

  const fromReg = fromRegistry();
  if (fromReg) {
    const name = /msedge/i.test(fromReg) ? "Microsoft Edge" : "Google Chrome";
    return { executablePath: fromReg, name, source: "Windows 注册表" };
  }

  const commands = isWin
    ? ["chrome", "msedge"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "chrome"];
  const fromCmd = fromPath(commands);
  if (fromCmd) return { executablePath: fromCmd, name: path.basename(fromCmd), source: "PATH" };

  throw new Error(
    [
      "未在本机找到可用的 Chromium 系浏览器（Chrome / Edge / Chromium）。",
      "本服务不做浏览器下载，请先安装其中任意一个，或用 XHS_BROWSER_PATH 指定可执行文件绝对路径。",
      "排查命令：npm run doctor",
    ].join("\n"),
  );
}
