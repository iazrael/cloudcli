import { describe, expect, it } from 'vitest';

import {
  getParentPath,
  getSuggestionRootPath,
  isCloneWorkflow,
  isSshGitUrl,
  joinFolderPath,
  shouldShowGithubAuthentication,
} from '@/modules/project-creation-wizard/utils/pathUtils';

describe('pathUtils', () => {
  describe('getParentPath', () => {
    it('returns null for top-level roots', () => {
      expect(getParentPath('~')).toBeNull();
      expect(getParentPath('/')).toBeNull();
      expect(getParentPath('drives')).toBeNull();
    });

    it('returns drives for Windows drive roots', () => {
      expect(getParentPath('C:\\')).toBe('drives');
      expect(getParentPath('C:')).toBe('drives');
      expect(getParentPath('D:\\')).toBe('drives');
      expect(getParentPath('E:\\')).toBe('drives');
    });

    it('returns drive root when navigating from first-level Windows directory', () => {
      expect(getParentPath('C:\\Users')).toBe('C:\\');
      expect(getParentPath('E:\\Projects')).toBe('E:\\');
    });

    it('returns parent directory for nested Windows paths', () => {
      expect(getParentPath('C:\\Users\\JamesChen')).toBe('C:\\Users');
      expect(getParentPath('E:\\Projects\\cloudcli')).toBe('E:\\Projects');
    });

    it('returns parent directory for Unix paths', () => {
      expect(getParentPath('/home/user/project')).toBe('/home/user');
      expect(getParentPath('/home')).toBe('/');
    });
  });

  describe('getSuggestionRootPath', () => {
    it('handles drives identifier', () => {
      expect(getSuggestionRootPath('drives')).toBe('drives');
    });

    it('extracts drive root for first-level Windows directory', () => {
      expect(getSuggestionRootPath('E:\\Projects')).toBe('E:\\');
      expect(getSuggestionRootPath('C:\\Users')).toBe('C:\\');
    });

    it('extracts parent path for nested paths', () => {
      expect(getSuggestionRootPath('E:\\Projects\\cloudcli')).toBe('E:\\Projects');
      expect(getSuggestionRootPath('/home/user/project')).toBe('/home/user');
    });

    it('falls back to ~ for rootless inputs', () => {
      expect(getSuggestionRootPath('my-project')).toBe('~');
    });
  });

  describe('joinFolderPath', () => {
    it('joins Windows paths correctly with backslash', () => {
      expect(joinFolderPath('C:\\', 'Projects')).toBe('C:\\Projects');
      expect(joinFolderPath('E:\\Projects', 'cloudcli')).toBe('E:\\Projects\\cloudcli');
    });

    it('joins Unix paths correctly with slash', () => {
      expect(joinFolderPath('/home/user', 'project')).toBe('/home/user/project');
    });
  });

  describe('git url helpers', () => {
    it('detects SSH git URLs', () => {
      expect(isSshGitUrl('git@github.com:user/repo.git')).toBe(true);
      expect(isSshGitUrl('ssh://git@github.com/user/repo.git')).toBe(true);
      expect(isSshGitUrl('https://github.com/user/repo.git')).toBe(false);
    });

    it('determines github auth visibility', () => {
      expect(shouldShowGithubAuthentication('https://github.com/user/repo.git')).toBe(true);
      expect(shouldShowGithubAuthentication('git@github.com:user/repo.git')).toBe(false);
      expect(shouldShowGithubAuthentication('')).toBe(false);
    });

    it('identifies clone workflow', () => {
      expect(isCloneWorkflow('https://github.com/user/repo')).toBe(true);
      expect(isCloneWorkflow('')).toBe(false);
    });
  });
});
