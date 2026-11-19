import { getEditorLoadingStyles } from '@/modules/code-editor/utils/editorStyles';

type CodeEditorLoadingStateProps = {
  isDarkMode: boolean;
  isSidebar: boolean;
  loadingText: string;
  // Closing out of a stuck load: a large file can hold the pane for a long
  // transfer, and touchscreens have no Escape key to fall back on.
  onCancel: () => void;
  cancelLabel: string;
};

/** Rendered by CodeEditor inside the code-editor module while a file's contents are still being fetched. */
export default function CodeEditorLoadingState({
  isDarkMode,
  isSidebar,
  loadingText,
  onCancel,
  cancelLabel,
}: CodeEditorLoadingStateProps) {
  const spinnerRow = (
    <div className="flex flex-col items-center gap-4">
      <div className="flex items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-blue-600" />
        <span className="text-gray-900 dark:text-white">{loadingText}</span>
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {cancelLabel}
      </button>
    </div>
  );

  return (
    <>
      <style>{getEditorLoadingStyles(isDarkMode)}</style>
      {isSidebar ? (
        <div className="flex h-full w-full items-center justify-center bg-background">
          {spinnerRow}
        </div>
      ) : (
        <div className="fixed inset-0 z-[9999] md:flex md:items-center md:justify-center md:bg-black/50">
          <div className="code-editor-loading flex h-full w-full items-center justify-center p-8 md:h-auto md:w-auto md:rounded-lg">
            {spinnerRow}
          </div>
        </div>
      )}
    </>
  );
}
