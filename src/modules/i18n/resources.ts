/**
 * Per-language locale loader.
 *
 * Every file under `locales/<lang>/<ns>.json` is reachable only through the
 * dynamic imports below, so Vite emits one lazy `locale-<lang>` chunk per
 * language (see the manualChunks rule in vite.config.js). Startup loads just
 * the saved language plus the en fallback instead of all 15 languages.
 */

export const FALLBACK_LANGUAGE = 'en';

/** A loaded translation bundle for one namespace, keyed like i18next resources. */
export type LocaleResources = Record<string, Record<string, Record<string, unknown>>>;

type LocaleModule = { default: Record<string, unknown> };

const localeModules = import.meta.glob<LocaleModule>('./locales/*/*.json');

/** Load every namespace file of one language; resolves to an empty object when none match. */
async function loadLanguage(language: string): Promise<Record<string, Record<string, unknown>>> {
  const entries = await Promise.all(
    Object.entries(localeModules)
      .filter(([path]) => path.startsWith(`./locales/${language}/`))
      .map(async ([path, load]) => {
        const namespace = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
        return [namespace, (await load()).default] as const;
      }),
  );
  return Object.fromEntries(entries);
}

/**
 * Load the requested language plus the en fallback.
 *
 * A language whose chunk fails to fetch is warned about and omitted — the
 * caller renders with whatever landed (worst case raw keys) instead of
 * blocking startup on a failed network request.
 */
export async function loadLocaleResources(language: string): Promise<LocaleResources> {
  const targets =
    language === FALLBACK_LANGUAGE ? [FALLBACK_LANGUAGE] : [language, FALLBACK_LANGUAGE];
  const settled = await Promise.all(
    targets.map(async (target) => {
      try {
        const namespaces = await loadLanguage(target);
        return Object.keys(namespaces).length > 0 ? ([target, namespaces] as const) : null;
      } catch (error) {
        console.warn(`[i18n] Failed to load "${target}" translations`, error);
        return null;
      }
    }),
  );
  return Object.fromEntries(settled.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
}
