import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ToolRenderer } from '@/modules/chat/tools/ToolRenderer';

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
