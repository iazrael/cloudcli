import { AppError } from '@/shared/utils.js';

/** The JSON body every API error response carries. */
type ApiErrorResponseBody = {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/**
 * The request-body failures that are the client's fault, and the response each
 * one gets. body-parser tags every failure with a `type`; only the ones
 * listed here are the client's own doing (a malformed body, a body over the
 * limit, a request cut off mid-flight), so only they keep a 4xx status.
 *
 * Anything else — a route that failed, an upstream that answered badly —
 * stays a generic 500, so an internal message never reaches the client.
 */
const PARSER_ERRORS: Record<string, { code: string; statusCode: number }> = {
  'entity.parse.failed': { code: 'INVALID_JSON_BODY', statusCode: 400 },
  'entity.too.large': { code: 'PAYLOAD_TOO_LARGE', statusCode: 413 },
  'request.aborted': { code: 'REQUEST_ABORTED', statusCode: 400 },
  'encoding.unsupported': { code: 'UNSUPPORTED_ENCODING', statusCode: 415 },
  'charset.unsupported': { code: 'UNSUPPORTED_CHARSET', statusCode: 415 },
  'parameters.too.many': { code: 'TOO_MANY_PARAMETERS', statusCode: 413 },
};

/**
 * The hint a malformed body gets. The commonest cause is a hand-written path
 * whose backslashes were not escaped, which reads as a server fault when it
 * is not one.
 */
const MALFORMED_JSON_MESSAGE =
  'Invalid JSON request body. If a value contains backslashes, such as a Windows path, escape them as \\\\ or use forward slashes.';

/**
 * Translates any error reaching the server's final error middleware into the
 * HTTP status and JSON body the client receives.
 *
 * A controlled `AppError` keeps its own status, code and details. A request
 * body that body-parser rejected keeps the 4xx status the parser gave it
 * instead of being reported as a 500. Anything else stays a generic 500 so
 * internals never leak.
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

  const parserError = typeof error === 'object' && error !== null && 'type' in error
    && typeof (error as { type?: unknown }).type === 'string'
    ? PARSER_ERRORS[(error as { type: string }).type]
    : undefined;

  if (parserError) {
    const isMalformedJson = parserError.code === 'INVALID_JSON_BODY';
    return {
      statusCode: parserError.statusCode,
      body: {
        success: false,
        error: {
          code: parserError.code,
          message: isMalformedJson
            ? MALFORMED_JSON_MESSAGE
            : error instanceof Error ? error.message : 'Bad request',
          // Keep the parser's position hint, but not in the top-level message:
          // the message is what a person reads first.
          details: isMalformedJson && error instanceof Error ? error.message : undefined,
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
