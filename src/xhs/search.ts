import { gotoWithRetry } from "./nav.js";
import type { Page } from "playwright-core";
import { delay } from "../humanize/delay.js";
import { readStateArray, readStateAt, searchUrl, waitForInitialState } from "./state.js";
import { onlyNotes, type Feed, type FilterOption } from "./types.js";

/** 面板上的一个筛选组：标签文本、默认取值、从入参取值的函数、合法取值。 */
interface FilterGroup {
  label: string;
  defaultValue: string;
  pick: (f: FilterOption) => string | undefined;
  allowed: string[];
}

const FILTER_GROUPS: FilterGroup[] = [
  {
    label: "排序依据",
    defaultValue: "综合",
    pick: (f) => f.sort_by,
    allowed: ["综合", "最新", "最多点赞", "最多评论", "最多收藏"],
  },
  { label: "笔记类型", defaultValue: "不限", pick: (f) => f.note_type, allowed: ["不限", "视频", "图文"] },
  { label: "发布时间", defaultValue: "不限", pick: (f) => f.publish_time, allowed: ["不限", "一天内", "一周内", "半年内"] },
  { label: "搜索范围", defaultValue: "不限", pick: (f) => f.search_scope, allowed: ["不限", "已看过", "未看过", "已关注"] },
  { label: "位置距离", defaultValue: "不限", pick: (f) => f.location, allowed: ["不限", "同城", "附近"] },
];

interface PendingFilter {
  group: string;
  option: string;
}

/**
 * 整理待应用的筛选项，顺便校验取值。
 *
 * 校验放在这里是为了在打开浏览器之前就挡掉写错的值——
 * 否则要等导航、悬停、在面板里找不到之后才能报错。
 */
export function collectFilters(filters: FilterOption[]): PendingFilter[] {
  const selected = new Map<string, string>();

  for (const f of filters ?? []) {
    for (const g of FILTER_GROUPS) {
      const value = g.pick(f);
      if (!value) continue;
      if (!g.allowed.includes(value)) {
        throw new Error(`${g.label} 不支持 "${value}"，可选：${g.allowed.join("、")}`);
      }
      selected.set(g.label, value);
    }
  }

  const pending: PendingFilter[] = [];
  for (const g of FILTER_GROUPS) {
    const value = selected.get(g.label);
    if (!value || value === g.defaultValue) continue;
    pending.push({ group: g.label, option: value });
  }

  return pending;
}

/** 读当前结果的 id 列表，用来判断数据有没有换一批。 */
async function readFeedIds(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const s = window.__INITIAL_STATE__ as Record<string, unknown> | undefined;
      const search = s?.search as { feeds?: { value?: unknown[]; _value?: unknown[] } } | undefined;
      const feeds = search?.feeds;
      const list = feeds?.value ?? feeds?._value;
      return Array.isArray(list) ? list.map((x: unknown) => (x as { id?: string })?.id ?? "").join(",") : "";
    })
    .catch(() => "");
}

/** 等筛选后的数据到位。超时不报错：筛选已经点上了，宁可返回偏旧的数据。 */
async function waitFeedsChanged(page: Page, before: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await readFeedIds(page);
    if (now && now !== before) return;
    await page.waitForTimeout(300);
  }
}

/** 在筛选面板里定位一个选项：按标签找组，再在组内按文本找选项。 */
async function clickFilterOption(page: Page, pending: PendingFilter): Promise<void> {
  const groups = page.locator("div.filter-panel div.filters");
  const count = await groups.count();

  for (let i = 0; i < count; i++) {
    const group = groups.nth(i);
    const label = (await group.locator("xpath=./span").first().innerText().catch(() => "")).trim();
    if (label !== pending.group) continue;

    const options = group.locator("div.tags");
    const optionCount = await options.count();
    const available: string[] = [];

    for (let j = 0; j < optionCount; j++) {
      const opt = options.nth(j);
      const text = (await opt.innerText().catch(() => "")).trim();
      available.push(text);
      if (text !== pending.option) continue;
      if (!(await opt.isVisible().catch(() => false))) continue;

      await opt.click({ timeout: 5_000, noWaitAfter: true }).catch(async () => {
        await opt.click({ timeout: 5_000, force: true, noWaitAfter: true });
      });
      return;
    }

    throw new Error(`「${pending.group}」里没有选项「${pending.option}」，页面上是：${available.join("、")}`);
  }

  throw new Error(`筛选面板里没有「${pending.group}」这一组`);
}

/** 搜索笔记。 */
export async function searchFeeds(page: Page, keyword: string, filters: FilterOption[] = []): Promise<Feed[]> {
  const pending = collectFilters(filters);

  await gotoWithRetry(page, searchUrl(keyword));
  await waitForInitialState(page, 20_000);
  await delay("after_navigate");

  if (pending.length > 0) {
    await page.locator("div.filter").first().hover({ timeout: 10_000 });
    await page.waitForSelector("div.filter-panel", { timeout: 10_000 });

    const before = await readFeedIds(page);

    for (const pf of pending) {
      await delay("before_click");
      await clickFilterOption(page, pf);
      await page.waitForTimeout(500);
    }

    await waitFeedsChanged(page, before);
  }

  const feeds = await readStateArray<Feed>(page, "search.feeds", 12_000);
  if (!feeds || feeds.length === 0) throw new Error("没有捕获到搜索结果数据");

  return onlyNotes(feeds);
}
