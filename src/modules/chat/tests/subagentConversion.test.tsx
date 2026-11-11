import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { SubagentPanel } from '@/modules/chat/tools/SubagentPanel';
import { readBackgroundTaskStatus } from '@/modules/chat/utils/backgroundTasks';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import type { NormalizedMessage } from '@/shared/types';

const base = { sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z', provider: 'claude' as const };
let counter = 0;
const row = (fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage => {
  counter += 1;
  return { id: `r${counter}`, ...base, ...fields } as NormalizedMessage;
};

const agentCall = (extra: Partial<NormalizedMessage> = {}) => row({
  kind: 'tool_use', toolName: 'Agent', toolId: 'call_agent', toolInput: { subagent_type: 'Explore', description: 'Survey' }, ...extra,
});
const childTool = () => row({
  kind: 'tool_use', toolName: 'Read', toolId: 'call_child', toolInput: { file_path: '/tmp/a.ts' }, parentToolUseId: 'call_agent',
});
const childResult = () => row({ kind: 'tool_result', toolId: 'call_child', content: 'file body', parentToolUseId: 'call_agent' });
const childText = () => row({ kind: 'text', role: 'assistant', content: 'Reading the file.', parentToolUseId: 'call_agent' });

describe('the subagent card in the converted transcript', () => {
  it('carries the backend status and timeline from a history row', () => {
    const [card] = normalizedToChatMessages([agentCall({
      subagent: { id: 'a1', status: 'completed', type: 'Explore' },
      subagentTools: [{ kind: 'tool', toolId: 't1', toolName: 'Read', toolInput: {}, toolResult: { content: 'x' } }],
    })]);
    expect(card.subagent).toEqual({ id: 'a1', status: 'completed', type: 'Explore' });
    expect(card.subagentActivity?.map((entry) => entry.toolName)).toEqual(['Read']);
  });

  it('folds live child rows into the card instead of the main thread', () => {
    const converted = normalizedToChatMessages([agentCall(), childText(), childTool(), childResult()]);
    expect(converted).toHaveLength(1);
    expect(converted[0].subagentActivity?.map((entry) => [entry.kind, entry.toolName ?? entry.content])).toEqual([
      ['text', 'Reading the file.'],
      ['tool', 'Read'],
    ]);
    expect(converted[0].subagentActivity?.[1].toolResult).toEqual({ content: 'file body', isError: false });
  });

  it('prefers the history timeline when the row carries one', () => {
    const [card] = normalizedToChatMessages([
      agentCall({ subagentTools: [{ kind: 'text', content: 'from history' }] }),
      childText(),
    ]);
    expect(card.subagentActivity?.map((entry) => entry.content)).toEqual(['from history']);
  });

  it('leaves rows alone when their parent call is not an Agent card', () => {
    const converted = normalizedToChatMessages([
      row({ kind: 'tool_use', toolName: 'Bash', toolId: 'call_agent', toolInput: {} }),
      childText(),
    ]);
    expect(converted.filter((message) => message.content === 'Reading the file.')).toHaveLength(1);
  });

  it('refreshes the card when a child row arrives after the first conversion', () => {
    const call = agentCall();
    const first = normalizedToChatMessages([call, childText()]);
    expect(first[0].subagentActivity).toHaveLength(1);

    const tool = childTool();
    const second = normalizedToChatMessages([call, childText(), tool]);
    expect(second[0].subagentActivity).toHaveLength(2);
    expect(second[0]).not.toBe(first[0]);
  });
});

it('refreshes the card when a folded child call\'s result arrives later', () => {
  const call = agentCall();
  const tool = childTool();
  const first = normalizedToChatMessages([call, tool]);
  expect(first[0].subagentActivity?.[0].toolResult).toBeNull();

  const second = normalizedToChatMessages([call, tool, childResult()]);
  expect(second[0].subagentActivity?.[0].toolResult).toEqual({ content: 'file body', isError: false });
});

describe('nested agents and orphaned rows', () => {
  const nestedAgent = () => row({
    kind: 'tool_use', toolName: 'Agent', toolId: 'call_inner', toolInput: { subagent_type: 'Plan', description: 'Inner' }, parentToolUseId: 'call_agent',
  });
  const deepText = () => row({ kind: 'text', role: 'assistant', content: 'From the inner agent.', parentToolUseId: 'call_inner' });

  it('folds an inner agent and everything under it into the outer card', () => {
    const converted = normalizedToChatMessages([agentCall(), childText(), nestedAgent(), deepText()]);
    expect(converted).toHaveLength(1);
    expect(converted[0].subagentActivity?.map((entry) => [entry.kind, entry.toolName ?? entry.content])).toEqual([
      ['text', 'Reading the file.'],
      ['tool', 'Agent'],
      ['text', 'From the inner agent.'],
    ]);
  });

  it('holds a live row out of the main thread while its session runs and its parent card has not arrived', () => {
    const liveRow = { ...childText(), seq: 7 };
    expect(normalizedToChatMessages([liveRow], { holdOrphanedLiveRows: true })).toHaveLength(0);
    const later = normalizedToChatMessages([agentCall(), liveRow], { holdOrphanedLiveRows: true });
    expect(later).toHaveLength(1);
    expect(later[0].subagentActivity).toHaveLength(1);
  });

  it('shows an orphaned row once its session has settled, and always shows a history row', () => {
    const liveRow = { ...childText(), seq: 7 };
    expect(normalizedToChatMessages([liveRow], { holdOrphanedLiveRows: false })).toHaveLength(1);
    // A history row has no live sequence: its card is on an unloaded page or was never written.
    expect(normalizedToChatMessages([childText()], { holdOrphanedLiveRows: true })).toHaveLength(1);
  });

  it('folds into the outermost agent even when a non-agent call sits above it', () => {
    const worker = row({ kind: 'tool_use', toolName: 'Bash', toolId: 'call_worker', toolInput: {} });
    const outer = agentCall({ parentToolUseId: 'call_worker' });
    const converted = normalizedToChatMessages([worker, outer, childText()]);
    expect(converted.map((message) => message.toolName ?? message.content)).toEqual(['Bash', 'Agent']);
    expect(converted[1].subagentActivity?.map((entry) => entry.content)).toEqual(['Reading the file.']);
  });

  it('breaks a parent cycle and still draws the card and its rows', () => {
    const selfParent = agentCall({ parentToolUseId: 'call_agent' });
    const converted = normalizedToChatMessages([selfParent, childText()]);
    expect(converted).toHaveLength(1);
    expect(converted[0].toolName).toBe('Agent');
    expect(converted[0].subagentActivity).toHaveLength(1);

    const a = row({ kind: 'tool_use', toolName: 'Agent', toolId: 'call_a', toolInput: {}, parentToolUseId: 'call_b' });
    const b = row({ kind: 'tool_use', toolName: 'Agent', toolId: 'call_b', toolInput: {}, parentToolUseId: 'call_a' });
    expect(normalizedToChatMessages([a, b]).map((message) => message.toolId)).toEqual(['call_a', 'call_b']);
  });

  it('still shows a row whose parent is a known call that is not an agent card', () => {
    const converted = normalizedToChatMessages([
      row({ kind: 'tool_use', toolName: 'Bash', toolId: 'call_agent', toolInput: {} }),
      childText(),
    ]);
    expect(converted.filter((message) => message.content === 'Reading the file.')).toHaveLength(1);
  });
});

describe('the subagent panel with a timeline', () => {
  it('shows the agent\'s steps once opened', () => {
    const [card] = normalizedToChatMessages([agentCall(), childText(), childTool(), childResult()]);
    render(React.createElement(SubagentPanel, {
      toolInput: card.toolInput,
      toolResult: card.toolResult,
      subagent: card.subagent,
      taskStatus: card.taskStatus,
      activity: card.subagentActivity,
      createDiff: createCachedDiffCalculator(),
    }));
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Reading the file.')).toBeTruthy();
    expect(document.body.textContent).toContain('Read');
  });
});

describe('an agent resumed after it had stopped', () => {
  // ZCode's SendMessage wakes a finished agent in the background. The server
  // reports the run on the original Agent call, and the history the page
  // loaded before the resume already calls that agent completed.
  const settledCard = () => agentCall({
    subagent: { id: 'a1', status: 'completed', type: 'Explore' },
    subagentTools: [{ kind: 'text', content: 'from history' }],
  });
  const resumedStart = () => row({
    kind: 'task_status', event: 'started', taskId: 'a1', toolUseId: 'call_agent', taskType: 'local_agent', resumed: true,
  });

  it('runs again, outranking the settled history, with the new run appended to its timeline', () => {
    const [card] = normalizedToChatMessages([settledCard(), resumedStart(), childText()]);
    expect(card.taskStatus).toMatchObject({ status: 'running', resumed: true });
    expect(readBackgroundTaskStatus(card)).toBe('running');
    expect(card.subagentActivity?.map((entry) => entry.content)).toEqual(['from history', 'Reading the file.']);
  });

  it('settles on what the resumed run reported', () => {
    const stopped = row({ kind: 'task_status', event: 'notification', taskId: 'a1', toolUseId: 'call_agent', status: 'failed' });
    const [card] = normalizedToChatMessages([settledCard(), resumedStart(), stopped]);
    expect(card.taskStatus).toMatchObject({ status: 'failed', resumed: true });
    expect(readBackgroundTaskStatus(card)).toBe('failed');
  });

  it('keeps the history verdict over a live start that is not a resume', () => {
    const start = row({ kind: 'task_status', event: 'started', taskId: 'a1', toolUseId: 'call_agent', taskType: 'local_agent' });
    const [card] = normalizedToChatMessages([settledCard(), start, childText()]);
    expect(readBackgroundTaskStatus(card)).toBe('completed');
    expect(card.subagentActivity?.map((entry) => entry.content)).toEqual(['from history']);
  });
});
