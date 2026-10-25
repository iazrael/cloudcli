/**
 * Environment gate for tests that execute a command through Codex's own
 * sandbox (`command/exec`).
 *
 * Consumers: `task-continuation-worker-crash.test.ts` (detached worker),
 * `task-continuation-worker.test.ts` (worker run directly) and
 * `task-routes-http.test.ts` (worker driven through the MCP route).
 *
 * The Windows sandbox needs machine-level setup — Codex's restricted-token
 * helper binaries plus Defender/ASR exclusions — and where that setup is
 * missing `command/exec` just times out (the standalone `codex sandbox`
 * command fails the same way), which no test-side change can fix. Probing once
 * lets those tests report a visible skip instead of a red suite, while still
 * running on Windows machines where the sandbox works. POSIX sandboxes need no
 * probe.
 */
export async function isCodexCommandSandboxAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true;
  }

  try {
    const { executeCodexSandboxCommand } = await import('@/modules/providers/index.js');
    const result = await executeCodexSandboxCommand({
      command: [process.execPath, '-e', 'process.exit(0)'],
      cwd: process.cwd(),
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
