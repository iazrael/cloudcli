import { createContext, useContext } from 'react';

/**
 * 聊天 Markdown 文件引用的解析环境。ChatMessagesPane 统一提供项目身份和
 * 会话记录的运行工作树，普通消息、工具结果和流式回复通过它们调用鉴权文件
 * 接口；相对路径在会话工作树里命中时优先按它解析。
 * 不在聊天项目内的独立渲染入口默认没有项目身份。
 */
export const MarkdownWorkspaceContext = createContext<{ projectId: string | null; worktreePath?: string | null }>({
  projectId: null,
  worktreePath: null,
});

/** DB `projectId` of the project the transcript belongs to, or null outside a project. */
export function useMarkdownWorkspaceProjectId(): string | null {
  return useContext(MarkdownWorkspaceContext).projectId;
}
