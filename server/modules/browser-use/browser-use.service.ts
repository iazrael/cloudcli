import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// cross-spawn: drop-in spawn with Windows .cmd/PATHEXT resolution.
import spawn from 'cross-spawn';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { getModuleDirectory } from '@/shared/utils.js';

import { getBrowserUseRuntime } from './browser-use-runtime.js';
import { resolveBrowserPlaywright } from './browser-use-playwright.js';

const __dirname = getModuleDirectory(import.meta.url);
const MAX_SESSIONS_PER_OWNER = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_MAX_SESSIONS_PER_OWNER || '3', 10);
const SESSION_TTL_MS = Number.parseInt(process.env.CLOUDCLI_BROWSER_USE_SESSION_TTL_MS || String(30 * 60 * 1000), 10);
const BROWSER_USE_SETTINGS_KEY = 'browser_use_settings';
const BROWSER_USE_MCP_TOKEN_KEY = 'browser_use_mcp_token';
// Viewport for user-created remote-control sessions; smaller than agent sessions so
// the phone-sized panel stays readable when the screenshot is scaled down.
const MANUAL_VIEWPORT = { width: 1024, height: 768 };
/** Scroll wheel budget per manual-control request; enforced by HTTP routes to bound one gesture. */
export const MANUAL_MAX_SCROLL_DELTA = 5000;
/** Maximum characters per manual keyboard.type() call; enforced by HTTP routes. */
export const MANUAL_TYPE_MAX_LENGTH = 2000;

type BrowserUseRuntime = ReturnType<typeof getBrowserUseRuntime>;
type BrowserUseSessionStatus = 'ready' | 'stopped' | 'unavailable';

type BrowserUseSession = {
  id: string;
  ownerId: string;
  createdBy: 'agent' | 'manual';
  runtime: BrowserUseRuntime;
  status: BrowserUseSessionStatus;
  url: string | null;
  title: string | null;
  screenshotDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  lastAction: string | null;
  message: string | null;
  profileName: string | null;
  viewport: {
    width: number;
    height: number;
  } | null;
  cursor: {
    x: number;
    y: number;
    actor: 'agent' | 'user';
  } | null;
};

type PublicBrowserUseSession = Omit<BrowserUseSession, 'ownerId'>;

type RuntimeHandle = {
  browser?: any;
  context?: any;
  page?: any;
};

type BrowserUseSettings = {
  enabled: boolean;
};

type RuntimeReadiness = {
  playwright: any | null;
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  chromiumExecutablePath: string | null;
  installInProgress: boolean;
  installMessage: string | null;
};

type RuntimeProbe = Omit<RuntimeReadiness, 'installInProgress' | 'installMessage'>;

const sessions = new Map<string, BrowserUseSession>();
const handles = new Map<string, RuntimeHandle>();
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Validates file paths an agent wants to attach to a page's file input.
 * Only absolute paths to existing regular files within the size cap are accepted, and symlinks are
 * resolved so the size/type checks apply to the real target.
 */
function resolveUploadFiles(rawPaths: string[]): string[] {
  if (rawPaths.length === 0) {
    throw new Error('Provide at least one file path.');
  }
  if (rawPaths.length > MAX_UPLOAD_FILES) {
    throw new Error(`At most ${MAX_UPLOAD_FILES} files can be uploaded at once.`);
  }
  return rawPaths.map((rawPath) => {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`File path must be absolute: ${rawPath}`);
    }
    let realPath: string;
    let stat: fs.Stats;
    try {
      realPath = fs.realpathSync(rawPath);
      stat = fs.statSync(realPath);
    } catch {
      throw new Error(`File not found: ${rawPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: ${rawPath}`);
    }
    if (stat.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`File is larger than ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB: ${rawPath}`);
    }
    return realPath;
  });
}

let installPromise: Promise<{ success: boolean; message: string }> | null = null;
let lastInstallMessage: string | null = null;
let runtimeProbeCache: { value: RuntimeProbe; updatedAt: number } | null = null;

