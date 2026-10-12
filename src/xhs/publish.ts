import { gotoWithRetry } from "./nav.js";
import fs from "node:fs";
import type { Locator, Page } from "playwright-core";
import { CREATOR_HOME_URL, PUBLISH_URL, TAGS_MAX } from "../config.js";
import { delay, sleep } from "../humanize/delay.js";
import { selectAll, typeInto } from "../humanize/typing.js";
import { log } from "../log.js";

/** 创作者中心的会话 cookie，没有它说明创作者侧登录已失效。 */
const CREATOR_SESSION_COOKIE = "galaxy_creator_session_id";

/** 发布页 TAB 容器，先等它出现再去点 TAB。 */
const SELECTOR_UPLOAD_CONTENT = "div.upload-content";
/** 发布 TAB（上传图文 / 上传视频）。 */
const SELECTOR_CREATOR_TAB = "div.creator-tab";
/** 挡住 TAB 的浮层。 */
const SELECTOR_POPOVER = "div.d-popover";
/** 标题输入框。 */
const SELECTOR_TITLE = "div.d-input input";
/** 图片上传后的预览项，数量即已上传张数。 */
const SELECTOR_IMAGE_PREVIEW = ".img-preview-area .pr";
/** 标题字数提示。 */
const SELECTOR_TITLE_LENGTH = "div.title-container div.max_suffix";
/** 正文字数提示。 */
const SELECTOR_CONTENT_LENGTH = "div.edit-container div.length-error";
/** 功能引导卡，会挡住后续点击。 */
const SELECTOR_FEATURE_GUIDE = ".feature-guide__btn";
/** 标签联想下拉框。 */
const SELECTOR_TOPIC_CONTAINER = "#creator-editor-topic-container";
/** 定时发布开关。 */
const SELECTOR_SCHEDULE_SWITCH = ".post-time-wrapper .d-switch";
/** 定时发布时间输入框。 */
const SELECTOR_SCHEDULE_INPUT = ".date-picker-container input";
/** 可见范围下拉框与选项。 */
const SELECTOR_VISIBILITY = "div.permission-card-wrapper div.d-select-content";
const SELECTOR_VISIBILITY_OPTION = "div.d-options-wrapper div.d-grid-item div.custom-option";
/** 原创声明卡片。 */
const SELECTOR_SWITCH_CARD = "div.custom-switch-card";
/** 商品选择弹窗。 */
const SELECTOR_PRODUCT_MODAL = ".multi-goods-selector-modal";
/** 商品搜索框。 */
const SELECTOR_PRODUCT_SEARCH = 'input[placeholder="搜索商品ID 或 商品名称"]';

/** 正文输入框的候选选择器，按先后顺序尝试。 */
const CONTENT_SELECTORS = [
  'div[role="textbox"][contenteditable="true"]',
  'div.tiptap[contenteditable="true"]',
  "div.ql-editor",
];

/** 正文占位符，用于兜底定位。 */
const CONTENT_PLACEHOLDER = "输入正文描述";

/** 发布内容的通用字段。 */
export interface PublishContent {
  title: string;
  content: string;
  tags?: string[];
  /** 定时发布时间（ISO8601），留空表示立即发布。 */
  scheduleAt?: Date;
  /** 是否声明原创（仅图文）。 */
  isOriginal?: boolean;
  /** 可见范围：公开可见（默认）/ 仅自己可见 / 仅互关好友可见。 */
  visibility?: string;
  /** 商品关键词，用于绑定带货商品。 */
  products?: string[];
}

// ---------------------------------------------------------------- 创作者会话

async function hasCreatorSession(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies().catch(() => []);
  return cookies.some((c) => c.name === CREATOR_SESSION_COOKIE);
}

/**
 * 确保浏览器里已有创作者中心会话。
 *
 * 发布页在 creator 域下，www 侧的登录态不能直接带过去，
 * 少了 galaxy_creator_session_id 就会被踢回登录。
 */
