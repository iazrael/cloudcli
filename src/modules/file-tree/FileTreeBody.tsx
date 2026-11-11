import type { DragEvent, ReactNode, RefObject } from 'react';
import { AlertTriangle, Folder, Loader2, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileTreeNode, FileTreeViewMode } from '@/shared/types';
import FileTreeEmptyState from '@/modules/file-tree/FileTreeEmptyState';
import FileTreeList from '@/modules/file-tree/FileTreeList';

// Present while the search box holds text; the body then shows search results.
type FileTreeBodySearch = {
  searching: boolean;
  error: string | null;
  truncated: boolean;
  indexIncomplete: boolean;
};

type FileTreeBodyProps = {
  items: FileTreeNode[];
  error?: string | null;
  search: FileTreeBodySearch | null;
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  onItemClick: (item: FileTreeNode) => void;
  onRetryDirectory?: (path: string) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNode) => void;
  onDelete?: (item: FileTreeNode) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNode) => void;
  onDownload?: (item: FileTreeNode) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  // Drag-and-drop upload targeting
  dropTarget?: string | null;
  onItemDragOver?: (event: DragEvent<HTMLDivElement>, targetPath: string) => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNode | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
};

/** Rendered by FileTree to choose between the empty/error states and the file list. */
export default function FileTreeBody({
  items,
  error,
  search,
  viewMode,
  expandedDirs,
  onItemClick,
  onRetryDirectory,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onUpload,
  onRefresh,
  dropTarget,
  onItemDragOver,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
}: FileTreeBodyProps) {
  const { t } = useTranslation();

  return (
    <>
      {error ? (
        <FileTreeEmptyState
          icon={AlertTriangle}
          title={t('fileTree.loadFailed')}
          description={error}
        />
      ) : search?.searching ? (
        <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('fileTree.searching')}
        </div>
      ) : search?.error ? (
        <FileTreeEmptyState
          icon={AlertTriangle}
          title={t('fileTree.searchFailed')}
          description={search.error}
        />
      ) : items.length === 0 && search ? (
        <FileTreeEmptyState
          icon={Search}
          title={t('fileTree.noMatchesFound')}
          description={t('fileTree.tryDifferentSearch')}
        />
      ) : items.length === 0 ? (
        <FileTreeEmptyState
          icon={Folder}
          title={t('fileTree.noFilesFound')}
          description={t('fileTree.checkProjectPath')}
        />
      ) : (
        <FileTreeList
          items={items}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={onItemClick}
          onRetryDirectory={onRetryDirectory}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTime}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onUpload={onUpload}
          onRefresh={onRefresh}
          dropTarget={dropTarget}
          onItemDragOver={onItemDragOver}
          renamingItem={renamingItem}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          handleConfirmRename={handleConfirmRename}
          handleCancelRename={handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
        />
      )}
      {search && !search.searching && !search.error && (search.truncated || search.indexIncomplete) && (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {search.indexIncomplete ? t('fileTree.searchIndexIncomplete') : t('fileTree.searchTruncated')}
        </p>
      )}
    </>
  );
}
