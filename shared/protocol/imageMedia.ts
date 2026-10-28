/** 持久图片引用；签名 URL 只临时使用，不写入消息。 */
export type ImageMediaSource =
  | { kind: 'asset'; filename: string; projectId?: string; fallbackPath?: string }
  | { kind: 'project'; projectId: string; path: string }
  | { kind: 'external'; path: string; projectId?: string; projectFallback?: boolean };

/** 批量签名申请中的独立关联项。 */
export type ImageMediaRequest = ImageMediaSource & { id: string };

/** 签名结果；有效期使用绝对 Unix 毫秒时间。 */
export type ImageMediaResult =
  | { id: string; url: string; expiresAt: number }
  | { id: string; status: number; error: string };
