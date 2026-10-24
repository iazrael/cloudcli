/**
 * OpenCode Subagent Session Index
 *
 * Links a spawned child session back to the run that launched it, from the
 * events the service already emits. Two signals establish the link:
 *
 * - `session.created` for the child carries `parentID`, plus the agent and
 *   title the launch asked for, which are matched against the parent's
 *   pending subagent tool calls (the child's title is the launch's
 *   `description`);
 * - the parent's `session.tool.progress`/`.success` carry the child id in
 *   `metadata.sessionID`, which is authoritative about the tool call.
 *
 * Consumers: the run registry (routes child frames to the parent's writer so
 * they can be stamped with `parentToolUseId`) and the interaction bridge
 * (permission/question cards raised inside a subagent belong to the parent's
 * chat session).
 *
 * @module opencode-subagent-index
 */

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import type { OpenCodeEventEnvelope } from './opencode-event-stream.js';

const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'task']);

/** Where an event of a child session belongs: the parent run and its spawn call. */
export type OpenCodeSubagentParent = {
  parentProviderSessionId: string;
  /** The parent's `subagent`/`task` tool call; absent until one of the two signals names it. */
  parentToolCallId?: string;
};

type PendingLaunch = {
  toolCallId: string;
  agent?: string;
  description?: string;
  claimed: boolean;
};

/**
 * Tracks child-session links and the parent launches that explain them.
 *
 * Consumer: opencode run registry and interaction bridge (one instance each;
 * both fed every event before it is dispatched).
 */
export class OpenCodeSubagentIndex {
  private readonly byChild = new Map<string, OpenCodeSubagentParent>();
  private readonly launchesByParent = new Map<string, PendingLaunch[]>();
  /** Tool name and owning session per call id, so a `called` event that does not repeat the name stays recognisable. */
  private readonly toolNames = new Map<string, { name: string; sessionId: string | null }>();

  /** Feeds one service event; only session lifecycle and subagent tool events matter. */
  note(event: OpenCodeEventEnvelope): void {
    const data = readObjectRecord(event.data);
    if (!data) {
      return;
    }

    if (event.type === 'session.tool.input.started') {
      const callId = readOptionalString(data.id);
      const name = readOptionalString(data.name);
      if (callId && name) {
        this.toolNames.set(callId, { name, sessionId: readOptionalString(data.sessionID) ?? null });
      }
      return;
    }

    if (event.type === 'session.tool.called') {
      this.noteLaunch(data);
      return;
    }

    if (event.type === 'session.created') {
      const childSessionId = readOptionalString(data.sessionID);
      const parentProviderSessionId = readOptionalString(data.parentID);
      if (childSessionId && parentProviderSessionId) {
        const launch = this.claimLaunch(parentProviderSessionId, {
          agent: readOptionalString(data.agent),
          description: readOptionalString(data.title),
        });
        this.link(childSessionId, parentProviderSessionId, launch?.toolCallId);
      }
      return;
    }

    if (
      event.type === 'session.tool.progress'
      || event.type === 'session.tool.success'
      || event.type === 'session.tool.failed'
    ) {
      const parentProviderSessionId = readOptionalString(data.sessionID);
      const childSessionId = readOptionalString(readObjectRecord(data.metadata)?.sessionID);
      const toolCallId = readOptionalString(data.id);
      if (parentProviderSessionId && childSessionId) {
        if (toolCallId) {
          this.toolNames.set(toolCallId, {
            name: this.toolNames.get(toolCallId)?.name ?? 'subagent',
            sessionId: parentProviderSessionId,
          });
        }
        this.link(childSessionId, parentProviderSessionId, toolCallId);
      }
    }
  }

  /** The parent a child session belongs to, or null when this session is not a child. */
  resolve(childSessionId: string): OpenCodeSubagentParent | null {
    return this.byChild.get(childSessionId) ?? null;
  }

  /** Drops a parent's launches and child links when its run ends. */
  forgetParent(parentProviderSessionId: string): void {
    this.launchesByParent.delete(parentProviderSessionId);
    const childSessionIds = new Set<string>();
    for (const [childSessionId, parent] of this.byChild) {
      if (parent.parentProviderSessionId === parentProviderSessionId) {
        childSessionIds.add(childSessionId);
        this.byChild.delete(childSessionId);
      }
    }
    for (const [callId, call] of this.toolNames) {
      if (call.sessionId === parentProviderSessionId || (call.sessionId !== null && childSessionIds.has(call.sessionId))) {
        this.toolNames.delete(callId);
      }
    }
  }

  private noteLaunch(data: Record<string, unknown>): void {
    const providerSessionId = readOptionalString(data.sessionID);
    const toolCallId = readOptionalString(data.id);
    if (!providerSessionId || !toolCallId) {
      return;
    }
    const name = this.toolNames.get(toolCallId)?.name ?? readOptionalString(data.name);
    if (!name || !SUBAGENT_TOOL_NAMES.has(name)) {
      return;
    }
    const input = readObjectRecord(data.input);
    const launches = this.launchesByParent.get(providerSessionId) ?? [];
    launches.push({
      toolCallId,
      agent: readOptionalString(input?.agent),
      description: readOptionalString(input?.description),
      claimed: false,
    });
    this.launchesByParent.set(providerSessionId, launches);
  }

  /**
   * Pairs a child with the launch that asked for it. The child's title is the
   * launch's description, so that pair (with the agent) is the exact match;
   * an unnamed or renamed child falls back to the oldest unclaimed launch.
   */
  private claimLaunch(
    parentProviderSessionId: string,
    child: { agent?: string; description?: string },
  ): PendingLaunch | undefined {
    const launches = this.launchesByParent.get(parentProviderSessionId);
    if (!launches || launches.length === 0) {
      return undefined;
    }
    const exact = launches.find((launch) => (
      !launch.claimed
      && child.description !== undefined
      && launch.description === child.description
      && (launch.agent === undefined || child.agent === undefined || launch.agent === child.agent)
    ));
    const launch = exact ?? launches.find((entry) => !entry.claimed);
    if (!launch) {
      return undefined;
    }
    launch.claimed = true;
    return launch;
  }

  private link(childSessionId: string, parentProviderSessionId: string, toolCallId?: string): void {
    const existing = this.byChild.get(childSessionId);
    this.byChild.set(childSessionId, {
      parentProviderSessionId,
      parentToolCallId: toolCallId ?? existing?.parentToolCallId,
    });
  }
}