export async function ensureCreatorSession(page: Page): Promise<void> {
  if (await hasCreatorSession(page)) return;

  await gotoWithRetry(page, CREATOR_HOME_URL);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await hasCreatorSession(page)) {
      await delay("after_navigate");
      return;
    }
  }

  throw new Error("创作者中心登录失效，请重新扫码登录");
}

// ------------------------------------------------------------------ 发布页

/** 判断元素中心点是否被别的元素盖住。 */
async function isBlocked(locator: Locator): Promise<boolean> {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return true;

  try {
    return await handle.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return true;
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !(target === el || el.contains(target));
    });
  } catch {
    return true;
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

async function hasPopCover(page: Page): Promise<boolean> {
  return (await page.locator(SELECTOR_POPOVER).count().catch(() => 0)) > 0;
}

/** 点一个页面顶部空白处，把浮层的焦点让开。 */
async function clickEmptyPosition(page: Page): Promise<void> {
  const x = 380 + Math.floor(Math.random() * 100);
  const y = 20 + Math.floor(Math.random() * 60);
  await page.mouse.click(x, y).catch(() => undefined);
}

/**
 * 关掉挡住发布 TAB 的浮层：Esc → 点空白 → 摘节点逐级降级。
 * 保留摘节点是因为它只要节点还在就必定生效，前两步是否奏效取决于页面自己有没有写对应处理。
 */
async function dismissPopCover(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await sleep(200);
  if (!(await hasPopCover(page))) return;

  await clickEmptyPosition(page);
  await sleep(200);
  if (!(await hasPopCover(page))) return;

  log.warn("Esc 与点击空白都未能关闭浮层，改为移除该节点");
  await page.locator(SELECTOR_POPOVER).first().evaluate((el) => el.remove()).catch(() => undefined);
}

/** 按文本找发布 TAB，并报告它当前是否被遮挡。 */
async function findTab(page: Page, tabName: string): Promise<{ tab: Locator; blocked: boolean } | null> {
  const tabs = page.locator(SELECTOR_CREATOR_TAB);
  const count = await tabs.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    if (!(await tab.isVisible().catch(() => false))) continue;

    const text = ((await tab.textContent().catch(() => "")) ?? "").trim();
    if (text !== tabName) continue;

    return { tab, blocked: await isBlocked(tab) };
  }

  return null;
}

async function mustClickPublishTab(page: Page, tabName: string): Promise<void> {
  await page.waitForSelector(SELECTOR_UPLOAD_CONTENT, { state: "visible", timeout: 30_000 });

  const deadline = Date.now() + 15_000;
  let blockedAtLeastOnce = false;

  while (Date.now() < deadline) {
    const found = await findTab(page, tabName).catch(() => null);
    if (!found) {
      await sleep(200);
      continue;
    }

    if (found.blocked) {
      blockedAtLeastOnce = true;
      log.info("发布 TAB 被遮挡，尝试关闭浮层");
      await dismissPopCover(page);
      await sleep(200);
      continue;
    }

    try {
      await delay("before_click");
      await found.tab.click({ timeout: 5_000 });
      await delay("after_click");
      return;
    } catch (err) {
      log.warn(`点击发布 TAB 失败: ${String(err)}`);
      await sleep(200);
    }
  }

  // 区分两种失败：找不到 TAB，和找到了但浮层一直关不掉
  if (blockedAtLeastOnce) {
    throw new Error(`发布 TAB ${tabName} 一直被浮层遮挡，Esc 与点击空白都未能关闭`);
  }
  throw new Error(`没有找到发布 TAB - ${tabName}`);
}

/** 进入发布页并切到指定 TAB。 */
async function openPublishPage(page: Page, tabName: string): Promise<void> {
  await ensureCreatorSession(page);

  // 发布页加载慢也继续往下走：后续的选择器等待才是真正的成功判据
  await gotoWithRetry(page, PUBLISH_URL, { attempts: 2, timeoutMs: 30_000 }).catch((err) => {
    log.warn(`等待发布页加载出现问题: ${String(err)}，继续尝试`);
  });
  await sleep(2000);

  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
  await sleep(1000);

  try {
    await mustClickPublishTab(page, tabName);
  } catch (err) {
    log.error(`切换到「${tabName}」失败: ${String(err)}`);
    throw err;
  }

  await sleep(1000);
}