const DEFAULT_SETTINGS: BrowserUseSettings = {
  enabled: false,
};
const AGENT_OWNER_ID = 'agent';
const USER_OWNER_ID = 'user';
const BROWSER_USE_ROOT = path.join(os.homedir(), '.cloudcli', 'browser-use');
const PROFILE_ROOT = path.join(BROWSER_USE_ROOT, 'profiles');
// Dedicated out-of-repo npm project. Playwright installed here survives the
// repository's npm install/prune cycles, which drop the --no-save copy.
const RUNTIME_INSTALL_DIR = path.join(BROWSER_USE_ROOT, 'runtime');
const MCP_SERVER_NAME = 'cloudcli-browser';
const LEGACY_MCP_SERVER_NAMES = ['cloudcli-browser-use'];
const RUNTIME_READINESS_CACHE_TTL_MS = 30_000;

function readSettings(): BrowserUseSettings {
  try {
    const raw = appConfigDb.get(BROWSER_USE_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }

    const parsed = JSON.parse(raw) as Partial<BrowserUseSettings>;
    return {
      enabled: parsed.enabled === true,
    };
  } catch (error: any) {
    console.warn('[Browser] Failed to read settings:', error?.message || error);
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(settings: BrowserUseSettings): BrowserUseSettings {
  const normalized = {
    enabled: settings.enabled === true,
  };

  appConfigDb.set(BROWSER_USE_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(BROWSER_USE_MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(BROWSER_USE_MCP_TOKEN_KEY, token);
  return token;
}

function getSetupMessage(settings: BrowserUseSettings, readiness: RuntimeReadiness): string {
  if (!settings.enabled) {
    return 'Browser is disabled in settings.';
  }

  if (!readiness.playwrightInstalled) {
    return 'Install Playwright and Chromium to use browser sessions.';
  }

  if (!readiness.chromiumInstalled) {
    return 'Playwright is installed, but Chromium is missing. Install the Chromium runtime to continue.';
  }

  return readiness.installMessage || 'Browser runtime is not ready.';
}

function ensureRuntimeInstallDir(): string {
  fs.mkdirSync(RUNTIME_INSTALL_DIR, { recursive: true });
  const manifestPath = path.join(RUNTIME_INSTALL_DIR, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    // Without a package.json npm walks up to the nearest ancestor project
    // root and would install playwright somewhere unrelated.
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      name: 'cloudcli-browser-runtime',
      private: true,
      version: '1.0.0',
    }, null, 2)}\n`);
  }
  return RUNTIME_INSTALL_DIR;
}

function getMcpCommand(): { command: string; args: string[] } {
  const mcpScriptPath = path.join(__dirname, 'browser-use-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['browser-use-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/browser-use-mcp`;
}

async function removeMcpServerFromAllProviders(name: string) {
  const results = await providerMcpService.removeMcpServerFromAllProviders({
    name,
    scope: 'user',
  });
  return results.map((result) => ({ ...result, name }));
}

function normalizeProfileName(profileName?: string | null): string | null {
  const normalized = String(profileName || '').trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 80);
}

function getProfilePath(profileName: string): string {
  const safeName = profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
  return path.join(PROFILE_ROOT, safeName);
}

function probeRuntime(): RuntimeProbe {
  const playwright = resolveBrowserPlaywright({ runtimeInstallDir: RUNTIME_INSTALL_DIR });
  const readiness: RuntimeProbe = {
    playwright,
    playwrightInstalled: Boolean(playwright),
    chromiumInstalled: false,
    chromiumExecutablePath: null,
  };

  if (!playwright) {
    return readiness;
  }

  try {
    const executablePath = playwright.chromium.executablePath();
    readiness.chromiumExecutablePath = executablePath;
    readiness.chromiumInstalled = Boolean(executablePath && fs.existsSync(executablePath));
  } catch {
    readiness.chromiumInstalled = false;
  }

  return readiness;
}

function getRuntimeReadiness(options: { force?: boolean } = {}): RuntimeReadiness {
  const now = Date.now();
  const cachedProbe = runtimeProbeCache;
  const canUseCache = !options.force
    && !installPromise
    && cachedProbe
    && now - cachedProbe.updatedAt < RUNTIME_READINESS_CACHE_TTL_MS;
  const probe = canUseCache ? cachedProbe.value : probeRuntime();

  if (!canUseCache && !installPromise) {
    runtimeProbeCache = { value: probe, updatedAt: now };
  }

  return {
    ...probe,
    installInProgress: Boolean(installPromise),
    installMessage: lastInstallMessage,
  };
}

const INSTALL_COMMAND_TIMEOUT_MS = Number.parseInt(
  process.env.CLOUDCLI_BROWSER_USE_INSTALL_TIMEOUT_MS || String(10 * 60 * 1000),
  10,
);

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: string[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(
        `${command} ${args.join(' ')} timed out after ${INSTALL_COMMAND_TIMEOUT_MS}ms.`,
      )));
    }, INSTALL_COMMAND_TIMEOUT_MS);
    timer.unref?.();

    // stdio config above guarantees the pipes exist; cross-spawn's types
    // just don't narrow them the way node's spawn overloads do.
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(output.join('').trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    }));
  });
}

