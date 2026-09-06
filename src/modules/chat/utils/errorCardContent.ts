/**
 * Error-card content parsing.
 *
 * Some providers persist engine errors as a serialized object string
 * (zcode history writes the engine's `{ name, data: { message, code } }`
 * adapter error through a pretty-JSON formatter). Rendering that string
 * verbatim buries the one line a user needs under JSON noise, so the error
 * card shows the extracted message as its body and keeps the full JSON
 * behind a "details" fold. Consumers: MessageComponent's error branch.
 */

/** Parsed error-card content: the display message and the pretty JSON detail. */
export type ErrorCardContent = {
  /** The human-readable message extracted from the serialized error object. */
  message: string;
  /** The full error object, pretty-printed for the collapsible detail block. */
  detailJson: string;
};

/**
 * Reads a display string off a parsed error object. Engine adapter errors
 * nest their message under `data`; flat records keep top-level fields. The
 * chain ends at `name` so even a bare `{ name: "AbortError" }` reads as
 * something other than raw JSON.
 */
const readErrorMessage = (record: Record<string, unknown>): string | undefined => {
  const data = record.data;
  const nested = data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const at = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;
  return at(nested?.message)
    ?? at(record.message)
    ?? at(record.code)
    ?? at(record.name);
};

/**
 * Parses an error card's content when it is a serialized JSON object.
 * Returns null for anything else — plain-text errors, arrays, malformed
 * JSON — which the card then renders verbatim as before.
 */
export function parseErrorCardContent(content: string): ErrorCardContent | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return {
    message: readErrorMessage(record) ?? trimmed,
    detailJson: JSON.stringify(parsed, null, 2),
  };
}
