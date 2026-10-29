import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'
import { safariRegexCompatPlugin } from './src/modules/chat/utils/safariRegexCompat.ts'
import { reportRollupWarning } from './src/shared/rollupWarningFilter.ts'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  // Build fingerprint shown in the UI (splash + About). It changes on every build,
  // so a long-lived PWA window can be told apart from the latest deploy. `-dirty`
  // marks builds made from a tree with uncommitted changes. Both commands pass
  // `--tags` so lightweight and annotated release tags anchor equally; the
  // tag-anchored form (v2.0.0-14-g273e294) identifies the exact build without
  // repeating the package version next to it.
  let buildCommit = 'unknown'
  let buildDescribe = buildCommit
  try {
    const gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const isDirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0 ? '-dirty' : ''
    buildCommit = `${gitHash}${isDirty}`
    buildDescribe = `v${pkg.version}-${gitHash}${isDirty}`
  } catch {
    // Outside a git repository (e.g. building from a release tarball)
  }
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const buildTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`

  return {
    plugins: [react(), safariRegexCompatPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_INFO__: JSON.stringify({ commit: buildCommit, buildTime, describe: buildDescribe })
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./shared', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      // Hidden maps: generated into dist/assets/*.map but not referenced by
      // the bundles, so production stays lean while minified stack traces
      // (file + line + column) can still be mapped back to source locally.
      sourcemap: 'hidden',
      rollupOptions: {
        // The `virtua` package ships PURE-annotation comments in a position
        // Rollup cannot read, so every build reports four INVALID_ANNOTATION
        // warnings that no change on our side can silence. Everything else is
        // handed to Vite's own handler, which keeps the warnings Vite hides by
        // itself (CIRCULAR_DEPENDENCY, THIS_IS_UNDEFINED) hidden.
        onwarn(warning, defaultHandler) {
          reportRollupWarning(warning, defaultHandler)
        },
        output: {
          manualChunks(id) {
            // Rollup synthetic helpers and common runtime helpers must stay with the foundational vendor
            // chunk to prevent circular dependencies caused by helpers being placed into downstream chunks.
            if (id.includes('commonjsHelpers') || id.includes('@babel/runtime') || id.includes('tslib')) {
              return 'vendor-react';
            }

            if (id.includes('node_modules')) {
              // Exact package boundaries to prevent matching 'lucide-react' or other packages ending in '-react/'
              if (/\/node_modules\/(?:react|react-dom|react-router|react-router-dom|react-error-boundary|scheduler)\//.test(id)) {
                return 'vendor-react';
              }
              if (id.includes('@codemirror') || id.includes('@uiw/react-codemirror') || id.includes('@replit/codemirror-minimap')) {
                return 'vendor-codemirror';
              }
              if (id.includes('@xterm')) {
                return 'vendor-xterm';
              }
              if (id.includes('react-syntax-highlighter') || id.includes('refractor') || id.includes('prismjs')) {
                return 'vendor-highlight';
              }
              if (id.includes('katex') || id.includes('rehype-katex') || id.includes('remark-math')) {
                return 'vendor-katex';
              }
              if (
                id.includes('react-markdown') ||
                id.includes('remark-') ||
                id.includes('rehype-') ||
                id.includes('dompurify') ||
                id.includes('gray-matter') ||
                id.includes('micromark') ||
                id.includes('unist-') ||
                id.includes('mdast-') ||
                id.includes('vfile')
              ) {
                return 'vendor-markdown';
              }
              if (id.includes('lucide-react')) {
                return 'vendor-icons';
              }
              if (id.includes('@octokit')) {
                return 'vendor-octokit';
              }
              if (id.includes('i18next') || id.includes('react-i18next')) {
                return 'vendor-i18n';
              }
              if (
                id.includes('jszip') ||
                id.includes('tailwind-merge') ||
                id.includes('clsx') ||
                id.includes('class-variance-authority') ||
                id.includes('cmdk') ||
                id.includes('fuse.js') ||
                id.includes('react-dropzone') ||
                id.includes('file-selector')
              ) {
                return 'vendor-utils';
              }
            }
            // Locale JSON is reachable only through the dynamic loader in
            // resources.ts, so each language becomes its own lazy chunk and
            // startup downloads just the saved language plus en.
            const localeLanguage = /\/src\/modules\/i18n\/locales\/([^/]+)\//.exec(id)?.[1];
            if (localeLanguage) {
              return `locale-${localeLanguage}`;
            }
            if (id.includes('/src/modules/settings/')) {
              return 'module-settings';
            }
            if (id.includes('/src/modules/git-panel/')) {
              return 'module-git';
            }
            if (id.includes('/src/modules/plugins/')) {
              return 'module-plugins';
            }
            if (id.includes('/src/modules/mcp/')) {
              return 'module-mcp';
            }
            if (id.includes('/src/modules/skills/')) {
              return 'module-skills';
            }
            if (id.includes('/src/modules/browser-use/')) {
              return 'module-browser-use';
            }
          }
        }
      }
    }
  }
})
