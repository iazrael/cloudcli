import React from 'react';

import { parseAgyBackgroundTaskList } from '@/modules/chat/tools/utils/agyBackgroundTasks';

type BackgroundTasksContentProps = {
  content: string;
};

/**
 * Renders an agy `manage_task` Action=list answer: every background command
 * the engine reported as running at query time, with its summary and the
 * command line. `logUri` is a local `file://` path the WebUI cannot open, so
 * it stays out of the card.
 *
 * Rendered by chat's ToolRenderer as the content of a Task-list result.
 */
export const BackgroundTasksContent: React.FC<BackgroundTasksContentProps> = ({ content }) => {
  const parsed = parseAgyBackgroundTaskList(content);

  if (!parsed || parsed.kind === 'raw') {
    return (
      <pre className="whitespace-pre-wrap font-mono text-[11px] text-gray-600 dark:text-gray-400">
        {parsed?.text ?? content}
      </pre>
    );
  }

  if (parsed.kind === 'empty' || parsed.tasks.length === 0) {
    return (
      <div className="py-0.5 text-[11px] italic text-gray-400 dark:text-gray-500">
        No background tasks are currently running.
      </div>
    );
  }

  return (
    <div className="space-y-px">
      {parsed.tasks.map((task, index) => (
        <div key={task.taskId ?? index} className="py-0.5">
          <div className="flex items-center gap-1.5">
            <svg className="h-3 w-3 flex-shrink-0 text-blue-500 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="min-w-0 flex-1 truncate text-xs text-gray-900 dark:text-gray-100" title={task.summary}>
              {task.summary}
            </span>
            {task.toolName && (
              <span className="flex-shrink-0 rounded border border-gray-200 px-1 py-px text-[10px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {task.toolName}
              </span>
            )}
          </div>
          {task.description && task.description !== task.summary && (
            <div className="ml-[18px] truncate font-mono text-[11px] text-gray-500 dark:text-gray-400" title={task.description}>
              {task.description}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
