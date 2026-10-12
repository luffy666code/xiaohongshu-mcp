/**
 * 日志一律写 stderr。
 * stdio 传输下 stdout 是 JSON-RPC 通道，往里打任何东西都会把协议流打坏。
 */
function emit(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  process.stderr.write(line + "\n");
}

/** 是否输出 debug 级日志，由 XHS_DEBUG 控制。 */
function debugEnabled(): boolean {
  const raw = (process.env.XHS_DEBUG ?? "").trim().toLowerCase();
  return raw !== "" && !["0", "false", "no", "off"].includes(raw);
}

export const log = {
  info(msg: string): void {
    emit("INFO", msg);
  },
  warn(msg: string): void {
    emit("WARN", msg);
  },
  error(msg: string): void {
    emit("ERROR", msg);
  },
  debug(msg: string): void {
    if (debugEnabled()) emit("DEBUG", msg);
  },
};