// ------------------------------------------------------------------ 上传素材

function acceptsImage(accept: string): boolean {
  const a = accept.toLowerCase();
  if (a.includes("image/")) return true;
  return [".jpg", ".jpeg", ".png", ".webp", ".heic"].some((ext) => a.includes(ext));
}

/** 找图片上传输入框：首张用专用 class，之后在页面所有 file input 里挑接受图片的。 */
async function findImageUploadInput(page: Page, first: boolean): Promise<Locator> {
  if (first) {
    const input = page.locator(".upload-input").first();
    if ((await input.count().catch(() => 0)) > 0) return input;
  }

  const inputs = page.locator('input[type="file"]');
  const count = await inputs.count().catch(() => 0);
  if (count === 0) throw new Error("页面没有文件上传输入框");

  for (let i = 0; i < count; i++) {
    const accept = (await inputs.nth(i).getAttribute("accept").catch(() => null)) ?? "";
    if (acceptsImage(accept)) return inputs.nth(i);
  }

  return inputs.first();
}

/** 等第 expected 张图上传完成（预览项数量达标），最多等 60 秒。 */
async function waitForUploadComplete(page: Page, expected: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastLogged = expected - 1;

  while (Date.now() < deadline) {
    const count = await page.locator(SELECTOR_IMAGE_PREVIEW).count().catch(() => 0);
    if (count !== lastLogged) {
      log.info(`等待图片上传 current=${count} expected=${expected}`);
      lastLogged = count;
    }
    if (count >= expected) {
      log.info(`图片上传完成 count=${count}`);
      return;
    }
    await sleep(500);
  }

  throw new Error(`第${expected}张图片上传超时(60s)，请检查网络连接和图片大小`);
}

/**
 * 逐张上传图片。
 *
 * 一张一张来而不是一次性 setInputFiles：站点是逐张处理并回填预览的，
 * 批量提交时预览数量对不上，无法判断到底成功了几张。
 */
async function uploadImages(page: Page, imagePaths: string[]): Promise<number> {
  const valid = imagePaths.filter((p) => {
    if (fs.existsSync(p)) return true;
    log.warn(`图片文件不存在: ${p}`);
    return false;
  });

  if (valid.length === 0) throw new Error("没有可用的图片文件");

  for (let i = 0; i < valid.length; i++) {
    const input = await findImageUploadInput(page, i === 0);
    await input.setInputFiles(valid[i], { timeout: 30_000 });
    log.info(`图片已提交上传 index=${i + 1} path=${valid[i]}`);

    await waitForUploadComplete(page, i + 1);
    await sleep(1000);
  }

  return valid.length;
}

/** 上传视频，等到发布按钮变可点击才算处理完成。 */
async function uploadVideo(page: Page, videoPath: string): Promise<void> {
  if (!fs.existsSync(videoPath)) throw new Error(`视频文件不存在: ${videoPath}`);

  let input = page.locator(".upload-input").first();
  if ((await input.count().catch(() => 0)) === 0) {
    input = page.locator('input[type="file"]').first();
    if ((await input.count().catch(() => 0)) === 0) throw new Error("未找到视频上传输入框");
  }

  await input.setInputFiles(videoPath, { timeout: 60_000 });

  // 视频要转码，等发布按钮可点击才表示处理完
  await waitForPublishButtonClickable(page, 10 * 60_000);
  log.info("视频上传/处理完成，发布按钮已可点击");
}

// ------------------------------------------------------------------ 填写表单

async function findTextboxByPlaceholder(page: Page): Promise<Locator | null> {
  const ps = page.locator(`p[data-placeholder*="${CONTENT_PLACEHOLDER}"]`);
  const count = await ps.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const el = ps.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;

    // 向上找最近的 role=textbox 祖先，最多 5 层
    const box = el.locator('xpath=ancestor::*[position()<=5][@role="textbox"][1]');
    if ((await box.count().catch(() => 0)) > 0) return box.first();
  }

  return null;
}

