import { looksLikeFilePath } from '@/modules/chat/utils/fileReference';
import { REMARK_SKIP_CONTAINER_RE } from '@/shared/constants';
import type { MarkdownNode } from '@/shared/types';

// 命令片段（如 `cat out/a.png`）含空格但不以路径锚点开头，不能当文件引用。
const PATH_ANCHORED_WITH_SPACE_RE = /^(?:[/\\]|\.{1,2}[/\\]|[a-z]:[/\\]|file:\/\/)/i;

/**
 * 聊天 Markdown 使用此插件把单独的行内代码文件路径转换为链接；能否点开由
 * 存在性探测决定，探测不出的引用保持默认代码样式。只处理行内代码，不猜测
 * 纯文本里没有边界的路径；既有链接、代码块、公式和图片引用（已由
 * remarkImageReferences 转换）内部跳过，不改消息原文。
 */
export function remarkFileReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || REMARK_SKIP_CONTAINER_RE.test(node.type)) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== 'inlineCode' || !child.value) {
          visit(child);
          return [child];
        }
        const reference = child.value.trim();
        if (!looksLikeFilePath(reference)) return [child];
        if (/\s/.test(reference) && !PATH_ANCHORED_WITH_SPACE_RE.test(reference)) return [child];
        return [{ type: 'link', url: child.value, children: [child] }];
      });
    };
    visit(tree);
  };
}
