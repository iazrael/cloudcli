import { REMARK_SKIP_CONTAINER_RE } from '@/shared/constants';
import { isImageReference } from '@/shared/utils';
import type { MarkdownNode } from '@/shared/types';

/** 聊天 Markdown 使用此插件把正文和独立行内代码中的图片地址转换为链接。 */
export function remarkImageReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || REMARK_SKIP_CONTAINER_RE.test(node.type)) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type === 'inlineCode' && child.value && isImageReference(child.value)) {
          return [{ type: 'link', url: child.value, children: [child] }];
        }
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        const pieces: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/[^\s<>"'`，。；：！？（）【】()\[\]{}]+/g)) {
          const reference = match[0].replace(/[,.;:!?]+$/, '');
          if (!isImageReference(reference)) continue;
          const start = match.index;
          if (start > offset) pieces.push({ type: 'text', value: child.value.slice(offset, start) });
          pieces.push({ type: 'link', url: reference, children: [{ type: 'text', value: reference }] });
          offset = start + reference.length;
        }
        if (!pieces.length) return [child];
        if (offset < child.value.length) pieces.push({ type: 'text', value: child.value.slice(offset) });
        return pieces;
      });
    };
    visit(tree);
  };
}
