import type { Project } from '@/shared/types';

export type ProjectSelectionMetadata = Pick<
  Project,
  'projectId' | 'displayName' | 'fullPath' | 'path' | 'isStarred'
>;

/**
 * Keep the project object consumed by the main workspace independent from the
 * sidebar's paginated session list. Session-only updates stay in `projects`;
 * this selected value changes only when workspace metadata changes.
 */
export function mergeProjectSelectionMetadata(
  current: Project,
  incoming: ProjectSelectionMetadata,
): Project {
  if (current.projectId !== incoming.projectId) {
    return current;
  }

  const nextPath = incoming.path ?? current.path;
  const nextIsStarred = incoming.isStarred ?? current.isStarred;

  if (
    current.displayName === incoming.displayName
    && current.fullPath === incoming.fullPath
    && current.path === nextPath
    && current.isStarred === nextIsStarred
  ) {
    return current;
  }

  return {
    ...current,
    displayName: incoming.displayName,
    fullPath: incoming.fullPath,
    path: nextPath,
    isStarred: nextIsStarred,
  };
}
