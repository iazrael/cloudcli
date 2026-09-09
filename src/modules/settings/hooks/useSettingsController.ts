import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '@/shared/context/ThemeContext';
import { authenticatedFetch } from '@/shared/api';
import { readProviderToolsSettings, setNotificationSoundEnabled } from '@/modules/chat';
import { useProviderAuthStatus } from '@/modules/provider-auth';
import {
  readCodeEditorSettings as readStoredCodeEditorSettings,
  writeCodeEditorSettings,
} from '@/shared/codeEditorSettings';
import { readUserPreference, writeUserPreference } from '@/shared/userSettings';
import {
  DEFAULT_CURSOR_PERMISSIONS,
} from '@/modules/settings/constants/constants';
import type {
  AgentProvider,
  AntigravityPermissionMode,
  ClaudePermissionsState,
  CodeEditorSettingsState,
  CodexPermissionMode,
  CursorPermissionsState,
  NotificationPreferencesState,
  PermissionMode,
  ProjectSortOrder,
  SettingsMainTab,
  ZcodePermissionMode,
} from '@/shared/types';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'appearance', 'git', 'api', 'tasks', 'browser', 'notifications', 'plugins', 'about'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toAntigravityPermissionMode = (value: unknown): AntigravityPermissionMode => {
  if (value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toZcodePermissionMode = (value: unknown): ZcodePermissionMode => {
  if (value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toClaudePermissionMode = (value: unknown): PermissionMode => {
  if (value === 'acceptEdits' || value === 'auto' || value === 'plan' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  permissionMode: 'default',
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readStoredCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [cursorPermissions, setCursorPermissions] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('default');
  const [antigravityPermissionMode, setAntigravityPermissionMode] = useState<AntigravityPermissionMode>('default');
  const [zcodePermissionMode, setZcodePermissionMode] = useState<ZcodePermissionMode>('default');

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const loadSettings = useCallback(async () => {
    try {
      // Permissions live in the preference store (auth.db) — the same copy the
      // in-chat grants write — so the dialog shows and saves what is actually
      // in effect, on any device.
      const storedClaudePermissions = readUserPreference<Partial<ClaudePermissionsState>>('claudePermissions', {});
      setClaudePermissions({
        permissionMode: toClaudePermissionMode(storedClaudePermissions.permissionMode),
        allowedTools: Array.isArray(storedClaudePermissions.allowedTools)
          ? storedClaudePermissions.allowedTools
          : [],
        disallowedTools: Array.isArray(storedClaudePermissions.disallowedTools)
          ? storedClaudePermissions.disallowedTools
          : [],
        skipPermissions: Boolean(storedClaudePermissions.skipPermissions),
      });
      setProjectSortOrder(readUserPreference<ProjectSortOrder>('projectSortOrder', 'name'));

      const storedCursorPermissions = readUserPreference<Partial<CursorPermissionsState>>('cursorPermissions', {});
      setCursorPermissions({
        allowedCommands: Array.isArray(storedCursorPermissions.allowedCommands)
          ? storedCursorPermissions.allowedCommands
          : [],
        disallowedCommands: Array.isArray(storedCursorPermissions.disallowedCommands)
          ? storedCursorPermissions.disallowedCommands
          : [],
        skipPermissions: Boolean(storedCursorPermissions.skipPermissions),
      });

      const storedCodexSettings = readProviderToolsSettings('codex');
      setCodexPermissionMode(toCodexPermissionMode(storedCodexSettings.permissionMode));

      const storedAntigravitySettings = readProviderToolsSettings('antigravity');
      setAntigravityPermissionMode(toAntigravityPermissionMode(storedAntigravitySettings.permissionMode));

      const storedZcodeSettings = readProviderToolsSettings('zcode');
      setZcodePermissionMode(toZcodePermissionMode(storedZcodeSettings.permissionMode));

      try {
        const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences');
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            setNotificationPreferences(normalizeNotificationPreferences(notificationData.preferences));
          } else {
            setNotificationPreferences(createDefaultNotificationPreferences());
          }
        } else {
          setNotificationPreferences(createDefaultNotificationPreferences());
        }
      } catch {
        setNotificationPreferences(createDefaultNotificationPreferences());
      }

    } catch (error) {
      console.error('Error loading settings:', error);
      setClaudePermissions(createEmptyClaudePermissions());
      setCursorPermissions(createEmptyCursorPermissions());
      setNotificationPreferences(createDefaultNotificationPreferences());
      setCodexPermissionMode('default');
      setAntigravityPermissionMode('default');
      setProjectSortOrder('name');
    }
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const closeLoginModal = useCallback(() => {
    setShowLoginModal(false);
    void refreshProviderAuthStatuses();
  }, [refreshProviderAuthStatuses]);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      // Mirror of loadSettings: every write lands in the preference store, so
      // the settings survive a device switch and stay visible to the send path.
      writeUserPreference('claudePermissions', {
        permissionMode: claudePermissions.permissionMode,
        allowedTools: claudePermissions.allowedTools,
        disallowedTools: claudePermissions.disallowedTools,
        skipPermissions: claudePermissions.skipPermissions,
      });
      writeUserPreference('projectSortOrder', projectSortOrder);

      writeUserPreference('cursorPermissions', {
        allowedCommands: cursorPermissions.allowedCommands,
        disallowedCommands: cursorPermissions.disallowedCommands,
        skipPermissions: cursorPermissions.skipPermissions,
      });

      writeUserPreference('codexPermissions', { permissionMode: codexPermissionMode });

      writeUserPreference('antigravityPermissions', { permissionMode: antigravityPermissionMode });

      writeUserPreference('zcodePermissions', { permissionMode: zcodePermissionMode });

      const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(notificationPreferences),
      });
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    antigravityPermissionMode,
    claudePermissions.allowedTools,
    claudePermissions.permissionMode,
    claudePermissions.disallowedTools,
    claudePermissions.skipPermissions,
    codexPermissionMode,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    notificationPreferences,
    projectSortOrder,
    zcodePermissionMode,
  ]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      setCodeEditorSettings((prev: CodeEditorSettingsState) => ({ ...prev, [key]: value }));
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  useEffect(() => {
    // The shared helper lands in the preference store and notifies subscribers
    // synchronously, so the editor (here and on other devices) re-reads
    // without a separate same-tab event. Unchanged values write nothing.
    writeCodeEditorSettings(codeEditorSettings);
  }, [codeEditorSettings]);

  // Auto-save permissions and sort order with debounce
  const autoSaveTimerRef = useRef<number | null>(null);
  const isInitialLoadRef = useRef(true);

  useEffect(() => {
    // Skip auto-save on initial load (settings are being loaded from localStorage)
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [saveSettings]);

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  // Reset initial load flag when settings dialog opens
  useEffect(() => {
    if (isOpen) {
      isInitialLoadRef.current = true;
    }
  }, [isOpen]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    cursorPermissions,
    setCursorPermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    antigravityPermissionMode,
    setAntigravityPermissionMode,
    zcodePermissionMode,
    setZcodePermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    closeLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
