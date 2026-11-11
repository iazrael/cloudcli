import React from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldAlertIcon } from 'lucide-react';

import type { LLMProvider, PendingPermissionRequest } from '@/shared/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '@/modules/chat/utils/chatPermissions';
import { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
import { getPermissionPanel, registerPermissionPanel } from '@/modules/chat/tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import { McpElicitationPanel } from '@/modules/chat/tools/InteractiveRenderers/McpElicitationPanel';
import { MCP_ELICITATION_TOOL_NAME } from '@/shared/constants';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from '@/modules/chat/composer/Confirmation';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);
registerPermissionPanel(MCP_ELICITATION_TOOL_NAME, McpElicitationPanel);

/** The subagent that asked, when the provider says one did. */
function readSubagentOrigin(request: PendingPermissionRequest): { description: string } | null {
  const subagent = (request.context as { subagent?: { description?: unknown } } | null | undefined)?.subagent;
  const description = typeof subagent?.description === 'string' ? subagent.description.trim() : '';
  return subagent && typeof subagent === 'object' ? { description } : null;
}

type PermissionRequestsBannerProps = {
  pendingPermissionRequests: PendingPermissionRequest[];
  /** The session's engine: only Claude honours persisted allow rules, so the remember button shows for it alone. */
  provider: LLMProvider;
  providerLabel: string;
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
};

/**
 * Rendered by chat's ChatComposer above the input to surface pending tool
 * permission requests and their allow/deny/remember actions.
 */
export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  provider,
  providerLabel,
  handlePermissionDecision,
  handleGrantToolPermission,
}: PermissionRequestsBannerProps) {
  const { t } = useTranslation();
  // Only Claude reads the persisted allow list; every other engine treats
  // "remember" as session-scoped, so showing the persistent button there
  // would write dead entries into Claude's settings while claiming "saved".
  const supportsPersistentRules = provider === 'claude';
  // Filter out plan tool requests — they are handled inline by PlanDisplay
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode'
  );

  if (!filteredRequests.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        const CustomPanel = getPermissionPanel(request.toolName);
        const origin = readSubagentOrigin(request);
        const originLine = origin && (
          <div className="mb-1 text-xs text-muted-foreground" data-testid="permission-origin">
            {t('chat:subagent.askedBy', { description: origin.description || 'Agent', defaultValue: 'From subagent: {{description}}' })}
          </div>
        );
        if (CustomPanel) {
          return (
            <div key={request.requestId}>
              {originLine}
              <CustomPanel
                request={request}
                providerLabel={providerLabel}
                onDecision={handlePermissionDecision}
              />
            </div>
          );
        }

        const rawInput = formatToolInputForDisplay(request.input);
        const permissionEntry = supportsPersistentRules
          ? buildClaudeToolPermissionEntry(request.toolName, rawInput)
          : null;
        const settings = supportsPersistentRules ? getClaudeSettings() : null;
        const alreadyAllowed = permissionEntry && settings ? settings.allowedTools.includes(permissionEntry) : false;
        const rememberLabel = alreadyAllowed ? 'Allow (saved)' : 'Allow & remember';
        const matchingRequestIds = permissionEntry
          ? pendingPermissionRequests
              .filter(
                (item) =>
                  buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry,
              )
              .map((item) => item.requestId)
          : [request.requestId];

        return (
          <Confirmation key={request.requestId} approval="pending">
            {originLine}
            <ConfirmationTitle className="flex items-start gap-3">
              <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <ConfirmationRequest>
                <div>
                  <span className="font-medium text-foreground">Permission required</span>
                  <span className="ml-2 text-muted-foreground">
                    Tool: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
                  </span>
                </div>
                {permissionEntry && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Allow rule: <code className="rounded bg-muted px-1 py-0.5 text-xs">{permissionEntry}</code>
                  </div>
                )}
              </ConfirmationRequest>
            </ConfirmationTitle>

            {rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  View tool input
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  {rawInput}
                </pre>
              </details>
            )}

            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: t('chat:misc.userDeniedTool') })}
              >
                Deny
              </ConfirmationAction>
              {supportsPersistentRules && (
                <ConfirmationAction
                  variant="outline"
                  onClick={() => {
                    if (permissionEntry && !alreadyAllowed) {
                      handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                    }
                    handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                  }}
                  disabled={!permissionEntry}
                >
                  {rememberLabel}
                </ConfirmationAction>
              )}
              <ConfirmationAction
                variant="default"
                onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
              >
                Allow once
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        );
      })}
    </div>
  );
}
