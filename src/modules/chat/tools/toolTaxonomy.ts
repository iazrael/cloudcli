/**
 * The single authority on tool-name identity for display purposes: alias →
 * canonical name, the display families derived from it, and the command-text
 * extraction both the renderer and the group container shared verbatim.
 *
 * Before this module the same lists lived in ToolRenderer, MessageComponent,
 * ToolGroupContainer and toolGrouping, drifting independently — adding an
 * engine alias meant touching all of them. Adding an alias is now one row in
 * `TOOL_ALIASES`.
 *
 * Consumer: the chat tools module (ToolRenderer, MessageComponent,
 * ToolGroupContainer, toolGrouping); `toolTaxonomy.test.ts` pins the map.
 */

const TOOL_ALIASES: Record<string, string> = {
  run_command: 'Bash',
  exec: 'Bash',
  command_execution: 'Bash',
  view_file: 'Read',
  replace_file_content: 'Edit',
  ApplyPatch: 'Edit',
  apply_patch: 'Edit',
  write_to_file: 'Write',
  find_by_name: 'Glob',
  grep_search: 'Grep',
  list_dir: 'LS',
  search_web: 'WebSearch',
  read_url_content: 'WebFetch',
  manage_task: 'Task',
  manage_subagents: 'Subagent',
  invoke_subagent: 'Subagent',
  ExitPlanMode: 'Plan',
  exit_plan_mode: 'Plan',
  Plan: 'Plan',
  update_plan: 'Plan',
};

/** The engine-neutral name a tool alias resolves to (its grouping identity). */
export function canonicalToolName(toolName: string): string {
  return TOOL_ALIASES[toolName] ?? toolName;
}

const COMMAND_TOOLS = new Set(['Bash']);

/** Command-row tools: one `$ command` line with the output inline. */
export function isCommandTool(toolName: string): boolean {
  return COMMAND_TOOLS.has(canonicalToolName(toolName));
}

const EDIT_TOOLS = new Set(['Edit', 'Write']);

/** File-mutating tools: title click opens an editor on the touched file. */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.has(canonicalToolName(toolName));
}

const FILE_PREVIEW_TOOLS = new Set(['Read', 'Edit', 'Write', 'LS']);

/** Tools whose group preview collapses to the file's basename. */
export function isFilePreviewTool(toolName: string): boolean {
  return FILE_PREVIEW_TOOLS.has(canonicalToolName(toolName));
}

/**
 * Display category for the collapsible card. Explicit and ordered — the
 * categories cross alias families (`manage_task` is 'task' while `Task` is
 * 'agent'), so this must not be derived from the canonical name.
 */
const DISPLAY_CATEGORIES: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
  ['edit', new Set(['Edit', 'Write', 'ApplyPatch', 'replace_file_content', 'write_to_file'])],
  ['search', new Set(['Grep', 'Glob', 'grep_search', 'find_by_name', 'list_dir'])],
  ['bash', new Set(['Bash', 'run_command'])],
  ['todo', new Set(['TodoWrite', 'TodoRead'])],
  ['task', new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'manage_task'])],
  ['agent', new Set(['Task', 'invoke_subagent', 'manage_subagents', 'send_message'])],
  ['plan', new Set(['exit_plan_mode', 'ExitPlanMode'])],
  ['question', new Set(['AskUserQuestion'])],
];

export function getToolDisplayCategory(toolName: string): string {
  for (const [category, names] of DISPLAY_CATEGORIES) {
    if (names.has(toolName)) {
      return category;
    }
  }
  return 'default';
}

/** The command field of a parsed tool input, or '' when there is none. */
export function pickCommandField(parsed: unknown): string {
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    return String(record.command || record.cmd || record.CommandLine || '');
  }
  return '';
}

const NESTED_COMMAND_PATTERN = /(?:["'](?:cmd|command)["']|\b(?:cmd|command))\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/s;

const hasNestedCommandMarker = (value: string): boolean =>
  value.includes('tools.exec_command') || value.includes('tools.shell_command');

/**
 * Unwraps a command string that wraps another tool call — MCP script runners
 * embed the real command as a `cmd:`/`command:` field inside their own
 * argument blob. `fallbackSource` is where to look when `cmd` itself is empty
 * (the renderer falls back to the raw input string).
 */
export function unwrapNestedCommand(cmd: string, fallbackSource: string = cmd): string {
  if (cmd && !hasNestedCommandMarker(cmd)) {
    return cmd;
  }
  const source = fallbackSource || cmd;
  if (!hasNestedCommandMarker(source)) {
    return cmd;
  }
  const match = source.match(NESTED_COMMAND_PATTERN);
  if (!match) {
    return cmd;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].slice(1, -1);
  }
}
