---
name: setup-xhs-mcp
description: |
  部署并连接小红书 MCP 服务（xiaohongshu-mcp）。当小红书相关工具不可用、提示「找不到工具」、
  首次接入、或需要确认 MCP 是否已正确连接时使用。
---

## 执行流程

### 1. 判断 MCP 是否已连接

先尝试调用 `check_login_status`：

- 能正常返回 → MCP 已连接，直接进入步骤 3 处理登录
- 报「未知工具」「tool not found」，或客户端提示服务器未启动 → MCP 尚未配置，进入步骤 2

### 2. 配置 MCP 服务

**前置条件**

| 要求 | 说明 |
|---|---|
| Node.js ≥ 18 | 运行时，客户端需要能调用 `node` |
| 本机浏览器 | 需已安装 Chrome / Edge / Chromium 之一。本 MCP **复用部署机器上已有的浏览器，不下载浏览器二进制** |
| 解压目录 | 分发包解压后应包含 `dist/`、`node_modules/`、`package.json` |

**入口**：`<解压目录>/dist/index.js`，stdio 传输。

**客户端配置示例**：

```json
{
  "mcpServers": {
    "xiaohongshu-mcp": {
      "command": "node",
      "args": ["<解压目录的绝对路径>/dist/index.js"]
    }
  }
}
```

配置后需要**重启客户端**才能生效。

### 3. 检查登录

- 返回未登录 → 引导用户使用 `xhs-login`（调用 `get_login_qrcode`）扫码
- 已登录 → 可直接使用其他小红书 skill

### 4. 连通性验证

依次调用确认整条链路可用：

1. `check_login_status` — 验证进程通信与登录态
2. `list_feeds` — 验证能正常读取页面数据（需已登录）

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 客户端找不到工具 | MCP 未配置，或 `args` 路径写错；确认为 `dist/index.js` 的**绝对路径** |
| 启动即退出 / 无响应 | 检查 Node.js 版本（需 ≥ 18）；用 `node <解压目录>/dist/index.js` 手动启动查看报错 |
| 提示找不到浏览器 | 本机未安装 Chrome/Edge/Chromium，请先安装其一；也可用 `XHS_BROWSER_PATH` 指定可执行文件 |
| 调用报「IP存在风险」（错误码 300012） | 小红书风控拦截，需更换网络环境后重试，**与 MCP 配置无关** |
| 报 `Target page, context or browser has been closed` | 上一个浏览器实例未退出，占着同一个浏览器数据目录；关闭残留浏览器窗口后重试 |
| 读取数据一直超时 | 先确认已登录；未登录时多数数据页不可用 |

## 环境变量（可选，一般无需设置）

| 变量 | 作用 |
|---|---|
| `XHS_BROWSER_PATH` | 手动指定浏览器可执行文件绝对路径（也可用 `BROWSER_PATH`） |
| `XHS_HEADLESS` | `1`/`true` 强制无头（默认无头；登录需要开窗时会自动用有头窗口） |
| `XHS_PROFILE_DIR` | 自定义浏览器数据目录，默认 `~/.xiaohongshu-mcp/profile` |
| `COOKIES_PATH` | 自定义 cookies 文件路径，默认 `~/.xiaohongshu-mcp/cookies.json` |
| `XHS_PROXY` | 代理地址，支持 http / https / socks5 |
| `XHS_TIMEOUT_MS` | 单个浏览器动作的超时毫秒数，默认 120000 |
| `XHS_FP_SEED` | 固定设备指纹 seed（>0）；不设则从会话文件读取或随机生成 |

## 约束

- 本 skill 只负责部署与连接配置，不执行业务操作
- 修改客户端配置文件前先征得用户同意
- 登录态与浏览器数据都在 `~/.xiaohongshu-mcp/` 下，与本 skill 无关
