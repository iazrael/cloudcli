import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  buildCronExpression,
  describeSchedule,
  presetForPattern,
  readSchedulePattern,
} from '@/modules/scheduled-jobs/utils/schedulePresets';

test('presets build five-field expressions in the user\'s clock time', () => {
  assert.equal(buildCronExpression('daily', { time: '09:30', customExpression: '' }), '30 9 * * *');
  assert.equal(buildCronExpression('weekdays', { time: '08:05', customExpression: '' }), '5 8 * * 1-5');
  assert.equal(buildCronExpression('weekly', { time: '18:00', customExpression: '' }), '0 18 * * 1');
  assert.equal(buildCronExpression('hourly', { time: '09:30', customExpression: '' }), '30 * * * *');
  assert.equal(
    buildCronExpression('custom', { time: '09:30', customExpression: ' 15 3 * * 0 ' }),
    '15 3 * * 0',
  );
});

test('an invalid time falls back to the default instead of producing a broken expression', () => {
  assert.equal(buildCronExpression('daily', { time: '25:99', customExpression: '' }), '0 9 * * *');
});

test('expressions read back into the preset that produced them', () => {
  assert.deepEqual(readSchedulePattern('30 9 * * *'), { kind: 'daily', time: '09:30' });
  assert.deepEqual(readSchedulePattern('5 8 * * 1-5'), { kind: 'weekdays', time: '08:05' });
  assert.deepEqual(readSchedulePattern('0 18 * * 1'), { kind: 'weekly', time: '18:00' });
  assert.deepEqual(readSchedulePattern('30 * * * *'), { kind: 'hourly', minute: 30 });
  assert.deepEqual(readSchedulePattern('*/5 * * * *'), { kind: 'custom' });
  assert.deepEqual(readSchedulePattern('not a cron'), { kind: 'custom' });
  assert.equal(presetForPattern(readSchedulePattern('0 18 * * 1')), 'weekly');
});

test('descriptions carry the translation key and its parameters', () => {
  assert.deepEqual(describeSchedule('30 9 * * *'), { key: 'presets.daily', params: { time: '09:30' } });
  assert.deepEqual(describeSchedule('30 * * * *'), { key: 'presets.hourly', params: { minute: '30' } });
  assert.deepEqual(describeSchedule('*/5 * * * *'), {
    key: 'presets.custom',
    params: { expression: '*/5 * * * *' },
  });
});
