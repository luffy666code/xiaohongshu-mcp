/** 拟人动作的类别。 */
export type Action =
  | "after_click"
  | "after_type"
  | "after_navigate"
  | "between_scroll"
  | "before_submit"
  | "before_click"
  | "reading"
  | "keystroke"
  | "after_interact";

export interface LogNormal {
  mu: number;
  sigma: number;
  min: number;
  max: number;
}

/**
 * 各类动作的等待时长分布（单位毫秒）。
 * 取对数正态分布：多数时候偏快，偶尔明显慢一下，比固定 sleep 更像人。
 */
const TIMING: Record<Action, LogNormal> = {
  after_click: { mu: Math.log(400), sigma: 0.35, min: 150, max: 2000 },
  after_type: { mu: Math.log(600), sigma: 0.4, min: 200, max: 3000 },
  after_navigate: { mu: Math.log(1500), sigma: 0.45, min: 600, max: 6000 },
  between_scroll: { mu: Math.log(800), sigma: 0.4, min: 250, max: 3000 },
  before_submit: { mu: Math.log(1000), sigma: 0.4, min: 400, max: 4000 },
  before_click: { mu: Math.log(200), sigma: 0.45, min: 80, max: 1000 },
  reading: { mu: Math.log(700), sigma: 0.4, min: 300, max: 3000 },
  keystroke: { mu: Math.log(120), sigma: 0.5, min: 30, max: 400 },
  after_interact: { mu: Math.log(2400), sigma: 0.3, min: 2000, max: 3000 },
};

/** Box-Muller，把均匀分布换成标准正态。 */
function normal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 采样一次等待时长。 */
export function sampleDelay(action: Action): number {
  const d = TIMING[action] ?? TIMING.after_click;
  const raw = Math.exp(d.mu + d.sigma * normal());
  return Math.min(Math.max(raw, d.min), d.max);
}

/** 采样一次击键间隔。 */
export function sampleKeystroke(): number {
  return sampleDelay("keystroke");
}
