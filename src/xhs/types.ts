/** 小红书数据结构定义，字段与页面 __INITIAL_STATE__ 一致。 */

export interface User {
  userId: string;
  nickname: string;
  nickName?: string;
  avatar?: string;
}

export interface InteractInfo {
  liked: boolean;
  likedCount: string;
  sharedCount?: string;
  commentCount?: string;
  collectedCount?: string;
  collected: boolean;
}

export interface ImageInfo {
  imageScene?: string;
  url?: string;
}

export interface Cover {
  width?: number;
  height?: number;
  url?: string;
  fileId?: string;
  urlPre?: string;
  urlDefault?: string;
  infoList?: ImageInfo[];
}

export interface VideoCapability {
  duration: number;
}

export interface Video {
  capa: VideoCapability;
}

export interface NoteCard {
  type: string;
  displayTitle: string;
  user: User;
  interactInfo: InteractInfo;
  cover: Cover;
  video?: Video;
}

export interface Feed {
  xsecToken: string;
  id: string;
  modelType: string;
  noteCard: NoteCard;
  index?: number;
}

/** 详情页图片。 */
export interface DetailImageInfo {
  width?: number;
  height?: number;
  urlDefault?: string;
  urlPre?: string;
  livePhoto?: boolean;
}

export interface VideoStream {
  masterUrl?: string;
  backupUrls?: string[];
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  qualityType?: string;
}

export interface VideoMedia {
  videoId?: number | string;
  stream?: Record<string, VideoStream[]>;
}

export interface VideoDetail {
  capa?: VideoCapability;
  media?: VideoMedia;
  subtitles?: Record<string, Array<{ url: string; language?: string }>>;
}

export interface FeedDetail {
  noteId: string;
  xsecToken?: string;
  title?: string;
  desc?: string;
  type?: string;
  time?: number;
  ipLocation?: string;
  user?: User;
  interactInfo?: InteractInfo;
  imageList?: DetailImageInfo[];
  video?: VideoDetail;
}

export interface Comment {
  id: string;
  noteId?: string;
  content?: string;
  likeCount?: string;
  createTime?: number;
  ipLocation?: string;
  liked?: boolean;
  userInfo?: User;
  subCommentCount?: string;
  subComments?: Comment[];
  showTags?: string[];
}

export interface CommentList {
  list?: Comment[];
  cursor?: string;
  hasMore?: boolean;
}

export interface FeedDetailResponse {
  note: FeedDetail;
  comments: CommentList;
}

export interface UserBasicInfo {
  gender?: number;
  ipLocation?: string;
  desc?: string;
  imageb?: string;
  nickname?: string;
  images?: string;
  redId?: string;
}

export interface UserInteractions {
  type: string;
  name: string;
  count: string;
}

export interface UserProfileResponse {
  userBasicInfo: UserBasicInfo;
  interactions: UserInteractions[];
  feeds: Feed[];
}

/** 搜索筛选条件，取值与页面筛选项一致。 */
export interface FilterOption {
  sort_by?: string;
  note_type?: string;
  publish_time?: string;
  search_scope?: string;
  location?: string;
}

/** 评论加载配置。 */
export interface CommentLoadConfig {
  clickMoreReplies: boolean;
  maxRepliesThreshold: number;
  maxCommentItems: number;
  scrollSpeed: "slow" | "normal" | "fast";
}

export const DEFAULT_COMMENT_CONFIG: CommentLoadConfig = {
  clickMoreReplies: false,
  maxRepliesThreshold: 10,
  maxCommentItems: 20,
  scrollSpeed: "normal",
};

export interface NotificationCount {
  mentions: number;
  likes: number;
  connections: number;
  unread: number;
}

export interface NotificationUser {
  user_id: string;
  nickname: string;
  xsec_token?: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title?: string;
  time?: number;
  from?: NotificationUser;
  comment_id?: string;
  comment_text?: string;
  liked?: boolean;
  feed_id?: string;
  feed_xsec_token?: string;
  feed_title?: string;
}

export interface NotificationList {
  tab: string;
  filtered: number;
  items: NotificationItem[];
}

/** 笔记条目：列表里混有直播卡片与热词，只有 modelType 为 note 的才是笔记。 */
const MODEL_TYPE_NOTE = "note";

/** 滤掉非笔记条目。 */
export function onlyNotes(feeds: Feed[]): Feed[] {
  return (feeds ?? []).filter((f) => f?.modelType === MODEL_TYPE_NOTE);
}
