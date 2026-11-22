import { AppError, errorStatusCode } from '@/shared/utils.js';

/** The JSON body every API error response carries. */
type ApiErrorResponseBody = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

function readErrorType(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return '';
  }
  return typeof error.type === 'string' ? error.type : '';
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '';
}

/**
 * Translates any error reaching the server's final error middleware into the
 * HTTP status and JSON body the client receives.
 *
 * A controlled `AppError` keeps its own status, code and details. Errors that
 * carry a 4xx status of their own — body-parser's malformed-JSON and
 * oversized-body failures, for example — keep that status instead of being
 * reported as a 500. Anything else stays a generic 500 so internals never leak.
 *
 * Consumers: `server/index.ts` global error middleware; tests cover the
 * malformed-JSON path that Windows paths in hand-written bodies trigger.
 */
export function createErrorResponse(error: unknown): { statusCode: number; body: ApiErrorResponseBody } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
    };
  }

  const statusCode = errorStatusCode(error);
  if (statusCode >= 400 && statusCode < 500) {
    const errorType = readErrorType(error);
    const isMalformedJson = errorType === 'entity.parse.failed';
    return {
      statusCode,
      body: {
        success: false,
        error: {
          code: isMalformedJson
            ? 'INVALID_JSON_BODY'
            : errorType
              ? errorType.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
              : 'BAD_REQUEST',
          message: isMalformedJson
            ? 'Invalid JSON request body. If a value contains backslashes, such as a Windows path, escape them as \\\\ or use forward slashes.'
            : readErrorMessage(error) || 'Bad request',
          // Keep the parser's position hint, but not in the top-level message:
          // the message is what a person reads first.
          details: isMalformedJson ? readErrorMessage(error) : undefined,
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
  };
}
