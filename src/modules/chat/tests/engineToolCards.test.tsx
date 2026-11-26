import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';
import { shouldHideToolResult } from '@/modules/chat/tools/configs/toolConfigs';

/**
 * agy's `edit_file` and opencode's `shell` used to fall through to the
 * generic card, which dumps the raw input JSON. They must render as the same
 * Edit card and command row Claude's tools get.
 */
describe('engine-native tool cards', () => {
  it('renders agy edit_file as the Edit card titled by the file name', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ToolRenderer
          toolName="edit_file"
          toolInput={{ Path: '/repo/work/run_k6_clean.py', Target: 'a == 1', Replacement: 'a == 2' }}
          toolId="agy-edit"
          mode="input"
        />
      </I18nextProvider>,
    );

    expect(screen.getByText('run_k6_clean.py')).toBeTruthy();
    expect(container.textContent).not.toContain('"Path"');
  });

  it('renders opencode shell as a command row', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ToolRenderer
          toolName="shell"
          toolInput={{ command: 'ls -la', workdir: '/repo' }}
          toolId="opencode-shell"
          mode="input"
        />
      </I18nextProvider>,
    );

    expect(screen.getByText('ls -la')).toBeTruthy();
    expect(container.textContent).not.toContain('"workdir"');
  });
});

describe('engine-native card headers', () => {
  it('labels agy write_file as Write, not its engine name', () => {
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <ToolRenderer
          toolName="write_file"
          toolInput={{ Path: '/repo/build_tape.py', Content: 'print(1)\n' }}
          toolId="agy-write"
          mode="input"
        />
      </I18nextProvider>,
    );

    expect(container.textContent).toContain('Write');
    expect(container.textContent).not.toContain('write_file');
  });
});

describe('Antigravity step checklist', () => {
  const steps = [
    { title: 'Review the diff', status: 'done' },
    { title: 'Run the checks', status: 'in_progress' },
    { title: 'Summarize the changes', status: 'pending' },
  ];
  const receipt = { content: 'Steps updated' };

  it.each([
    { steps },
    JSON.stringify({ steps: JSON.stringify(steps) }),
  ])('renders the current step and progress from %j', (toolInput) => {
    render(
      <ToolRenderer toolName="update_steps" toolInput={toolInput} toolResult={receipt} mode="input" />,
    );

    expect(screen.getByText('Checklist')).toBeTruthy();
    expect(screen.getByText('Run the checks — 1/3')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(steps.map((step) => step.title));
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
    expect(screen.queryByText('Steps updated')).toBeNull();
    expect(shouldHideToolResult('update_steps', receipt, toolInput)).toBe(true);
    expect(shouldHideToolResult('update_steps', { content: 'Rejected', isError: true }, toolInput)).toBe(false);
  });

  it('shows an empty checklist without inventing any steps', () => {
    render(<ToolRenderer toolName="update_steps" toolInput={{ steps: [] }} mode="input" />);

    expect(screen.getByText('Updating checklist')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('keeps the input and result readable if a step cannot be parsed', () => {
    const toolInput = { steps: [...steps, { title: 'Unknown step', status: 'unexpected' }] };
    render(
      <ToolRenderer toolName="update_steps" toolInput={toolInput} toolResult={receipt} mode="input" />,
    );

    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByText(/"status": "unexpected"/)).toBeTruthy();
    expect(screen.getByText('Steps updated')).toBeTruthy();
  });
});
