/**
 * Antigravity Credential Store Probe
 *
 * Detects an agy login kept outside the OAuth token file, in the operating
 * system's credential store: the macOS login keychain (service `gemini`,
 * account `antigravity`) or the Windows Credential Manager generic credential
 * (`gemini:antigravity`, written by agy through the Go keyring library).
 *
 * agy writes the token file on a completed login, but later refreshes can
 * update only the credential store — and a failed refresh can clear the file
 * while the stored copy stays valid — so the file alone under-reports
 * authenticated state and traps the UI in its login prompt.
 *
 * @module antigravity-credential-store
 */

import { execFileSync } from 'node:child_process';

/**
 * The macOS keychain addresses the agy credential as service + account;
 * Windows Credential Manager joins them into a single target name.
 */
const ANTIGRAVITY_KEYCHAIN_SERVICE = 'gemini';
const ANTIGRAVITY_KEYCHAIN_ACCOUNT = 'antigravity';
const ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET = `${ANTIGRAVITY_KEYCHAIN_SERVICE}:${ANTIGRAVITY_KEYCHAIN_ACCOUNT}`;

/**
 * Environment switch that disables every credential-store probe. Test suites
 * set it so a fixture tree stays the only credential source under test.
 */
const SKIP_CREDENTIAL_STORE_ENV = 'CLOUDCLI_ANTIGRAVITY_SKIP_CREDENTIAL_STORE';

/**
 * Runs one read-only credential-store query and returns its stdout. Injectable
 * so tests can exercise both platform probes on any machine.
 */
type CredentialStoreCommandRunner = (command: string, args: string[]) => string;

function runCredentialStoreCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
    windowsHide: true,
  });
}

/**
 * macOS login keychain: `security find-generic-password` exits non-zero when
 * the item is missing, so a successful run is the signal. `security` prints
 * item attributes only (never the password without `-w`), keeping the probe
 * read-only.
 *
 * Consumers: hasStoredAntigravityCredential; the antigravity test suite, which
 * injects a runner to pin both outcomes.
 */
export function hasMacKeychainCredential(run: CredentialStoreCommandRunner = runCredentialStoreCommand): boolean {
  try {
    run('security', [
      'find-generic-password',
      '-s', ANTIGRAVITY_KEYCHAIN_SERVICE,
      '-a', ANTIGRAVITY_KEYCHAIN_ACCOUNT,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows Credential Manager: `cmdkey /list` always exits 0 — even when
 * nothing matches — so the serialized `target=gemini:antigravity` entry line is
 * the signal. The unfiltered listing is used on purpose: `cmdkey
 * /list:<target>` echoes the requested target in its header even when nothing
 * is stored, which would make a naive match always true.
 *
 * Consumers: hasStoredAntigravityCredential; the antigravity test suite, which
 * injects a runner to pin both outcomes.
 */
export function hasWindowsCredentialManagerCredential(
  run: CredentialStoreCommandRunner = runCredentialStoreCommand,
): boolean {
  try {
    const stdout = run('cmdkey', ['/list']);
    return stdout.toLowerCase().includes(`target=${ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET}`);
  } catch {
    return false;
  }
}

/**
 * Detects whether agy has login credentials in the current platform's
 * credential store. Linux desktop keyrings are not probed: agy stores the
 * login in the token file there. Set `CLOUDCLI_ANTIGRAVITY_SKIP_CREDENTIAL_STORE=1`
 * to force a negative result (test isolation).
 *
 * Consumers: AntigravityProviderAuth, as the credential fallback when the
 * OAuth token file is absent.
 */
export function hasStoredAntigravityCredential(): boolean {
  if (process.env[SKIP_CREDENTIAL_STORE_ENV] === '1') {
    return false;
  }
  if (process.platform === 'darwin') {
    return hasMacKeychainCredential();
  }
  if (process.platform === 'win32') {
    return hasWindowsCredentialManagerCredential();
  }
  return false;
}
