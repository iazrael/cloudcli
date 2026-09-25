import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readLocalDateTimeInputValue, toLocalDateTimeInputValue } from '@/shared/utils';

test('a datetime-local value round-trips through its instant in the browser zone', () => {
  const date = new Date(2027, 2, 5, 9, 30);

  const inputValue = toLocalDateTimeInputValue(date);
  assert.equal(inputValue, '2027-03-05T09:30');
  assert.equal(readLocalDateTimeInputValue(inputValue)?.getTime(), date.getTime());
});

test('an empty or malformed datetime-local value reads as null', () => {
  assert.equal(readLocalDateTimeInputValue(''), null);
  assert.equal(readLocalDateTimeInputValue('not a date'), null);
});
