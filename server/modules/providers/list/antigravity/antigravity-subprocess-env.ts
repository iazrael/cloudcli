/**
 * Antigravity Subprocess Env Builder
 *
 * Builds the environment handed to every spawned `agy` child process. agy 1.5.9
 * detects an SSH session from `SSH_TTY` / `SSH_CONNECTION` / `SSH_CLIENT` and,
 * when one is present, swaps the keychain token store for its file-based store
 * (composite_token_storage.go: "Using file-based token storage because SSH
 * session detected"). The pm2 daemon's inherited environment carries those
 * variables as launch leftovers, so under pm2 agy always picked the file store,
 * and whenever that file-side token had expired or gone stale, every fresh agy
 * invocation demanded interactive OAuth and failed — quota, model catalog, and
 * chat sessions included. Dropping the indicators pins agy to the keychain
 * store, the same one an interactive terminal login uses, so the two token
 * paths converge instead of alternating between a valid and an empty store.
 *
 * @module antigravity-subprocess-env
 */

/**
 * Environment for agy subprocess launches. Consumers: antigravity quota,
 * models, and runtime providers (their execFile/crossSpawn calls).
 */
export function buildAntigravitySubprocessEnv(): NodeJS.ProcessEnv {
  const {
    SSH_TTY: _sshTty,
    SSH_CONNECTION: _sshConnection,
    SSH_CLIENT: _sshClient,
    ...env
  } = process.env;
  return env;
}
