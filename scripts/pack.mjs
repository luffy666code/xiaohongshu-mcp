#!/usr/bin/env node
/**
 * 打包脚本：把 MCP 服务打成一个解压即用的分发包。
 *
 * 两种形态：
 *   默认      —— 带生产依赖（node_modules），解压后 node dist/index.js 直接跑
 *   --slim    —— 只带编译产物，体积小，使用者需自行 npm install
 *
 * 输出：
 *   release/xiaohongshu-mcp/                 目录形态（便于检查）
 *   release/xiaohongshu-mcp-v<version>.zip   zip 归档（便于分发）
 *
 * zip 用内置 writer 写，不依赖外部 zip/tar 命令，保证 Windows / macOS / Linux 行为一致。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------ 参数

const argv = process.argv.slice(2);
const slim = argv.includes("--slim");
const noZip = argv.includes("--no-zip");
const keepDir = argv.includes("--keep-dir");

const outIdx = argv.indexOf("--out");
const outDir = outIdx >= 0 && argv[outIdx + 1] ? path.resolve(argv[outIdx + 1]) : path.join(root, "release");

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;

// ------------------------------------------------------------------ 工具

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });

  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (filter && !filter(entry.name, entry.isDirectory())) continue;

    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);

    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
    // 符号链接不跟随：node_modules/.bin 下的链接指向本仓库路径，拷出去没意义
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

// ------------------------------------------------------------------ zip writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

/**
 * 把目录打成 zip（deflate）。
 *
 * 自己写而不是调外部命令，是因为外部 zip/tar 在三个平台上可用性不一致，
 * 而这是个要分发给别人的产物，构建结果必须可复现。
 */
function zipDir(srcDir, zipPath, prefix) {
  const entries = [];

  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        entries.push({ name: `${prefix}${relPath}/`, isDir: true, abs: null });
        walk(abs, relPath);
      } else if (entry.isFile()) {
        entries.push({ name: `${prefix}${relPath}`, isDir: false, abs });
      }
    }
  };
  walk(srcDir, "");

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");

    let method;
    let raw;
    let comp;
    let crc;
    let size;

    if (entry.isDir) {
      method = 0;
      raw = Buffer.alloc(0);
      comp = Buffer.alloc(0);
      crc = 0;
      size = 0;
    } else {
      raw = fs.readFileSync(entry.abs);
      size = raw.length;
      crc = crc32(raw);

      comp = zlib.deflateRawSync(raw, { level: 9 });
      // 压完反而更大（小文件、已压缩格式）就原样存
      if (comp.length >= raw.length) {
        comp = raw;
        method = 0;
      } else {
        method = 8;
      }
    }

    const { time, date } = dosDateTime(new Date());

    // 目录 0o755，普通文件 0o644，带 shebang 的入口补可执行位。
    // 必须 >>> 0：外框属性超过 2^31，左移后是负数，writeUInt32LE 会报 ERR_OUT_OF_RANGE。
    const mode = entry.isDir ? 0o40755 : /(^|\/)(index|doctor)\.js$/.test(entry.name) ? 0o100755 : 0o100644;
    const extAttr = (((mode << 16) >>> 0) | (entry.isDir ? 0x10 : 0)) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(extAttr, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cdBuf, eocd]));

  return entries.length;
}

// ------------------------------------------------------------------ 主流程

log(`打包 xiaohongshu-mcp v${version}${slim ? "（slim 形态）" : ""}`);

if (!fs.existsSync(path.join(root, "dist", "index.js"))) {
  log("未找到 dist/index.js，请先执行 npm run build");
  process.exit(1);
}

const stageName = "xiaohongshu-mcp";
const stage = path.join(outDir, stageName);
rmrf(stage);
fs.mkdirSync(stage, { recursive: true });

// 1) 编译产物
copyDir(path.join(root, "dist"), path.join(stage, "dist"));
log("  + dist/");

// 2) 生产 package.json：去掉 devDependencies 与开发用脚本
const runtimePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  bin: pkg.bin,
  engines: pkg.engines,
  dependencies: pkg.dependencies,
  files: pkg.files,
};
fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);
log("  + package.json（已裁掉 devDependencies）");

for (const f of ["README.md", "LICENSE"]) {
  if (fs.existsSync(path.join(root, f))) {
    fs.copyFileSync(path.join(root, f), path.join(stage, f));
    log(`  + ${f}`);
  } else {
    // 静默跳过会让产物少文件却不自知，明确告警
    log(`  ! ${f} 不存在，未打进包里`);
  }
}

// 3) 依赖
if (!slim) {
  const devNames = new Set(Object.keys(pkg.devDependencies ?? {}));
  const nmFrom = path.join(root, "node_modules");

  if (!fs.existsSync(nmFrom)) {
    log("未找到 node_modules，请先执行 npm install");
    process.exit(1);
  }

  copyDir(nmFrom, path.join(stage, "node_modules"), (name) => !devNames.has(name));
  log("  + node_modules/（已排除开发依赖）");
} else {
  log("  - node_modules/（slim，使用者需自行 npm install --omit=dev）");
}

// 4) MCP 客户端配置示例
const example = {
  mcpServers: {
    xiaohongshu: {
      command: "node",
      args: ["<此处替换为解压后的绝对路径>/dist/index.js"],
      env: {
        COOKIES_PATH: "<此处替换为解压后的绝对路径>/cookies.json",
      },
    },
  },
};
fs.writeFileSync(path.join(stage, "mcp-config.example.json"), `${JSON.stringify(example, null, 2)}\n`);
log("  + mcp-config.example.json");

const rawBytes = dirSize(stage);
log(`\n目录就绪: ${stage}（${(rawBytes / 1024 / 1024).toFixed(1)} MB）`);

// 5) 归档
let zipPath = "";
if (!noZip) {
  zipPath = path.join(outDir, `${stageName}-v${version}${slim ? "-slim" : ""}.zip`);
  const n = zipDir(stage, zipPath, `${stageName}/`);
  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
  log(`归档完成: ${zipPath}（${n} 个条目，${mb} MB）`);
}

if (!keepDir) rmrf(stage);

log("\n用法：解压后在 MCP 客户端里指向 <目录>/dist/index.js 即可。");
log("首次使用调用 get_login_qrcode，会弹出浏览器窗口扫码。");