async function findContentElement(page: Page): Promise<Locator | null> {
  for (const selector of CONTENT_SELECTORS) {
    const loc = page.locator(selector);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
    }
  }
  return findTextboxByPlaceholder(page);
}

/** 正文输入框要在 10 秒内轮询找：编辑器是异步挂载的，一上来就找会落空。 */
async function getContentElement(page: Page): Promise<Locator> {
  const deadline = Date.now() + 10_000;

  while (true) {
    const el = await findContentElement(page).catch(() => null);
    if (el) return el;
    if (Date.now() > deadline) throw new Error("查找正文输入框失败");
    await sleep(300);
  }
}

function maxLengthError(text: string): Error {
  const parts = text.split("/");
  if (parts.length !== 2) return new Error(`长度超过限制: ${text}`);
  return new Error(`当前输入长度为${parts[0]}，最大长度为${parts[1]}`);
}

async function checkTitleMaxLength(page: Page): Promise<void> {
  const el = page.locator(SELECTOR_TITLE_LENGTH).first();
  if ((await el.count().catch(() => 0)) === 0) return;
  throw maxLengthError((await el.textContent().catch(() => "")) ?? "");
}

async function checkContentMaxLength(page: Page): Promise<void> {
  const el = page.locator(SELECTOR_CONTENT_LENGTH).first();
  if ((await el.count().catch(() => 0)) === 0) return;
  throw maxLengthError((await el.textContent().catch(() => "")) ?? "");
}

async function closeFeatureGuide(page: Page): Promise<void> {
  const btn = page.locator(SELECTOR_FEATURE_GUIDE).first();
  if ((await btn.count().catch(() => 0)) === 0) return;
  if (!(await btn.isVisible().catch(() => false))) return;

  await btn.click({ timeout: 5_000 }).catch((err) => log.warn(`关闭功能引导卡失败: ${String(err)}`));
}

/** 输入单个标签：靠 # 触发联想，点联想项而不是直接打空格，否则标签不会生效。 */
async function inputTag(page: Page, contentElem: Locator, rawTag: string): Promise<void> {
  const tag = rawTag.replace(/^#+/, "");
  if (!tag) return;

  await contentElem.click({ timeout: 10_000 });
  await page.keyboard.type("#");
  await sleep(200);

  await typeInto(page, contentElem, tag);
  await sleep(1000);

  const container = page.locator(SELECTOR_TOPIC_CONTAINER).first();
  const item = container.locator(".item").first();

  if ((await container.count().catch(() => 0)) === 0 || (await item.count().catch(() => 0)) === 0) {
    log.warn(`未找到标签联想下拉框，直接输入空格 tag=${tag}`);
    await page.keyboard.type(" ");
    return;
  }

  await delay("before_click");
  await item.click({ timeout: 5_000 });
  log.info(`成功点击标签联想选项 tag=${tag}`);
  await sleep(500);
}

async function inputTags(page: Page, contentElem: Locator, tags: string[]): Promise<void> {
  if (tags.length === 0) return;

  await sleep(1000);

  // 光标先移到正文末尾，否则标签会插进正文中间
  await contentElem.click({ timeout: 10_000 });
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(10);
  }
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await sleep(1000);

  for (const tag of tags) await inputTag(page, contentElem, tag);
}

// ---------------------------------------------------------------- 可见范围等设置

async function setVisibility(page: Page, visibility: string): Promise<void> {
  if (!visibility || visibility === "公开可见") {
    log.info("可见范围使用默认：公开可见");
    return;
  }

  if (visibility !== "仅自己可见" && visibility !== "仅互关好友可见") {
    throw new Error(`不支持的可见范围: ${visibility}，支持: 公开可见、仅自己可见、仅互关好友可见`);
  }

  const dropdown = page.locator(SELECTOR_VISIBILITY).first();
  await delay("before_click");
  await dropdown.click({ timeout: 10_000 });
  await sleep(500);

  const options = page.locator(SELECTOR_VISIBILITY_OPTION);
  const count = await options.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent().catch(() => "")) ?? "";
    if (!text.includes(visibility)) continue;

    await delay("before_click");
    await options.nth(i).click({ timeout: 5_000 });
    log.info(`已设置可见范围 visibility=${visibility}`);
    await sleep(200);
    return;
  }

  throw new Error(`未找到可见范围选项: ${visibility}`);
}

