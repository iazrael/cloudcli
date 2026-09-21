/**
 * Cron helpers shared by the composer's repeat entry and the Scheduled tab's
 * form: presets generate five-field expressions, and an existing expression is
 * read back into the preset that produced it (or `custom`).
 */

export type SchedulePresetId = 'daily' | 'weekdays' | 'weekly' | 'hourly' | 'custom';

/** A cron expression parsed back into the shape the form edits. */
export type SchedulePattern =
  | { kind: 'daily' | 'weekdays' | 'weekly'; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'custom' };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function readCronFields(expression: string): string[] | null {
  const fields = expression.trim().split(/\s+/);
  return fields.length === 5 ? fields : null;
}

/** The expression a preset builds; `custom` passes its own text through. */
export function buildCronExpression(
  preset: SchedulePresetId,
  options: { time: string; customExpression: string },
): string {
  if (preset === 'custom') {
    return options.customExpression.trim();
  }

  const match = TIME_PATTERN.exec(options.time);
  const minutes = match ? Number(match[2]) : 0;
  const hours = match ? Number(match[1]) : 9;

  switch (preset) {
    case 'daily':
      return `${minutes} ${hours} * * *`;
    case 'weekdays':
      return `${minutes} ${hours} * * 1-5`;
    case 'weekly':
      return `${minutes} ${hours} * * 1`;
    case 'hourly':
      return `${minutes} * * * *`;
  }
}

/** Reads an expression back into the preset form; anything unparseable is custom. */
export function readSchedulePattern(cronExpression: string): SchedulePattern {
  const fields = readCronFields(cronExpression);
  if (!fields) {
    return { kind: 'custom' };
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const numericMinute = /^\d{1,2}$/.test(minute);
  const numericHour = /^\d{1,2}$/.test(hour);
  const time = numericHour && numericMinute
    ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    : null;

  if (time && dayOfMonth === '*' && month === '*') {
    if (dayOfWeek === '*') return { kind: 'daily', time };
    if (dayOfWeek === '1-5') return { kind: 'weekdays', time };
    if (dayOfWeek === '1') return { kind: 'weekly', time };
  }

  if (
    hour === '*'
    && dayOfMonth === '*'
    && month === '*'
    && dayOfWeek === '*'
    && numericMinute
  ) {
    return { kind: 'hourly', minute: Number(minute) };
  }

  return { kind: 'custom' };
}

/** The preset a parsed pattern maps to, for initializing the form's selector. */
export function presetForPattern(pattern: SchedulePattern): SchedulePresetId {
  return pattern.kind;
}

/** A translation-ready label for a schedule, in the `scheduled` namespace. */
export type ScheduleDescription =
  | { key: 'presets.daily' | 'presets.weekdays' | 'presets.weekly'; params: { time: string } }
  | { key: 'presets.hourly'; params: { minute: string } }
  | { key: 'presets.custom'; params: { expression: string } };

/**
 * Describes an expression the way the lists show it: presets get a phrase,
 * anything else keeps its raw five-field form.
 */
export function describeSchedule(cronExpression: string): ScheduleDescription {
  const pattern = readSchedulePattern(cronExpression);
  switch (pattern.kind) {
    case 'daily':
      return { key: 'presets.daily', params: { time: pattern.time } };
    case 'weekdays':
      return { key: 'presets.weekdays', params: { time: pattern.time } };
    case 'weekly':
      return { key: 'presets.weekly', params: { time: pattern.time } };
    case 'hourly':
      return { key: 'presets.hourly', params: { minute: String(pattern.minute).padStart(2, '0') } };
    case 'custom':
      return { key: 'presets.custom', params: { expression: cronExpression } };
  }
}

/**
 * The browser's IANA zone, sent with every job so "09:00" means the user's
 * 09:00 rather than the server's.
 */
export function readLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
