import { describe, expect, it } from 'vitest';

import { buildSearchTree } from '@/modules/file-tree/utils/fileTreeUtils';
import type { FileTreeSearchMatch } from '@/shared/types';

const match = (root: string, separator: string, relativePath: string, type: 'file' | 'directory'): FileTreeSearchMatch => ({
  name: relativePath.split('/').pop() ?? relativePath,
  type,
  path: `${root}${separator}${relativePath.split('/').join(separator)}`,
  relativePath,
  size: 7,
});

describe('buildSearchTree', () => {
  it('nests matches under synthesized ancestors, folders first, and opens every folder', () => {
    const { items, directoryPaths } = buildSearchTree([
      match('/proj', '/', 'src/app/Button.tsx', 'file'),
      match('/proj', '/', 'README.md', 'file'),
      match('/proj', '/', 'src/button.css', 'file'),
    ]);

    expect(items.map((item) => item.name)).toEqual(['src', 'README.md']);
    const source = items[0]!;
    expect(source).toMatchObject({ type: 'directory', path: '/proj/src' });
    expect(source.children?.map((item) => item.name)).toEqual(['app', 'button.css']);
    expect(source.children?.[0]?.children?.[0]).toMatchObject({ name: 'Button.tsx', size: 7 });
    expect(directoryPaths).toEqual(new Set(['/proj/src', '/proj/src/app']));
  });

  it('gives a matched folder its own metadata and no claim to be empty', () => {
    const { items } = buildSearchTree([
      match('/proj', '/', 'src/app/Button.tsx', 'file'),
      match('/proj', '/', 'src', 'directory'),
      match('/proj', '/', 'docs', 'directory'),
    ]);

    expect(items.map((item) => [item.name, item.size])).toEqual([['docs', 7], ['src', 7]]);
    expect(items[0]?.children).toBeUndefined();
    expect(items[1]?.children).toHaveLength(1);
  });

  it('builds ancestor paths with the server separator', () => {
    const { directoryPaths } = buildSearchTree([match('C:\\proj', '\\', 'src/app/Button.tsx', 'file')]);

    expect(directoryPaths).toEqual(new Set(['C:\\proj\\src', 'C:\\proj\\src\\app']));
  });
});
