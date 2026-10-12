import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  LOGIN_TIMEOUT_MS,
  calcTitleLength,
  checkLoginStatus,
  deleteCookies,
  favoriteFeed,
  getFeedDetailById,
  getFeedsList,
  getLoginQrcode,
  getMyProfile,
  getUnreadCount,
  getUserProfile,
  likeFeed,
  likeNotificationById,
  listNotificationsByTab,
  postCommentToFeed,
  publishContent,
  publishVideoContent,
  replyCommentInFeed,
  replyNotificationById,
  searchFeedsList,
  unfavoriteFeed,
  unlikeFeed,
} from "../service.js";
import { CONTENT_MAX_LENGTH, TAGS_MAX, TITLE_MAX_LENGTH } from "../config.js";
import { DEFAULT_COMMENT_CONFIG } from "../xhs/types.js";
import { log } from "../log.js";
import { isRiskBlocked } from "../xhs/risk.js";

/** MCP 工具返回的内容块。 */
type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * 工具结果。
 *
 * 带上索引签名是因为 SDK 的 CallToolResult 是 passthrough schema，
 * 允许工具附带任意额外字段；没有它类型对不上。
 */
interface ToolResult {
  [key: string]: unknown;
  content: ContentBlock[];
  isError?: boolean;
}

function text(value: unknown): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: body }] };
}

/**
 * 把业务异常转成 isError 结果。
 *
 * 风控拦截单独措辞：它既不是代码故障也不是参数错误，
 * 说清楚"被站点拦了、要换网络环境"，比抛一句超时有用得多。
 */
function failed(action: string, err: unknown): ToolResult {
  const reason = err instanceof Error ? err.message : String(err);
  log.error(`${action}失败: ${reason}`);

  if (isRiskBlocked(err)) {
    const code = err.code && err.code !== "page-text" ? `（错误码 ${err.code}）` : "";
    return {
      content: [
        {
          type: "text",
          text: [
            `${action}失败：被小红书安全策略拦截${code}`,
            err.detail ? `站点提示：${err.detail}` : "",
            ``,
            `这不是本工具的问题，通常换一个可靠网络环境（或稍后再试）即可恢复。`,
            `有头模式下也可以试试在已打开的窗口里手动完成验证。`,
          ]
            .filter((s) => s !== "")
            .join("\n"),
        },
      ],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: `${action}失败: ${reason}` }], isError: true };
}

/** 统一包一层：业务异常转成 isError 结果，而不是让整个调用崩掉。 */
async function guard(action: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    return failed(action, err);
  }
}

/** 可见范围取值。 */
const VISIBILITY = z
  .enum(["公开可见", "仅自己可见", "仅互关好友可见"])
  .optional()
  .describe("可见范围，默认公开可见");

