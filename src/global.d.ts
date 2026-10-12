/**
 * 小红书把首屏数据注到 window.__INITIAL_STATE__ 上。
 * 本项目的读取逻辑全部建立在这个对象上，这里补一个全局声明，
 * 免得在每个 evaluate 回调里写类型断言。
 */
declare global {
  interface Window {
    __INITIAL_STATE__?: Record<string, unknown>;
  }
}

export {};
