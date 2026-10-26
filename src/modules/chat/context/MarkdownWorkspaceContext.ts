import { createContext, useContext } from 'react';

/**
 * 聊天 Markdown 文件引用所属项目。ChatMessagesPane 统一提供项目身份，
 * 普通消息、工具结果和流式回复通过它调用鉴权文件接口。
 * 不在聊天项目内的独立渲染入口默认没有项目身份。
 */
export const MarkdownWorkspaceContext = createContext<{ projectId: string | null }>({ projectId: null });

/** DB `projectId` of the project the transcript belongs to, or null outside a project. */
export function useMarkdownWorkspaceProjectId(): string | null {
  return useContext(MarkdownWorkspaceContext).projectId;
}