/** 把时间格式化成给人看的本地时间戳。 */
function stampOf(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 把二维码的 data URL 拆成 MCP image 内容需要的裸 base64。 */
function stripDataUrl(img: string): string {
  const idx = img.indexOf(",");
  return idx >= 0 ? img.slice(idx + 1) : img;
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "xiaohongshu-mcp", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );

  // ------------------------------------------------------------ 登录

  server.registerTool(
    "check_login_status",
    { description: "检查小红书登录状态", inputSchema: {} },
    async () =>
      guard("检查登录状态", async () => {
        const status = await checkLoginStatus();
        if (!status.is_logged_in) {
          return "❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。";
        }
        return `✅ 已登录\n用户名: ${status.username ?? "-"}\n用户 ID: ${status.user_id ?? "-"}\n\n你可以使用其他功能了。`;
      }),
  );

  server.registerTool(
    "get_login_qrcode",
    {
      description:
        "登录小红书。默认会弹出一个真实浏览器窗口停在登录页，用小红书 App 扫码即可——本工具会**一直等到扫码完成或超时**才返回，返回时登录态已保存，可以直接继续调用其他工具。仅在无法开窗的无头环境下才传 headless=true（此时先返回二维码图片，再等待扫码）。",
      inputSchema: {
        headless: z
          .boolean()
          .optional()
          .describe("默认 false：打开浏览器窗口让人扫码。传 true 则不弹窗、改为返回二维码图片 base64"),
        timeout_seconds: z
          .number()
          .int()
          .min(30)
          .max(900)
          .optional()
          .describe("等待扫码的秒数，默认 120（2 分钟）。超时后会关闭窗口并提示重试"),
      },
    },
    async (args) => {
      try {
        const timeoutMs = (args.timeout_seconds ?? LOGIN_TIMEOUT_MS / 1000) * 1000;
        // 这个调用会一直等：扫完码才返回，调用方可以据此直接往下走
        const res = await getLoginQrcode({ headless: args.headless ?? false, timeoutMs });

        if (res.is_logged_in) {
          const lines = ["✅ 已登录", ""];
          if (res.opened_in_browser) {
            lines.push("浏览器窗口已自动关闭，登录态已保存，可以继续使用其他工具了。");
          } else {
            lines.push("登录态已保存，可以继续使用其他工具了。");
          }
          lines.push(
            "",
            "提示：本工具只负责登录，不会覆盖已有账号。如需**切换账号**，",
            "请先调用 delete_cookies 重置登录状态，再调用本工具扫描新账号的二维码。",
          );
          return text(lines.join("\n"));
        }

        // 到这里说明等待结束但没等到登录：把二维码（无头模式）和原因一起给出
        const lines = [
          `❌ 未完成登录（已等待 ${Math.round(timeoutMs / 1000)} 秒，浏览器窗口已关闭）`,
          ``,
        ];

        if (res.warning) lines.push(res.warning, "");

        lines.push("可以再次调用本工具重试。");

        if (res.img) {
          return {
            content: [
              { type: "text", text: lines.join("\n") + "\n\n也可以用小红书 App 扫描下面的二维码：" },
              { type: "image", data: stripDataUrl(res.img), mimeType: "image/png" },
            ],
            isError: true,
          };
        }

        return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
      } catch (err) {
        return failed("获取登录二维码", err);
      }
    },
  );

  server.registerTool(
    "delete_cookies",
    {
      description:
        "重置登录状态，用于重新登录或切换账号。会同时清理 cookies 文件**和浏览器数据目录**（登录态主要存在后者），因此清理后不会残留之前账号的信息。设备指纹会保留。",
      inputSchema: {},
    },
    async () => guard("重置登录状态", async () => (await deleteCookies()).message),
  );

  // ------------------------------------------------------------ 发布

  server.registerTool(
    "publish_content",
    {
      description: `发布小红书图文内容。标题最多 ${TITLE_MAX_LENGTH} 个字，正文最多 ${CONTENT_MAX_LENGTH} 字，标签最多 ${TAGS_MAX} 个。`,
      inputSchema: {
        title: z.string().describe("笔记标题"),
        content: z.string().describe("笔记正文"),
        images: z.array(z.string()).min(1).describe("图片列表，本地路径或 http(s) 图片地址"),
        tags: z.array(z.string()).optional().describe("话题标签，不需要带 #"),
        schedule_at: z
          .string()
          .optional()
          .describe("定时发布时间，ISO8601 格式。需在 1 小时后、14 天内；留空立即发布"),
        is_original: z.boolean().optional().describe("是否声明原创"),
        visibility: VISIBILITY,
        products: z.array(z.string()).optional().describe("商品关键词，用于绑定带货商品"),
      },
    },
    async (args) =>
      guard("发布内容", async () => {
        const res = await publishContent({
          title: args.title,
          content: args.content,
          images: args.images,
          tags: args.tags,
          schedule_at: args.schedule_at,
          is_original: args.is_original,
          visibility: args.visibility,
          products: args.products,
        });
        return `内容发布成功\n标题: ${res.title}\n图片: ${res.images} 张\n状态: ${res.status}`;
      }),
  );

  server.registerTool(
    "publish_with_video",
    {
      description: `发布小红书视频内容（仅支持本地单个视频文件）。标题最多 ${TITLE_MAX_LENGTH} 个字。`,
      inputSchema: {
        title: z.string().describe("笔记标题"),
        content: z.string().describe("笔记正文"),
        video: z.string().describe("本地视频文件路径"),
        tags: z.array(z.string()).optional().describe("话题标签，不需要带 #"),
        schedule_at: z
          .string()
          .optional()
          .describe("定时发布时间，ISO8601 格式。需在 1 小时后、14 天内；留空立即发布"),
        visibility: VISIBILITY,
        products: z.array(z.string()).optional().describe("商品关键词，用于绑定带货商品"),
      },
    },
    async (args) =>
      guard("发布视频", async () => {
        const res = await publishVideoContent({
          title: args.title,
          content: args.content,
          video: args.video,
          tags: args.tags,
          schedule_at: args.schedule_at,
          visibility: args.visibility,
          products: args.products,
        });
        return `视频发布成功\n标题: ${res.title}\n视频: ${res.video}\n状态: ${res.status}`;
      }),
  );

  // ------------------------------------------------------------ 读取

  server.registerTool(
    "list_feeds",
    { description: "获取首页 Feeds 列表", inputSchema: {} },
    async () => guard("获取Feeds列表", () => getFeedsList()),
  );

  server.registerTool(
    "search_feeds",
    {
      description: "搜索小红书内容（需要已登录）",
      inputSchema: {
        keyword: z.string().describe("搜索关键词"),
        filters: z
          .object({
            sort_by: z
              .enum(["综合", "最新", "最多点赞", "最多评论", "最多收藏"])
              .optional()
              .describe("排序依据"),
            note_type: z.enum(["不限", "视频", "图文"]).optional().describe("笔记类型"),
            publish_time: z.enum(["不限", "一天内", "一周内", "半年内"]).optional().describe("发布时间"),
            search_scope: z.enum(["不限", "已看过", "未看过", "已关注"]).optional().describe("搜索范围"),
            location: z.enum(["不限", "同城", "附近"]).optional().describe("位置距离"),
          })
          .optional()
          .describe("筛选条件，取值写错会在打开浏览器之前直接报错"),
      },
    },
    async (args) =>
      guard("搜索Feeds", () => searchFeedsList(args.keyword, args.filters ? [args.filters] : [])),
  );

  server.registerTool(
    "get_feed_detail",
    {
      description:
        "获取小红书笔记详情，返回笔记内容、图片、作者信息、互动数据（点赞/收藏/分享数）及评论列表。视频笔记额外返回 video 字段，含各编码档位的视频直链与字幕地址（均带签名、有时效）。默认返回前10条一级评论，如需更多评论请设置 load_all_comments=true",
      inputSchema: {
        feed_id: z.string().describe("笔记 ID"),
        xsec_token: z.string().describe("笔记访问令牌"),
        load_all_comments: z.boolean().optional().describe("是否滚动加载全部评论，关闭则只取首屏评论"),
        click_more_replies: z.boolean().optional().describe("是否点击「更多回复」展开楼中楼"),
        max_replies_threshold: z
          .number()
          .int()
          .optional()
          .describe(`回复数超过该阈值的「更多」按钮将被跳过，默认 ${DEFAULT_COMMENT_CONFIG.maxRepliesThreshold}`),
        max_comment_items: z
          .number()
          .int()
          .optional()
          .describe(`最多加载多少条一级评论，默认 ${DEFAULT_COMMENT_CONFIG.maxCommentItems}`),
        scroll_speed: z.enum(["slow", "normal", "fast"]).optional().describe("滚动速度，默认 normal"),
      },
    },
    async (args) =>
      guard("获取Feed详情", () =>
        getFeedDetailById(args.feed_id, args.xsec_token, args.load_all_comments ?? false, {
          clickMoreReplies: args.click_more_replies ?? DEFAULT_COMMENT_CONFIG.clickMoreReplies,
          maxRepliesThreshold: args.max_replies_threshold ?? DEFAULT_COMMENT_CONFIG.maxRepliesThreshold,
          maxCommentItems: args.max_comment_items ?? DEFAULT_COMMENT_CONFIG.maxCommentItems,
          scrollSpeed: args.scroll_speed ?? DEFAULT_COMMENT_CONFIG.scrollSpeed,
        }),
      ),
  );

  server.registerTool(
    "user_profile",
    {
      description:
        "获取指定的小红书用户主页，返回用户基本信息，关注、粉丝、获赞量，以及指定 tab 下的内容。tab 可选 note(笔记,默认)、fav(收藏)、liked(点赞)，后两者可能被对方设为不公开",
      inputSchema: {
        user_id: z.string().describe("用户 ID"),
        xsec_token: z.string().describe("用户访问令牌"),
        tab: z.enum(["note", "fav", "liked"]).optional().describe("主页 tab，默认 note"),
      },
    },
    async (args) => guard("获取用户主页", () => getUserProfile(args.user_id, args.xsec_token, args.tab ?? "note")),
  );

  server.registerTool(
    "get_my_profile",
    {
      description:
        "获取当前登录用户的主页，返回用户基本信息，关注、粉丝、获赞量，以及指定 tab 下的内容。tab 可选 note(自己发的笔记,默认)、fav(自己收藏的)、liked(自己点赞的)",
      inputSchema: {
        tab: z.enum(["note", "fav", "liked"]).optional().describe("主页 tab，默认 note"),
      },
    },
    async (args) => guard("获取我的主页", () => getMyProfile(args.tab ?? "note")),
  );

  // ------------------------------------------------------------ 互动

  server.registerTool(
    "post_comment_to_feed",
    {
      description: "发表评论到小红书笔记",
      inputSchema: {
        feed_id: z.string().describe("笔记 ID"),
        xsec_token: z.string().describe("笔记访问令牌"),
        content: z.string().describe("评论内容"),
      },
    },
    async (args) =>
      guard("发表评论", async () => {
        const res = await postCommentToFeed(args.feed_id, args.xsec_token, args.content);
        return `评论发表成功 - Feed ID: ${res.feed_id}`;
      }),
  );

  server.registerTool(
    "reply_comment_in_feed",
    {
      description: "回复小红书笔记下的指定评论，comment_id 与 user_id 至少提供一个",
      inputSchema: {
        feed_id: z.string().describe("笔记 ID"),
        xsec_token: z.string().describe("笔记访问令牌"),
        comment_id: z.string().optional().describe("目标评论 ID"),
        user_id: z.string().optional().describe("目标评论作者的用户 ID"),
        content: z.string().describe("回复内容"),
      },
    },
    async (args) =>
      guard("回复评论", async () => {
        const res = await replyCommentInFeed(
          args.feed_id,
          args.xsec_token,
          args.comment_id ?? "",
          args.user_id ?? "",
          args.content,
        );
        return `评论回复成功 - Feed ID: ${res.feed_id}, Comment ID: ${res.target_comment_id ?? "-"}, User ID: ${
          res.target_user_id ?? "-"
        }`;
      }),
  );

  server.registerTool(
    "like_feed",
    {
      description: "为指定笔记点赞或取消点赞（如已点赞将跳过点赞，如未点赞将跳过取消点赞）",
      inputSchema: {
        feed_id: z.string().describe("笔记 ID"),
        xsec_token: z.string().describe("笔记访问令牌"),
        unlike: z.boolean().optional().describe("传 true 表示取消点赞"),
      },
    },
    async (args) =>
      guard(args.unlike ? "取消点赞" : "点赞", async () => {
        const res = args.unlike
          ? await unlikeFeed(args.feed_id, args.xsec_token)
          : await likeFeed(args.feed_id, args.xsec_token);
        return res.message;
      }),
  );

  server.registerTool(
    "favorite_feed",
    {
      description: "收藏指定笔记或取消收藏（如已收藏将跳过收藏，如未收藏将跳过取消收藏）",
      inputSchema: {
        feed_id: z.string().describe("笔记 ID"),
        xsec_token: z.string().describe("笔记访问令牌"),
        unfavorite: z.boolean().optional().describe("传 true 表示取消收藏"),
      },
    },
    async (args) =>
      guard(args.unfavorite ? "取消收藏" : "收藏", async () => {
        const res = args.unfavorite
          ? await unfavoriteFeed(args.feed_id, args.xsec_token)
          : await favoriteFeed(args.feed_id, args.xsec_token);
        return res.message;
      }),
  );

  // ------------------------------------------------------------ 通知

  server.registerTool(
    "get_unread_count",
    {
      description:
        "获取通知未读数，返回「评论和@」「赞和收藏」「新增关注」三个分区各自的未读条数。不会清除未读标记。查看具体内容用 list_notifications。",
      inputSchema: {},
    },
    async () => guard("获取未读数", () => getUnreadCount()),
  );

  server.registerTool(
    "list_notifications",
    {
      description:
        "获取通知列表。返回评论内容、评论者、以及对应笔记的 feed_id 和 xsec_token（可用于 get_feed_detail 读原帖）。已删除或不可见的条目会被过滤，过滤数量见 filtered 字段。注意：会清除该分区的未读标记，只需要未读数时用 get_unread_count。",
      inputSchema: {
        tab: z
          .enum(["mentions", "likes", "connections"])
          .optional()
          .describe("分区：mentions(评论和@)、likes(赞和收藏)、connections(新增关注)，默认 mentions"),
        limit: z.number().int().optional().describe("最多返回多少条，默认 20"),
      },
    },
    async (args) => guard("获取通知列表", () => listNotificationsByTab(args.tab ?? "mentions", args.limit ?? 20)),
  );

  server.registerTool(
    "reply_notification",
    {
      description:
        "回复「评论和@」里的一条评论。comment_id 从 list_notifications 获取。适合处理收到的评论，无需先定位笔记。",
      inputSchema: {
        comment_id: z.string().describe("评论 ID"),
        content: z.string().describe("回复内容"),
      },
    },
    async (args) => guard("回复", () => replyNotificationById(args.comment_id, args.content)),
  );

  server.registerTool(
    "like_notification",
    {
      description:
        "给「评论和@」里的一条评论点赞或取消点赞。comment_id 从 list_notifications 获取（其 liked 字段是当前状态）。已是目标状态时跳过。",
      inputSchema: {
        comment_id: z.string().describe("评论 ID"),
        unlike: z.boolean().optional().describe("传 true 表示取消点赞"),
      },
    },
    async (args) => guard("点赞", () => likeNotificationById(args.comment_id, args.unlike ?? false)),
  );

  return server;
}

/** 对外暴露一下标题计算，方便外部自检。 */
export { calcTitleLength };
