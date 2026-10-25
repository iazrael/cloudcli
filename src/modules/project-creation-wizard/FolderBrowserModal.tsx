import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderOpen, FolderPlus, HardDrive, Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { browseFilesystemFolders, createFolderInFilesystem } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { getParentPath, joinFolderPath } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { FolderSuggestion } from '@/shared/types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  initialPath?: string;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

/** Opened by WorkspacePathField so the user can browse the filesystem and pick or create the workspace folder. */
export default function FolderBrowserModal({
  isOpen,
  initialPath,
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('~');
  // User-editable path input in the path bar so arbitrary paths can be entered or pasted directly.
  const [pathInputValue, setPathInputValue] = useState('~');
  // Discovered filesystem drive roots (e.g. ['C:\\', 'D:\\', 'E:\\']) on Windows for drive-switching buttons.
  const [availableDrives, setAvailableDrives] = useState<string[]>([]);
  const [selectedDrive, setSelectedDrive] = useState<string | null>(null);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeDrive = useMemo(() => {
    if (currentPath === 'drives') {
      return null;
    }
    const match = currentPath.match(/^([a-zA-Z]:)/);
    return match ? match[1].toUpperCase() : selectedDrive;
  }, [currentPath, selectedDrive]);

  // Keep the loader stable across locale changes: t lands in a ref so an
  // open browser does not reload and snap back to the home folder when the
  // user switches language.
  const loadFoldersRef = useRef<(pathToLoad: string) => Promise<void>>();
  const wasOpenRef = useRef(false);

  const loadFolders = useCallback(async (pathToLoad: string) => {
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders(pathToLoad);
      setCurrentPath(result.path);
      setPathInputValue(result.path);
      setFolders(result.suggestions);
      if (result.path === 'drives') {
        setSelectedDrive(null);
      } else {
        const match = result.path.match(/^([a-zA-Z]:)/);
        if (match) {
          setSelectedDrive(match[1].toUpperCase());
        }
      }
      if (result.drives && result.drives.length > 0) {
        setAvailableDrives(result.drives);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('folderBrowser.loadFailed'));
    } finally {
      setLoadingFolders(false);
    }
  }, [t]);

  useEffect(() => {
    loadFoldersRef.current = loadFolders;
  }, [loadFolders]);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      wasOpenRef.current = true;
      const startingPath = initialPath && initialPath.trim().length > 0 ? initialPath.trim() : '~';
      void loadFoldersRef.current?.(startingPath);
    } else if (!isOpen) {
      wasOpenRef.current = false;
      setSelectedFolderPath(null);
    }
  }, [initialPath, isOpen]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    setError(null);
    setSelectedFolderPath(null);
    resetNewFolderState();
    onClose();
  };

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(currentPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      resetNewFolderState();
      await loadFolders(createdPath);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('folderBrowser.createFailed'));
    } finally {
      setCreatingFolder(false);
    }
  }, [currentPath, loadFolders, newFolderName, t]);

  const parentPath = getParentPath(currentPath);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/50">
              <FolderOpen className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('folderBrowser.title')}</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={showHiddenFolders ? t('folderBrowser.hideHidden') : t('folderBrowser.showHidden')}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300'
              }`}
              title={t('folderBrowser.createNew')}
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {availableDrives.length > 0 && (
          <div className="flex items-center gap-1.5 border-b border-gray-200 bg-gray-50/75 px-4 py-2 dark:border-gray-700 dark:bg-gray-800/75 overflow-x-auto overflow-y-hidden">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 mr-1 shrink-0">
              {t('folderBrowser.drives', 'Drives')}:
            </span>
            {availableDrives.map((drive) => {
              const driveLetter = drive.slice(0, 2).toUpperCase();
              const isActive = activeDrive === driveLetter;
              return (
                <button
                  key={drive}
                  type="button"
                  onClick={() => {
                    setSelectedDrive(driveLetter);
                    setSelectedFolderPath(null);
                    void loadFolders(drive);
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors shrink-0 ${
                    isActive
                      ? 'border border-blue-600 bg-blue-600 text-white shadow-sm'
                      : 'border border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600 dark:hover:text-blue-400'
                  }`}
                >
                  <HardDrive className={`h-3.5 w-3.5 ${isActive ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`} />
                  <span>{driveLetter}</span>
                </button>
              );
            })}
          </div>
        )}

        {showNewFolderInput && (
          <div className="border-b border-gray-200 bg-blue-50 px-4 py-3 dark:border-gray-700 dark:bg-blue-900/20">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('folderBrowser.newFolderPlaceholder')}
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : t('folderBrowser.create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                {t('common:cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-gray-700 dark:text-gray-300">..</span>
                </button>
              )}

              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-gray-500 dark:text-gray-400">
                  {t('folderBrowser.noSubfolders')}
                </div>
              ) : (
                visibleFolders.map((folder) => {
                  const isSelected = selectedFolderPath === folder.path;

                  return (
                    <div
                      key={folder.path}
                      className={`flex items-center gap-2 rounded-lg transition-colors ${
                        isSelected
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-700/60 text-gray-900 dark:text-white'
                      }`}
                    >
                      <button
                        onClick={() => {
                          setSelectedFolderPath(folder.path);
                          const match = folder.path.match(/^([a-zA-Z]:)/);
                          if (match) {
                            setSelectedDrive(match[1].toUpperCase());
                          }
                          void loadFolders(folder.path);
                        }}
                        className="flex flex-1 items-center gap-3 px-4 py-3 text-left"
                      >
                        {currentPath === 'drives' ? (
                          <HardDrive className={`h-5 w-5 ${isSelected ? 'text-white' : 'text-blue-500'}`} />
                        ) : (
                          <FolderPlus className={`h-5 w-5 ${isSelected ? 'text-white' : 'text-blue-500'}`} />
                        )}
                        <span className={`font-medium ${isSelected ? 'font-semibold text-white' : ''}`}>
                          {folder.name}
                        </span>
                      </button>
                      <Button
                        variant={isSelected ? 'secondary' : 'ghost'}
                        size="sm"
                        onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                        className={`mr-2 px-3 text-xs ${
                          isSelected
                            ? 'bg-white text-blue-600 hover:bg-blue-50 font-semibold shadow-sm'
                            : 'text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white'
                        }`}
                      >
                        {t('folderBrowser.select')}
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 bg-gray-50 px-4 py-2.5 dark:bg-gray-900/50">
            <span className="text-sm font-medium text-gray-600 dark:text-gray-400 shrink-0">
              {t('folderBrowser.pathLabel')}
            </span>
            <Input
              type="text"
              value={pathInputValue}
              onChange={(event) => setPathInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && pathInputValue.trim()) {
                  void loadFolders(pathInputValue.trim());
                }
              }}
              className="h-8 flex-1 font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (pathInputValue.trim()) {
                  void loadFolders(pathInputValue.trim());
                }
              }}
              className="h-8 px-2.5 text-xs"
            >
              {t('folderBrowser.go', 'Go')}
            </Button>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="default"
              disabled={currentPath === 'drives' && !selectedFolderPath}
              onClick={() => {
                const pathToUse = (currentPath === 'drives' && selectedFolderPath) ? selectedFolderPath : currentPath;
                if (pathToUse && pathToUse !== 'drives') {
                  onFolderSelected(pathToUse, autoAdvanceOnSelect);
                }
              }}
              className="bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {t('folderBrowser.useThisFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
