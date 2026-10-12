#!/usr/bin/env node
/**
 * stdio 入口。
 *
 * MCP 走 stdio 时 stdout 就是 JSON-RPC 通道，任何多余输出都会把协议打乱，
 * 所以日志一律写 stderr（见 log.ts）。
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp/server.js";
import { log } from "./log.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  log.info("xiaohongshu-mcp 已启动（stdio）");

  const shutdown = (signal: string): void => {
    log.info(`收到 ${signal}，正在关闭`);
    void server.close().finally(() => process.exit(0));
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
