import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

import { getZCodeStorageDir } from './zcode-data-root.js';

/**
 * ZCode skills provider implementing ZCode-native skill discovery.
 *
 * ZCode discovers user-level skills from its own storage directory
 * (`<storage>/skills`, `~/.zcode/skills` by default) before falling back to
 * the shared `.agents/skills` ecosystem, so both roots are listed in engine
 * discovery order. Plugin skills under the ZCode plugin cache are a
 * deliberate second-phase enhancement and are not listed yet.
 */
export class ZCodeSkillsProvider extends SkillsProvider {
  constructor() {
    super('zcode');
  }

  /**
   * Returns ZCode skill sources for project and user scopes in engine
   * discovery order: native storage skills shadow shared `.agents` skills
   * of the same name.
   */
  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.agents', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(getZCodeStorageDir(), 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.agents', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  /**
   * Returns the global user skill source for write operations.
   */
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.agents', 'skills'),
      commandPrefix: '/',
    };
  }
}
