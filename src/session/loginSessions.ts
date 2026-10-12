/**
 * 待扫码登录会话的登记簿。
 *
 * 取一次二维码就得留着一个浏览器等扫码，否则检测不到登录、也存不下 cookie。
 * 但没有任何东西拦着重复调用，于是每调一次就多一个浏览器活到超时为止。
 * 这里的约束是：同一时刻只保留一个待扫码会话，开新的就把旧的关掉。
 */
class LoginSessions {
  private seq = 0;
  private cancel: (() => void) | undefined;

  /** 结束上一个会话（如果有），登记新的，返回本次序号。 */
  start(cancel: () => void): number {
    const prev = this.cancel;
    this.seq += 1;
    const seq = this.seq;
    this.cancel = cancel;

    // 放到同步流程之外触发取消，避免和对端 goroutine 的收尾互相等待
    if (prev) queueMicrotask(prev);

    return seq;
  }

  /** 会话自己结束时清理登记；仅当它仍是当前会话才清。 */
  finish(seq: number): void {
    if (this.seq === seq) this.cancel = undefined;
  }
}

export const loginSessions = new LoginSessions();
