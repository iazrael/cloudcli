/**
 * Renders one non-text block of an OpenCode tool result as card text.
 *
 * v2 persists attachments inline: reading an image yields a
 * `{type:'file', uri:'data:image/png;base64,…', mime, name}` block. Passed
 * through verbatim, every such read put megabytes of base64 into the
 * transcript (a session that reads a few hundred frames ships tens of MB of
 * history and freezes the chat), so inline payloads collapse to a short label.
 * The file path is already on the card's input.
 */
export const formatOpenCodeToolBlock = (record: Record<string, unknown>): string => {
  const uri = typeof record.uri === 'string' ? record.uri : null;
  if (uri?.startsWith('data:')) {
    const mime = typeof record.mime === 'string' ? record.mime : uri.slice(5, uri.search(/[;,]/));
    const name = typeof record.name === 'string' ? record.name : '';
    const kilobytes = Math.round((uri.length - uri.indexOf(',') - 1) * 0.75 / 1024);
    return `[${mime || 'file'}${name ? ` ${name}` : ''}, ${kilobytes} KB]`;
  }
  try {
    return JSON.stringify(record, null, 2);
  } catch {
    return String(record);
  }
};
