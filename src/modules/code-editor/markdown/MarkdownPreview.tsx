import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

import type { MarkdownImageContext } from '@/shared/types';
import { markdownUrlTransform } from '@/shared/utils';
import MarkdownCodeBlock from '@/modules/code-editor/markdown/MarkdownCodeBlock';
import MarkdownPreviewImage from '@/modules/code-editor/markdown/MarkdownPreviewImage';
import MarkdownPreviewLink from '@/modules/code-editor/markdown/MarkdownPreviewLink';

type MarkdownPreviewProps = {
  content: string;
  /**
   * Where the document's local image references resolve from. Callers with no
   * workspace document to resolve against omit it; those images then show
   * their alternative text.
   */
  imageContext?: MarkdownImageContext | null;
};

// Used when a caller renders markdown without a workspace document: web images
// still load, local paths show their alternative text.
const NO_IMAGE_CONTEXT: MarkdownImageContext = { isExternal: false };

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  // MarkdownCodeBlock renders its own highlighted <pre>; passthrough prevents a
  // second Typography-styled <pre> shell from framing it.
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
  ),
};

/** Used by CodeEditorSurface inside code-editor to render markdown source as formatted preview output. */
export default function MarkdownPreview({ content, imageContext = null }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, [remarkMath, { singleDollarTextMath: false }]] as any, []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const components = useMemo<Components>(
    () => ({
      ...markdownPreviewComponents,
      a: ({ node: _node, ...props }) => (
        <MarkdownPreviewLink {...props} context={imageContext ?? NO_IMAGE_CONTEXT} />
      ),
      img: ({ node: _node, ...props }) => (
        <MarkdownPreviewImage {...props} context={imageContext ?? NO_IMAGE_CONTEXT} />
      ),
    }),
    [imageContext],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={markdownUrlTransform}
    >
      {content}
    </ReactMarkdown>
  );
}