function formatDateTime(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function setSchedulePublish(page: Page, at: Date): Promise<void> {
  const sw = page.locator(SELECTOR_SCHEDULE_SWITCH).first();
  await delay("before_click");
  await sw.click({ timeout: 10_000 });
  log.info("已点击定时发布开关");
  await sleep(800);

  const input = page.locator(SELECTOR_SCHEDULE_INPUT).first();
  await input.click({ timeout: 10_000 });
  await selectAll(page);
  await typeInto(page, input, formatDateTime(at));
  log.info(`已设置日期时间 datetime=${formatDateTime(at)}`);
  await sleep(500);
}

async function findFooterByText(page: Page, keyword: string): Promise<Locator | null> {
  const footers = page.locator("div.footer");
  const count = await footers.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const text = (await footers.nth(i).textContent().catch(() => "")) ?? "";
    if (text.includes(keyword)) return footers.nth(i);
  }
  return null;
}

async function isButtonDisabled(btn: Locator): Promise<boolean> {
  if ((await btn.getAttribute("disabled").catch(() => null)) !== null) return true;
  const cls = (await btn.getAttribute("class").catch(() => "")) ?? "";
  return /\bdisabled\b/.test(cls);
}

/** 勾选弹窗 footer 内的须知 checkbox，已勾选则跳过。 */
async function checkFooterCheckbox(footer: Locator): Promise<void> {
  const cb = footer.locator("div.d-checkbox").first();
  if ((await cb.count().catch(() => 0)) === 0) {
    log.warn("未找到须知 checkbox");
    return;
  }

  const checked = await cb
    .evaluate((el) => {
      const input = el.querySelector('input[type="checkbox"]');
      return (input instanceof HTMLInputElement && input.checked) || el.querySelector(".checked") !== null;
    })
    .catch(() => false);

  if (checked) return;

  await delay("before_click");
  await cb.click({ timeout: 5_000 }).catch((err) => log.warn(`勾选须知失败: ${String(err)}`));
}

async function confirmOriginalDeclaration(page: Page): Promise<void> {
  await sleep(800);

  const notice = await findFooterByText(page, "原创声明须知");
  if (notice) {
    await checkFooterCheckbox(notice);
  } else {
    log.warn("未找到原创声明确认弹窗的 footer");
  }

  await sleep(500);

  const footer = await findFooterByText(page, "声明原创");
  if (!footer) throw new Error("未找到声明原创弹窗");

  const btn = footer.locator("button.custom-button").first();
  if ((await btn.count().catch(() => 0)) === 0) throw new Error("未找到声明原创按钮");

  if (await isButtonDisabled(btn)) {
    // 兜底：按钮仍禁用，多半是须知没勾上，再勾一次
    await checkFooterCheckbox(footer);
    await sleep(300);
    if (await isButtonDisabled(btn)) throw new Error("声明原创按钮仍处于禁用状态");
  }

  await delay("before_click");
  await btn.click({ timeout: 10_000 });
  log.info("已成功点击声明原创按钮");
  await sleep(300);
}

async function setOriginal(page: Page): Promise<void> {
  const cards = page.locator(SELECTOR_SWITCH_CARD);
  const count = await cards.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const text = (await card.textContent().catch(() => "")) ?? "";
    if (!text.includes("原创声明")) continue;

    const sw = card.locator("div.d-switch").first();
    if ((await sw.count().catch(() => 0)) === 0) continue;

    const checked = await sw
      .evaluate((el) => {
        const input = el.querySelector('input[type="checkbox"]');
        return input instanceof HTMLInputElement ? input.checked : false;
      })
      .catch(() => false);

    if (checked) {
      log.info("原创声明已开启");
      return;
    }

    await delay("before_click");
    await sw.click({ timeout: 10_000 });
    await sleep(500);
    await confirmOriginalDeclaration(page);
    log.info("已开启原创声明");
    return;
  }

  throw new Error("未找到原创声明选项");
}

