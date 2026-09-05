import { memo } from 'react';

import { useQueuedMessageAutoSend } from '@/modules/chat';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';
import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import { useProjectActiveSessionState } from '@/modules/project-workspace/context/ProjectsStateContext';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';
import { useWebSocket } from '@/shared/context/WebSocketContext';

/**
 * Mounted by ProjectWorkspaceShell to restore the app-level half of message
 * queuing (lost in the #1206 restructure): the composer flush only covers the
 * viewed session, this covers every other session in the workspace.
 */
function QueuedMessageAutoSendBridge() {
  const { activeSessionId } = useProjectActiveSessionState();
  const { isConnected, sendMessage } = useWebSocket();
  useQueuedMessageAutoSend({ activeSessionId, isConnected, sendMessage });
  return null;
}

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  return (
    <div
      className="fixed inset-0 flex bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <ProjectEffects navigate={navigate} />
      <QueuedMessageAutoSendBridge />
      <ProjectSidebarRegion isMobile={isMobile} />

      <div className="flex min-w-0 flex-1 flex-col">
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      <ProjectCommandPalette />
      <QuickSettingsPanel />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