function formatInstallError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('sudo') && message.includes('password')) {
    return 'Installing Chromium system dependencies requires administrator privileges. Run `npx playwright install-deps chromium` on the machine where CloudCLI runs, then try again.';
  }
  return message || 'Failed to install Browser runtime.';
}

async function installRuntime(): Promise<{ success: boolean; message: string }> {
  if (installPromise) {
    return installPromise;
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  runtimeProbeCache = null;
  installPromise = (async () => {
    try {
      lastInstallMessage = 'Installing Playwright package...';
      const installDir = ensureRuntimeInstallDir();
      // The runtime dir has its own package.json, so letting npm save keeps
      // it self-describing; nothing ever reconciles this directory.
      await runCommand(npmCommand, ['install', 'playwright'], installDir);

      if (process.platform === 'linux') {
        lastInstallMessage = 'Installing Chromium system dependencies...';
        await runCommand(npmCommand, ['exec', '--', 'playwright', 'install-deps', 'chromium'], installDir);
      }

      lastInstallMessage = 'Installing Chromium runtime...';
      await runCommand(npmCommand, ['exec', '--', 'playwright', 'install', 'chromium'], installDir);

      lastInstallMessage = 'Browser runtime installed.';
      return { success: true, message: lastInstallMessage };
    } catch (error) {
      lastInstallMessage = formatInstallError(error);
      return { success: false, message: lastInstallMessage };
    }
  })();

  try {
    return await installPromise;
  } finally {
    installPromise = null;
    runtimeProbeCache = null;
  }
}

function parseHttpUrl(trimmed: string, defaultOriginPrefix: string): string {
  // Only treat `scheme://` as an explicit protocol so host:port addresses
  // (localhost:3001) are not misread as unknown URL schemes.
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const withProtocol = hasExplicitScheme ? trimmed : `${defaultOriginPrefix}${trimmed}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  return parsed.toString();
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  return parseHttpUrl(trimmed, 'https://');
}

/**
 * Normalizes an address typed into the panel's manual address bar. Bare hosts
 * default to http because LAN devices such as routers rarely serve https,
 * unlike the agent path which defaults to https. Used by manual-control HTTP
 * routes and unit tests.
 */
export function normalizeManualUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('URL is required.');
  }

  return parseHttpUrl(trimmed, 'http://');
}

const MANUAL_KEY_ALLOWLIST = new Set([
  'Enter', 'Backspace', 'Delete', 'Tab', 'Escape',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

/** Guards page.keyboard.press against arbitrary key injection; used by manual-control HTTP routes and unit tests. */
export function isManualKeyAllowed(key: string): boolean {
  return MANUAL_KEY_ALLOWLIST.has(key);
}

/** True for a supported manual viewport size (panel layout switch range); used by manual-control HTTP routes and unit tests. */
export function isManualViewportSize(size: { width: number; height: number }): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height)
    && size.width >= 320 && size.width <= 1920
    && size.height >= 240 && size.height <= 1440;
}

/** True when a manual click point lands inside the session viewport; used by manual service methods and unit tests. */
export function isManualPointWithinViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number } | null,
): boolean {
  if (!viewport || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return false;
  }

  return point.x >= 0 && point.x < viewport.width && point.y >= 0 && point.y < viewport.height;
}

function publicSession(session: BrowserUseSession): PublicBrowserUseSession {
  const { ownerId: _ownerId, ...publicFields } = session;
  return publicFields;
}

function ownerSessions(ownerId: string): BrowserUseSession[] {
  return [...sessions.values()].filter((session) => session.ownerId === ownerId);
}

async function closeHandle(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  handles.delete(sessionId);
  await handle?.context?.close?.().catch(() => undefined);
  await handle?.browser?.close().catch(() => undefined);
}

async function expireStaleSessions(now = Date.now()): Promise<void> {
  await Promise.all([...sessions.values()].map(async (session) => {
    if (session.status !== 'ready') {
      return;
    }

    const updatedAt = Date.parse(session.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt <= SESSION_TTL_MS) {
      return;
    }

    await closeHandle(session.id);
    session.status = 'stopped';
    session.updatedAt = new Date(now).toISOString();
    session.lastAction = 'expire';
    session.message = 'Browser session expired after inactivity.';
  }));
}

async function captureSession(session: BrowserUseSession, page: any): Promise<void> {
  const screenshot = await page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
  session.screenshotDataUrl = `data:image/jpeg;base64,${Buffer.from(screenshot).toString('base64')}`;
  session.title = await page.title().catch(() => null);
  session.url = page.url() || session.url;
  session.viewport = page.viewportSize?.() || session.viewport;
  session.updatedAt = new Date().toISOString();
}

async function getActionPoint(page: any, input: { selector?: string; text?: string; x?: number; y?: number }) {
  if (typeof input.x === 'number' && typeof input.y === 'number') {
    return { x: input.x, y: input.y };
  }

  const locator = input.selector
    ? page.locator(input.selector).first()
    : input.text
      ? page.getByText(input.text, { exact: false }).first()
      : null;

  if (!locator) {
    return null;
  }

  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    return null;
  }

  return {
    x: Math.round(box.x + box.width / 2),
    y: Math.round(box.y + box.height / 2),
  };
}

async function getManualSession(sessionId: string): Promise<BrowserUseSession> {
  const settings = readSettings();
  if (!settings.enabled) {
    throw new Error('Browser is disabled in settings.');
  }

  const session = sessions.get(sessionId);
  if (!session || session.ownerId !== USER_OWNER_ID) {
    throw new Error('Browser session not found.');
  }

  return session;
}

async function getReadyManualPage(sessionId: string): Promise<{ session: BrowserUseSession; page: any }> {
  // Sweep the TTL first so an idle-expired session is rejected instead of
  // being revived by the next control request or screenshot poll.
  await expireStaleSessions();
  const session = await getManualSession(sessionId);
  if (session.status !== 'ready') {
    throw new Error(session.message || 'Browser session is not available.');
  }

  const handle = handles.get(sessionId);
  if (!handle?.page) {
    throw new Error('Browser runtime handle is not available.');
  }

  return { session, page: handle.page };
}

/**
 * Main service for Browser Use sessions and MCP registration.
 * Consumed by HTTP routes, MCP stdio endpoints, and server initialization.
 */
export const browserUseService = {
  async getSettings() {
    return readSettings();
  },

  async updateSettings(settings: Partial<BrowserUseSettings>) {
    const current = readSettings();
    const nextSettings = {
      enabled: typeof settings.enabled === 'boolean' ? settings.enabled : current.enabled,
    };

    const next = writeSettings(nextSettings);
    if (next.enabled) {
      await this.registerAgentMcp();
    } else if (current.enabled) {
      await this.unregisterAgentMcp();
      await this.stopAllSessions();
    }
    return next;
  },

  async getStatus() {
    const settings = readSettings();
    const readiness = getRuntimeReadiness();
    const available = settings.enabled && readiness.playwrightInstalled && readiness.chromiumInstalled;

    return {
      enabled: settings.enabled,
      runtime: getBrowserUseRuntime(),
      available,
      playwrightInstalled: readiness.playwrightInstalled,
      chromiumInstalled: readiness.chromiumInstalled,
      installInProgress: readiness.installInProgress,
      sessionCount: sessions.size,
      message: available
        ? 'Browser runtime is available.'
        : getSetupMessage(settings, readiness),
    };
  },

  async registerAgentMcp() {
    const { command, args } = getMcpCommand();
    await Promise.all(LEGACY_MCP_SERVER_NAMES.map((name) => removeMcpServerFromAllProviders(name)));
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command,
      args,
      env: {
        CLOUDCLI_BROWSER_USE_MCP_TOKEN: getOrCreateMcpToken(),
        CLOUDCLI_BROWSER_USE_API_URL: getMcpApiUrl(),
      },
    });
    return { name: MCP_SERVER_NAME, command, args, results };
  },

  /**
   * Idempotently reconciles the browser-use MCP server registration across all
   * providers if browser sessions are enabled in settings. Called during server startup
   * to ensure newly added providers or freshly installed clients stay in sync.
   */
  async syncAgentMcpIfNeeded() {
    const settings = readSettings();
    if (!settings.enabled) {
      return { synced: false, reason: 'disabled' };
    }

    const registration = await this.registerAgentMcp();
    return { synced: true, registration };
  },

  getMcpToken() {
    return getOrCreateMcpToken();
  },

  async unregisterAgentMcp() {
    const results = (await Promise.all(
      [MCP_SERVER_NAME, ...LEGACY_MCP_SERVER_NAMES].map((name) => removeMcpServerFromAllProviders(name)),
    )).flat();
    return { name: MCP_SERVER_NAME, results };
  },

  async installRuntime() {
    const result = await installRuntime();
    return {
      ...result,
      status: await this.getStatus(),
    };
  },

  async listSessions() {
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID || session.ownerId === USER_OWNER_ID)
      .map(publicSession);
  },

  async createAgentSession(options?: { profileName?: string | null }) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }

    await expireStaleSessions();
    const profileName = normalizeProfileName(options?.profileName);

    const now = new Date().toISOString();
    const session: BrowserUseSession = {
      id: randomUUID(),
      ownerId: AGENT_OWNER_ID,
      createdBy: 'agent',
      runtime: getBrowserUseRuntime(),
      status: 'unavailable',
      url: null,
      title: null,
      screenshotDataUrl: null,
      createdAt: now,
      updatedAt: now,
      lastAction: 'create',
      message: null,
      profileName,
      viewport: { width: 1440, height: 900 },
      cursor: null,
    };

    const activeOwnerSessions = ownerSessions(AGENT_OWNER_ID).filter((item) => item.status === 'ready');
    if (activeOwnerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active agent sessions.`);
    }

    const readiness = getRuntimeReadiness();
    if (!settings.enabled || !readiness.playwrightInstalled || !readiness.chromiumInstalled || !readiness.playwright) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    let browser: any | undefined;
    let context: any | undefined;
    let page: any;
    const launchOptions = {
      headless: true,
      args: ['--disable-dev-shm-usage'],
    };
    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    };

    if (profileName) {
      fs.mkdirSync(PROFILE_ROOT, { recursive: true });
      context = await readiness.playwright.chromium.launchPersistentContext(getProfilePath(profileName), {
        ...launchOptions,
        ...contextOptions,
      });
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await readiness.playwright.chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
      page = await context.newPage();
    }
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(session.id, session);
    handles.set(session.id, { browser, context, page });
    await captureSession(session, page);
    return publicSession(session);
  },

  async listAgentSessions() {
    const settings = readSettings();
    if (!settings.enabled) {
      return [];
    }
    await expireStaleSessions();
    return [...sessions.values()]
      .filter((session) => session.ownerId === AGENT_OWNER_ID)
      .map(publicSession);
  },

  async getAgentSession(sessionId: string) {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser agent tools are disabled.');
    }
    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }
    return session;
  },

  async agentNavigate(sessionId: string, rawUrl: string) {
    await this.getAgentSession(sessionId);
    await expireStaleSessions();

    const session = sessions.get(sessionId);
    if (!session || session.ownerId !== AGENT_OWNER_ID) {
      throw new Error('Browser session not found.');
    }

    if (session.status !== 'ready') {
      throw new Error(session.message || 'Browser session is not available.');
    }

    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    const url = normalizeUrl(rawUrl);
    await handle.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSnapshot(sessionId: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await captureSession(session, handle.page);
    const text = await handle.page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    return {
      session: publicSession(session),
      text: text.slice(0, 30_000),
    };
  },

  async agentUploadFiles(sessionId: string, input: { selector?: string; paths: string[] }) {
    // Validate the files first so bad input fails fast, before taking the session lock.
    const files = resolveUploadFiles(input.paths);
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const selector = input.selector || 'input[type="file"]';
    // setInputFiles works on hidden inputs too, which is how most upload widgets are built.
    await handle.page.locator(selector).first().setInputFiles(files, { timeout: 10_000 });
    session.lastAction = `upload_files:${files.length}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentClick(sessionId: string, input: { selector?: string; text?: string; x?: number; y?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const point = await getActionPoint(handle.page, input);

    if (input.selector) {
      await handle.page.locator(input.selector).first().click({ timeout: 10_000 });
    } else if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().click({ timeout: 10_000 });
    } else if (typeof input.x === 'number' && typeof input.y === 'number') {
      await handle.page.mouse.click(input.x, input.y);
    } else {
      throw new Error('Provide selector, text, or x/y coordinates.');
    }

    session.lastAction = 'click';
    session.cursor = point ? { ...point, actor: 'agent' } : null;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentType(sessionId: string, input: { selector?: string; text: string; submit?: boolean }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }

    if (input.selector) {
      await handle.page.locator(input.selector).first().fill(input.text, { timeout: 10_000 });
      session.cursor = await getActionPoint(handle.page, input).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    } else {
      await handle.page.keyboard.type(input.text);
    }
    if (input.submit) {
      await handle.page.keyboard.press('Enter');
    }

    session.lastAction = 'type';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentFillForm(sessionId: string, fields: Array<{ selector: string; value: string }>) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    for (const field of fields) {
      await handle.page.locator(field.selector).first().fill(field.value, { timeout: 10_000 });
    }
    session.lastAction = 'fill_form';
    if (fields[0]) {
      session.cursor = await getActionPoint(handle.page, { selector: fields[0].selector }).then((point) => (
        point ? { ...point, actor: 'agent' as const } : null
      ));
    }
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentPressKey(sessionId: string, key: string) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.keyboard.press(key);
    session.lastAction = `press_key:${key}`;
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentSelectOption(sessionId: string, selector: string, values: string[]) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    await handle.page.locator(selector).first().selectOption(values, { timeout: 10_000 });
    session.lastAction = 'select_option';
    session.cursor = await getActionPoint(handle.page, { selector }).then((point) => (
      point ? { ...point, actor: 'agent' as const } : null
    ));
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentWaitFor(sessionId: string, input: { text?: string; url?: string; timeoutMs?: number }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const timeout = Math.max(250, Math.min(input.timeoutMs || 5_000, 30_000));
    if (input.text) {
      await handle.page.getByText(input.text, { exact: false }).first().waitFor({ timeout });
    } else if (input.url) {
      await handle.page.waitForURL(input.url, { timeout });
    } else {
      await handle.page.waitForTimeout(timeout);
    }
    session.lastAction = 'wait_for';
    await captureSession(session, handle.page);
    return publicSession(session);
  },

  async agentTabs(sessionId: string, input: { action?: 'list' | 'new' | 'select' | 'close'; index?: number; url?: string }) {
    const session = await this.getAgentSession(sessionId);
    const handle = handles.get(sessionId);
    if (!handle?.context || !handle?.page) {
      throw new Error('Browser runtime handle is not available.');
    }
    const action = input.action || 'list';
    if (action === 'new') {
      const page = await handle.context.newPage();
      handles.set(sessionId, { ...handle, page });
      if (input.url) {
        await this.agentNavigate(sessionId, input.url);
      }
    } else if (action === 'select') {
      const page = handle.context.pages()[input.index || 0];
      if (!page) {
        throw new Error('Tab not found.');
      }
      handles.set(sessionId, { ...handle, page });
    } else if (action === 'close') {
      const pages = handle.context.pages();
      const page = pages[input.index ?? pages.indexOf(handle.page)];
      if (!page) {
        throw new Error('Tab not found.');
      }
      await page.close();
      handles.set(sessionId, { ...handle, page: handle.context.pages()[0] || await handle.context.newPage() });
    }
    const updatedHandle = handles.get(sessionId);
    await captureSession(session, updatedHandle?.page || handle.page);
    return {
      session: publicSession(session),
      tabs: handle.context.pages().map((page: any, index: number) => ({
        index,
        url: page.url(),
        active: page === (updatedHandle?.page || handle.page),
      })),
    };
  },

  /**
   * Creates a remote-control session owned by the panel user rather than an
   * agent. Same pool as agent sessions: TTL reaping, per-owner limits, and the
   * settings toggle all apply.
   */
  async createManualSession() {
    const settings = readSettings();
    if (!settings.enabled) {
      throw new Error('Browser is disabled in settings.');
    }

    await expireStaleSessions();
    const now = new Date().toISOString();
    const session: BrowserUseSession = {
      id: randomUUID(),
      ownerId: USER_OWNER_ID,
      createdBy: 'manual',
      runtime: getBrowserUseRuntime(),
      status: 'unavailable',
      url: null,
      title: null,
      screenshotDataUrl: null,
      createdAt: now,
      updatedAt: now,
      lastAction: 'create',
      message: null,
      profileName: null,
      viewport: { ...MANUAL_VIEWPORT },
      cursor: null,
    };

    const activeOwnerSessions = ownerSessions(USER_OWNER_ID).filter((item) => item.status === 'ready');
    if (activeOwnerSessions.length >= MAX_SESSIONS_PER_OWNER) {
      throw new Error(`Browser is limited to ${MAX_SESSIONS_PER_OWNER} active sessions.`);
    }

    const readiness = getRuntimeReadiness();
    if (!readiness.playwrightInstalled || !readiness.chromiumInstalled || !readiness.playwright) {
      session.message = getSetupMessage(settings, readiness);
      sessions.set(session.id, session);
      return publicSession(session);
    }

    const browser = await readiness.playwright.chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({
      viewport: { ...MANUAL_VIEWPORT },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    session.status = 'ready';
    session.message = 'Browser session is ready.';
    sessions.set(session.id, session);
    handles.set(session.id, { browser, context, page });
    await captureSession(session, page);
    return publicSession(session);
  },

  /** Navigates a manual session; bare hosts default to http for LAN addresses. */
  async manualNavigate(sessionId: string, rawUrl: string) {
    const { session, page } = await getReadyManualPage(sessionId);
    const url = normalizeManualUrl(rawUrl);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    session.lastAction = `navigate:${url}`;
    session.cursor = null;
    await captureSession(session, page);
    return publicSession(session);
  },

  async manualNav(sessionId: string, action: 'back' | 'forward' | 'reload') {
    const { session, page } = await getReadyManualPage(sessionId);
    if (action === 'back') {
      await page.goBack();
    } else if (action === 'forward') {
      await page.goForward();
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    session.lastAction = action;
    await captureSession(session, page);
    return publicSession(session);
  },

  async manualClick(sessionId: string, point: { x: number; y: number }) {
    const { session, page } = await getReadyManualPage(sessionId);
    if (!isManualPointWithinViewport(point, session.viewport)) {
      throw new Error('Click coordinates are outside the browser viewport.');
    }

    await page.mouse.click(point.x, point.y);
    session.lastAction = 'click';
    session.cursor = { ...point, actor: 'user' };
    await captureSession(session, page);
    return publicSession(session);
  },

  async manualScroll(sessionId: string, delta: { deltaX: number; deltaY: number }) {
    const { session, page } = await getReadyManualPage(sessionId);
    if (!session.viewport) {
      throw new Error('Browser runtime handle is not available.');
    }

    await page.mouse.move(session.viewport.width / 2, session.viewport.height / 2);
    await page.mouse.wheel(delta.deltaX, delta.deltaY);
    session.lastAction = 'scroll';
    await captureSession(session, page);
    return publicSession(session);
  },

  async manualType(sessionId: string, text: string) {
    const { session, page } = await getReadyManualPage(sessionId);
    await page.keyboard.type(text);
    session.lastAction = 'type';
    await captureSession(session, page);
    return publicSession(session);
  },

  async manualPressKey(sessionId: string, key: string) {
    const { session, page } = await getReadyManualPage(sessionId);
    await page.keyboard.press(key);
    session.lastAction = `press_key:${key}`;
    await captureSession(session, page);
    return publicSession(session);
  },

  /** Fresh screenshot for the manual-control polling loop; also refreshes url/title/viewport metadata. */
  async getManualScreen(sessionId: string) {
    const { session, page } = await getReadyManualPage(sessionId);
    await captureSession(session, page);
    return publicSession(session);
  },

  /** Resizes a manual session live for the panel's mobile/desktop layout switch. */
  async manualViewport(sessionId: string, viewport: { width: number; height: number }) {
    const { session, page } = await getReadyManualPage(sessionId);
    if (!isManualViewportSize(viewport)) {
      throw new Error('Viewport size is out of the supported range.');
    }

    await page.setViewportSize({ ...viewport });
    session.lastAction = `viewport:${viewport.width}x${viewport.height}`;
    session.cursor = null;
    await captureSession(session, page);
    return publicSession(session);
  },

  async stopSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || (session.ownerId !== AGENT_OWNER_ID && session.ownerId !== USER_OWNER_ID)) {
      return { stopped: false };
    }

    await closeHandle(sessionId);

    session.status = 'stopped';
    session.updatedAt = new Date().toISOString();
    session.lastAction = 'stop';
    session.message = 'Browser session stopped. Create a new session to continue browsing.';
    return { stopped: true, session: publicSession(session) };
  },

  async deleteSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || (session.ownerId !== AGENT_OWNER_ID && session.ownerId !== USER_OWNER_ID)) {
      return { deleted: false };
    }

    await closeHandle(sessionId);
    sessions.delete(sessionId);
    return { deleted: true, sessionId };
  },

  async agentStopSession(sessionId: string) {
    await this.getAgentSession(sessionId);
    return this.stopSession(sessionId);
  },

  async stopAllSessions() {
    await Promise.all([...sessions.keys()].map(async (sessionId) => {
      await closeHandle(sessionId);
      const session = sessions.get(sessionId);
      if (session) {
        session.status = 'stopped';
        session.updatedAt = new Date().toISOString();
        session.lastAction = 'shutdown';
        session.message = 'Browser session stopped during server shutdown.';
      }
    }));
  },
};

process.once('beforeExit', () => {
  void browserUseService.stopAllSessions();
});
