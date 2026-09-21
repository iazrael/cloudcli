// ScheduledJobsPanel: rendered by the workspace's Scheduled tab.
export { default as ScheduledJobsPanel } from '@/modules/scheduled-jobs/ScheduledJobsPanel';

// useScheduledJobs: used by the chat composer's scheduled-task banner.
export { useScheduledJobs } from '@/modules/scheduled-jobs/hooks/useScheduledJobs';

// useScheduledJobsEnabled: used by the workspace shell and chat composer to
// gate the tab and the repeat entry behind the global feature switch.
export { useScheduledJobsEnabled } from '@/modules/scheduled-jobs/hooks/useScheduledJobsEnabled';

// Schedule helpers: used by the chat composer's repeat entry and banner to
// build expressions and to label them without duplicating the parsing rules.
export {
  buildCronExpression,
  describeSchedule,
  readLocalTimezone,
  readSchedulePattern,
  type ScheduleDescription,
  type SchedulePattern,
  type SchedulePresetId,
} from '@/modules/scheduled-jobs/utils/schedulePresets';