// ------------------------------------------------------------------ 绑定商品

async function clickAddProductButton(page: Page): Promise<void> {
  const spans = page.locator("span.d-text");
  const count = await spans.count().catch(() => 0);

  for (let i = 0; i < count; i++) {
    const span = spans.nth(i);
    const text = ((await span.textContent().catch(() => "")) ?? "").trim();
    if (text !== "添加商品") continue;

    // 文本在 span 上，可点击的是它外层的按钮
    const btn = span.locator('xpath=ancestor::*[position()<=5][self::button or contains(@class,"d-button")][1]');
    if ((await btn.count().catch(() => 0)) === 0) continue;

    await delay("before_click");
    await btn.first().click({ timeout: 10_000 });
    log.info("已点击添加商品按钮");
    await sleep(300);
    return;
  }

  throw new Error("未找到添加商品按钮，账号可能未开通商品功能");
}

async function waitForProductModal(page: Page): Promise<Locator> {
  const modal = page.locator(SELECTOR_PRODUCT_MODAL);
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const el = modal.first();
    if ((await modal.count().catch(() => 0)) > 0 && (await el.isVisible().catch(() => false))) {
      log.info("商品选择弹窗已出现");
      return el;
    }
    await sleep(100);
  }

  throw new Error("等待商品选择弹窗超时");
}

async function searchAndSelectProduct(page: Page, modal: Locator, keyword: string): Promise<void> {
  const searchInput = modal.locator(SELECTOR_PRODUCT_SEARCH).first();
  if ((await searchInput.count().catch(() => 0)) === 0) throw new Error("未找到商品搜索框");

  await searchInput.click({ timeout: 5_000 });
  await selectAll(page);
  await sleep(100);
  await typeInto(page, searchInput, keyword);
  await sleep(300);

  await page.keyboard.press("Enter");
  await sleep(1000);

  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const loading = modal.locator(".goods-list-loading").first();
    if ((await loading.count().catch(() => 0)) === 0) break;
    if (!(await loading.isVisible().catch(() => false))) break;
    await sleep(100);
  }

  while (Date.now() < deadline) {
    const n = await modal.locator(".goods-list-normal .good-card-container").count().catch(() => 0);
    if (n > 0) break;
    await sleep(100);
  }
  await sleep(500);

  const checkbox = modal.locator(".goods-list-normal .good-card-container .d-checkbox").first();
  if ((await checkbox.count().catch(() => 0)) === 0) throw new Error("未找到商品选择框");

  const isChecked = await checkbox
    .evaluate(
      (el) =>
        el.querySelector(".d-checkbox-simulator.checked") !== null ||
        el.querySelector('input[type="checkbox"]:checked') !== null,
    )
    .catch(() => false);

  if (isChecked) {
    log.info(`商品已选中，跳过 keyword=${keyword}`);
    return;
  }

  await delay("before_click");
  await checkbox.click({ timeout: 5_000 });
  await sleep(800 + Math.floor(Math.random() * 700));
  log.info(`已选择商品 keyword=${keyword}`);
}

async function clickModalSaveButton(modal: Locator): Promise<void> {
  const btn = modal.locator(".goods-selected-footer button").first();
  if ((await btn.count().catch(() => 0)) > 0) {
    await delay("before_click");
    await btn.click({ timeout: 5_000 }).catch((err) => log.warn(`点击保存按钮失败: ${String(err)}`));
    return;
  }

  const primary = modal.locator(".goods-selected-footer .d-button--primary").first();
  if ((await primary.count().catch(() => 0)) > 0) {
    await delay("before_click");
    await primary.click({ timeout: 5_000 }).catch((err) => log.warn(`点击主按钮失败: ${String(err)}`));
    return;
  }

  log.warn("未找到保存按钮，继续执行");
}

async function waitForModalClose(page: Page): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await page.locator(SELECTOR_PRODUCT_MODAL).count().catch(() => 0)) === 0) {
      log.info("弹窗已关闭");
      return;
    }
    await sleep(200);
  }
  log.warn("等待弹窗关闭超时");
}

