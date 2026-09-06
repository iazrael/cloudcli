import type { Project, ProjectSession } from '@/shared/types';

/**
 * Stable JSON comparison helper for list-merge diffing.
 * Used by the project-workspace merge utilities and useProjectsState.
 */
export const serialize = (value: unknown) => JSON.stringify(value ?? null);

/** Used by useProjectsState and the merge utilities below. */
export const getProjectSessions = (project: Project): ProjectSession[] => {
  return project.sessions ?? [];
};

/** Used by useProjectsState and the merge utilities below. */
export const countLoadedProjectSessions = (project: Project): number => getProjectSessions(project).length;

/** Union of two session lists keyed by session id; used by the merge utilities and useProjectsState's page merge. */
export const mergeSessionProviderLists = (baseSessions: ProjectSession[], additionalSessions: ProjectSession[]): ProjectSession[] => {
  const merged = [...baseSessions];
  const seenSessionIds = new Set(baseSessions.map((session) => String(session.id)));

  for (const session of additionalSessions) {
    const sessionId = String(session.id);
    if (seenSessionIds.has(sessionId)) {
      continue;
    }

    merged.push(session);
    seenSessionIds.add(sessionId);
  }

  return merged;
};

/**
 * Folds a fresh project-list payload into the previous one.
 *
 * The refresh payload carries only the first page of each project's sessions,
 * so rows the client has already loaded from deeper pages must be merged back
 * instead of being clobbered. The one exception: when the fresh payload's own
 * `sessionMeta.total` fits inside what it carried, it covers the project
 * completely — any extra row still held locally no longer exists server-side
 * (archived or deleted) and must be dropped, otherwise no refresh could ever
 * shrink the list back.
 */
export const mergeExpandedSessionPages = (previousProjects: Project[], incomingProjects: Project[]): Project[] => {
  if (previousProjects.length === 0) {
    return incomingProjects;
  }

  const previousByProjectId = new Map(previousProjects.map((project) => [project.projectId, project]));

  return incomingProjects.map((incomingProject) => {
    const previousProject = previousByProjectId.get(incomingProject.projectId);
    if (!previousProject) {
      return incomingProject;
    }

    const previousLoadedCount = countLoadedProjectSessions(previousProject);
    const incomingLoadedCount = countLoadedProjectSessions(incomingProject);
    if (previousLoadedCount <= incomingLoadedCount) {
      return incomingProject;
    }

    const incomingTotal = Number(incomingProject.sessionMeta?.total ?? Number.NaN);
    if (Number.isFinite(incomingTotal) && incomingLoadedCount >= incomingTotal) {
      return incomingProject;
    }

    const mergedProject: Project = {
      ...incomingProject,
      sessions: mergeSessionProviderLists(incomingProject.sessions ?? [], previousProject.sessions ?? []),
    };

    const totalSessions = Number(incomingProject.sessionMeta?.total ?? previousLoadedCount);
    mergedProject.sessionMeta = {
      ...incomingProject.sessionMeta,
      total: totalSessions,
      hasMore: countLoadedProjectSessions(mergedProject) < totalSessions,
    };

    return mergedProject;
  });
};

/**
 * Deep-ish change detection between the previous and refreshed project lists,
 * used to keep React state identity stable when a refresh is a no-op.
 */
export const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    return (
      nextProject.projectId !== prevProject.projectId ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      Boolean(nextProject.isStarred) !== Boolean(prevProject.isStarred) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster)
    );
  });
};

/**
 * Removes one session from a project's loaded list and shrinks `total`
 * accordingly. Returns the same object when the session is not in the list,
 * so callers can keep React state identity stable.
 */
export const removeSessionFromProject = (project: Project, sessionIdToDelete: string): Project => {
  const sessions = project.sessions ?? [];
  const nextSessions = sessions.filter((session) => session.id !== sessionIdToDelete);
  if (nextSessions.length === sessions.length) {
    return project;
  }

  const updatedProject: Project = {
    ...project,
    sessions: nextSessions,
  };

  const totalSessions = Math.max(0, Number(project.sessionMeta?.total ?? 0) - 1);
  updatedProject.sessionMeta = {
    ...project.sessionMeta,
    total: totalSessions,
    hasMore: countLoadedProjectSessions(updatedProject) < totalSessions,
  };

  return updatedProject;
};
