import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from './shared/utils.js';
import { createErrorResponse } from './error-response.js';

function withStatus(error: Error, statusCode: number, type?: string): Error & { statusCode: number; type?: string } {
  return Object.assign(error, { statusCode, status: statusCode, type });
}

test('a controlled AppError keeps its status, code, message and details', () => {
  const response = createErrorResponse(new AppError('Path is required', {
    code: 'PROJECT_PATH_REQUIRED',
    statusCode: 400,
    details: { field: 'path' },
  }));

  assert.deepEqual(response, {
    statusCode: 400,
    body: {
      success: false,
      error: {
        code: 'PROJECT_PATH_REQUIRED',
        message: 'Path is required',
        details: { field: 'path' },
      },
    },
  });
});

test('malformed JSON is a client error, not a 500, with a Windows-path hint', () => {
  const response = createErrorResponse(
    withStatus(new SyntaxError('Bad escaped character in JSON at position 19'), 400, 'entity.parse.failed'),
  );

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON_BODY');
  assert.match(response.body.error.message, /escape them as \\\\/);
  assert.match(response.body.error.message, /forward slashes/);
  assert.equal(response.body.error.details, 'Bad escaped character in JSON at position 19');
});

test('other body-parser failures keep their 4xx status and parser type', () => {
  const tooLarge = createErrorResponse(withStatus(new Error('request entity too large'), 413, 'entity.too.large'));
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.error.code, 'ENTITY_TOO_LARGE');
  assert.equal(tooLarge.body.error.message, 'request entity too large');

  const aborted = createErrorResponse(withStatus(new Error('request aborted'), 400, 'request.aborted'));
  assert.equal(aborted.statusCode, 400);
  assert.equal(aborted.body.error.code, 'REQUEST_ABORTED');
});

test('an unexpected error stays a generic 500 so internals never leak', () => {
  const response = createErrorResponse(new Error('database connection string: secret'));

  assert.deepEqual(response, {
    statusCode: 500,
    body: {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
  });
});