async function bindProducts(page: Page, products: string[]): Promise<void> {
  if (products.length === 0) return;

  log.info(`开始绑定商品 products=${products.join(", ")}`);

  await clickAddProductButton(page);
  await sleep(1000);

  const modal = await waitForProductModal(page);

  const failed: string[] = [];
  for (const keyword of products) {
    try {
      await searchAndSelectProduct(page, modal, keyword);
    } catch (err) {
      log.warn(`搜索选择商品失败 keyword=${keyword}: ${String(err)}`);
      failed.push(keyword);
    }
    await sleep(500);
  }

  await clickModalSaveButton(modal);
  await waitForModalClose(page);

  if (failed.length > 0) throw new Error(`部分商品未找到: ${failed.join(", ")}`);

  log.info(`商品绑定完成 total=${products.length}`);
  await sleep(1000);
}

// ------------------------------------------------------------------ 提交发布

interface PublishButton {
  locator: Locator;
  isWidget: boolean;
}

/** 找发布按钮：优先新版 xhs-publish-btn 自定义组件，回退旧版 button.bg-red。 */
async function findPublishButton(page: Page): Promise<{ btn: PublishButton; disabledReason: string } | null> {
  const widgets = page.locator("xhs-publish-btn");
  const widgetCount = await widgets.count().catch(() => 0);

  for (let i = 0; i < widgetCount; i++) {
    const widget = widgets.nth(i);
    if (!(await widget.isVisible().catch(() => false))) continue;

    if ((await widget.getAttribute("is-publish").catch(() => null)) === "false") continue;

    if ((await widget.getAttribute("submit-disabled").catch(() => null)) === "true") {
      return { btn: { locator: widget, isWidget: true }, disabledReason: "新版发布按钮不可点击" };
    }
    return { btn: { locator: widget, isWidget: true }, disabledReason: "" };
  }

  const oldButtons = page.locator(".publish-page-publish-btn button.bg-red");
  const oldCount = await oldButtons.count().catch(() => 0);

  for (let i = 0; i < oldCount; i++) {
    const btn = oldButtons.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;

    if ((await btn.getAttribute("disabled").catch(() => null)) !== null) {
      return { btn: { locator: btn, isWidget: false }, disabledReason: "旧版发布按钮 disabled" };
    }
    if ((await btn.getAttribute("aria-disabled").catch(() => null)) === "true") {
      return { btn: { locator: btn, isWidget: false }, disabledReason: "旧版发布按钮 aria-disabled=true" };
    }
    const cls = (await btn.getAttribute("class").catch(() => "")) ?? "";
    if (/\bdisabled\b/.test(cls)) {
      return { btn: { locator: btn, isWidget: false }, disabledReason: "旧版发布按钮包含 disabled class" };
    }
    return { btn: { locator: btn, isWidget: false }, disabledReason: "" };
  }

  return null;
}

async function waitForPublishButtonClickable(page: Page, maxWaitMs: number): Promise<PublishButton> {
  const start = Date.now();
  let lastReason = "";

  log.info("开始等待发布按钮可点击");

  while (Date.now() - start < maxWaitMs) {
    const found = await findPublishButton(page).catch(() => null);
    if (found) {
      if (!found.disabledReason) return found.btn;
      lastReason = found.disabledReason;
    }
    await sleep(1000);
  }

  throw new Error(lastReason ? `等待发布按钮可点击超时: ${lastReason}` : "等待发布按钮可点击超时");
}

/** 新版发布按钮是自定义组件，点中心会被内部元素吃掉，按 65% 宽的位置点。 */
async function clickPublishWidget(page: Page, widget: Locator): Promise<void> {
  await widget.scrollIntoViewIfNeeded({ timeout: 10_000 }).catch(() => undefined);
  await sleep(200);

  const box = await widget.boundingBox();
  if (!box) throw new Error("获取新版发布按钮位置失败: 无可点击区域");

  await page.mouse.click(box.x + box.width * 0.65, box.y + box.height / 2);
}

