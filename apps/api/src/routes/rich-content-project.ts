import { IMAGE_KEY_PATTERN, type RichContent } from '@ncse/shared'

/**
 * 富片段图片路径投影（T1-08b 起为练习会话域私有，T2-01b 抽出共享——练习与整卷模考两域复用，
 * 勿在各路由内留拷贝）：图片段 path 仅 KEYED 形态（shared IMAGE_KEY_PATTERN，与 img 端点键校验
 * 共用，勿单方改）拼为 /api/img 绝对 URL，其余（源相对路径等历史数据）原样保留，防误构造。
 * 纯函数（照 stem-preview.ts 先例独立成跨路由共享文件），返回新数组不改库读出对象。
 */

/** 图片段 path 投影：KEYED 形态拼 /api/img 绝对 URL，其余形态原样返回 */
export function projectImagePath(path: string, requestUrl: string): string {
  return IMAGE_KEY_PATTERN.test(path) ? new URL(`/api/img/${path}`, requestUrl).href : path
}

/** RichContent 投影：text 段原样，image 段按 KEYED 形态投影 path */
export function projectRichContent(content: RichContent, requestUrl: string): RichContent {
  return content.map((segment) =>
    segment.type === 'image' ? { ...segment, path: projectImagePath(segment.path, requestUrl) } : segment,
  )
}
