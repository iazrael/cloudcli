import path from 'node:path';

type AppBrandingDependencies = {
  appRoot: string;
  environment: NodeJS.ProcessEnv;
  hostname(): string;
  readFile(filePath: string): string;
  fileExists(filePath: string): boolean;
  logError(message: string, detail?: string): void;
};

/**
 * Android launchers ellipsize home-screen labels, so the manifest short_name
 * is capped while the full name stays available to install dialogs and app
 * info. Characters are counted by code point so CJK names truncate cleanly.
 */
const MAX_SHORT_NAME_LENGTH = 12;

/** Windows appends these to machine names; they carry no meaning on a phone. */
const WINDOWS_HOST_PREFIXES = ['DESKTOP-', 'LAPTOP-'];

const RELATIVE_MANIFEST_PATHS = [
  // Git/dev installs keep the source manifest under public/ and serve it first.
  path.join('public', 'manifest.json'),
  // The npm package ships only api-docs.html from public/, so the built copy
  // under dist/ is the template that exists in production installs.
  path.join('dist', 'manifest.json'),
];
const RELATIVE_INDEX_PATH = path.join('dist', 'index.html');

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength ? value : characters.slice(0, maxLength).join('');
}

function toShortName(appName: string): string {
  const upperCaseName = appName.toUpperCase();
  for (const prefix of WINDOWS_HOST_PREFIXES) {
    if (upperCaseName.startsWith(prefix) && appName.length > prefix.length) {
      return truncate(appName.slice(prefix.length), MAX_SHORT_NAME_LENGTH);
    }
  }
  return truncate(appName, MAX_SHORT_NAME_LENGTH);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Per-node PWA identity consumed by the server entrypoint. The entrypoint
 * serves the branded manifest at /manifest.json and injects the name into the
 * apple mobile web app title, because iOS ignores the manifest short_name when
 * a user adds the app to the home screen. The name is `CLOUDCLI_NODE_NAME`
 * when set, otherwise the machine hostname.
 */
export function createAppBrandingService(dependencies: AppBrandingDependencies) {
  const configuredName = dependencies.environment.CLOUDCLI_NODE_NAME?.trim();
  const appName = configuredName || dependencies.hostname().trim() || 'CloudCLI';
  const shortName = toShortName(appName);

  // Both responses are cached because the name is fixed for the lifetime of
  // the process and the packaged files only change across restarts.
  let cachedManifestJson: string | null = null;
  let cachedIndexHtml: string | null | undefined;

  function loadManifestTemplate(): Record<string, unknown> | null {
    for (const relativePath of RELATIVE_MANIFEST_PATHS) {
      const manifestPath = path.join(dependencies.appRoot, relativePath);
      if (!dependencies.fileExists(manifestPath)) {
        continue;
      }
      try {
        return JSON.parse(dependencies.readFile(manifestPath)) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logError('Failed to read the app manifest template:', message);
        return null;
      }
    }
    return null;
  }

  return {
    /** Full app name: install dialogs, Android app info, and the iOS apple title. */
    getAppName(): string {
      return appName;
    },

    /** Home-screen label, kept short so launchers do not ellipsize it. */
    getShortName(): string {
      return shortName;
    },

    /** Returns the manifest served at /manifest.json with this node's name fields. */
    getManifestJson(): string {
      if (cachedManifestJson !== null) {
        return cachedManifestJson;
      }

      const template = loadManifestTemplate() ?? { start_url: '/', display: 'standalone' };
      cachedManifestJson = JSON.stringify(
        { ...template, name: appName, short_name: shortName },
        null,
        2,
      );
      return cachedManifestJson;
    },

    /**
     * Returns dist/index.html with the apple mobile web app title replaced, or
     * null when no production build is present so the entrypoint falls back to
     * the Vite dev redirect.
     */
    renderIndexHtml(): string | null {
      if (cachedIndexHtml !== undefined) {
        return cachedIndexHtml;
      }

      const indexPath = path.join(dependencies.appRoot, RELATIVE_INDEX_PATH);
      let renderedHtml: string | null = null;
      if (dependencies.fileExists(indexPath)) {
        try {
          renderedHtml = dependencies.readFile(indexPath).replace(
            /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
            `$1${escapeHtmlAttribute(appName)}$2`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          dependencies.logError('Failed to inject the app name into index.html:', message);
          renderedHtml = null;
        }
      }

      cachedIndexHtml = renderedHtml;
      return renderedHtml;
    },
  };
}