async function clickPublishButton(page: Page): Promise<void> {
  const btn = await waitForPublishButtonClickable(page, 15_000);

  await delay("before_submit");

  if (btn.isWidget) {
    await clickPublishWidget(page, btn.locator);
    return;
  }
  await btn.locator.click({ timeout: 10_000 });
}

/**
 * 校验发布真的成功。
 *
 * 发布成功后创作平台会跳转离开发布表单页（URL 不再含 /publish/publish）；
 * 没跳转就是没过校验，不能因为"点了按钮"就报成功。
 */
async function waitPublishSuccess(page: Page, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const url = page.url();
    if (url && !url.includes("/publish/publish")) {
      log.info(`发布成功，已跳转离开发布页 url=${url}`);
      return;
    }
    if (Date.now() > deadline) {
      throw new Error("发布未确认成功：点击发布后未跳转离开发布页（可能校验未过或被拦截）");
    }
    await sleep(500);
  }
}

interface SubmitOptions extends PublishContent {
  /** 图文才做长度校验与原创声明。 */
  isImage: boolean;
}

async function submitPublish(page: Page, opts: SubmitOptions): Promise<void> {
  const titleElem = page.locator(SELECTOR_TITLE).first();

  await typeInto(page, titleElem, opts.title);
  await delay("after_type");

  if (opts.isImage) await checkTitleMaxLength(page);
  await delay("after_type");

  const contentElem = await getContentElement(page);
  await typeInto(page, contentElem, opts.content);
  if (opts.isImage) await closeFeatureGuide(page);

  // 回点标题输入框，把光标从正文里挪出来，后续交互才稳
  log.info("正文填写完成，回点标题输入框");
  await sleep(1000);
  await titleElem.click({ timeout: 10_000 });

  await inputTags(page, contentElem, opts.tags ?? []);
  await delay("after_type");

  if (opts.isImage) await checkContentMaxLength(page);

  if (opts.scheduleAt) await setSchedulePublish(page, opts.scheduleAt);

  await setVisibility(page, opts.visibility ?? "");

  // 原创声明失败就中止，不静默发成非原创
  if (opts.isImage && opts.isOriginal) {
    try {
      await setOriginal(page);
    } catch (err) {
      throw new Error(`设置原创声明失败（已请求原创，中止发布）: ${String(err)}`);
    }
  }

  await bindProducts(page, opts.products ?? []);

  await clickPublishButton(page);
  await waitPublishSuccess(page);
}

// ---------------------------------------------------------------- 对外入口

/** 发布图文笔记。 */
export async function publishImage(page: Page, imagePaths: string[], opts: PublishContent): Promise<void> {
  if (imagePaths.length === 0) throw new Error("图片不能为空");

  const tags = (opts.tags ?? []).slice(0, TAGS_MAX);
  if ((opts.tags ?? []).length > TAGS_MAX) {
    log.warn(`标签数量超过${TAGS_MAX}，截取前${TAGS_MAX}个标签`);
  }

  log.info(
    `发布图文: title=${opts.title} images=${imagePaths.length} tags=${tags.length} schedule=${opts.scheduleAt ?? "-"} original=${opts.isOriginal ?? false} visibility=${opts.visibility ?? "公开可见"}`,
  );

  await openPublishPage(page, "上传图文");
  await uploadImages(page, imagePaths);
  await submitPublish(page, { ...opts, tags, isImage: true });
}

/** 发布视频笔记（本地单个视频文件）。 */
export async function publishVideo(page: Page, videoPath: string, opts: PublishContent): Promise<void> {
  if (!videoPath) throw new Error("视频不能为空");

  const tags = (opts.tags ?? []).slice(0, TAGS_MAX);

  log.info(
    `发布视频: title=${opts.title} video=${videoPath} tags=${tags.length} schedule=${opts.scheduleAt ?? "-"} visibility=${opts.visibility ?? "公开可见"}`,
  );

  await openPublishPage(page, "上传视频");
  await uploadVideo(page, videoPath);
  await submitPublish(page, { ...opts, tags, isOriginal: false, isImage: false });
}
