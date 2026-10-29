/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - Per-language lazy loading of translation bundles (see resources.ts)
 * - Language detection from the user preference mirror
 * - Fallback to English for missing translations
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { languages } from '@/modules/i18n/languages';
import { loadLocaleResources } from '@/modules/i18n/resources';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

// The chosen language lives in auth.db so it follows the user between devices.
// It is read synchronously from the preference mirror because i18n has to be
// configured at module load, long before any request could resolve.
const getSavedLanguage = (): string => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  // Validate that the saved language is supported
  if (saved && languages.some(lang => lang.value === saved)) {
    return saved;
  }
  return 'en';
};

// Bundles load per language on demand, so the instance is initialized empty
// and `partialBundledLanguages` keeps it usable before the first chunk lands.
// `initI18n()` must resolve before the first React render; afterwards the
// languageChanged event always fires with the target bundles already merged.
i18n
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    partialBundledLanguages: true,

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'git'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings. Suspense stays off because bundles are merged
    // before render; a failed chunk load then degrades to raw keys instead of
    // suspending the tree forever.
    react: {
      useSuspense: false,
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },
  });

// Languages whose bundles were already merged into the instance; loading is
// idempotent per language.
const ensuredLanguages = new Set<string>();

async function ensureLocaleLoaded(language: string): Promise<void> {
  if (ensuredLanguages.has(language)) {
    return;
  }
  const resources = await loadLocaleResources(language);
  for (const [lang, namespaces] of Object.entries(resources)) {
    for (const [namespace, bundle] of Object.entries(namespaces)) {
      i18n.addResourceBundle(lang, namespace, bundle, true, true);
    }
    ensuredLanguages.add(lang);
  }
}

/** Load the saved language's bundles; must resolve before the first render. */
export async function initI18n(): Promise<void> {
  await ensureLocaleLoaded(getSavedLanguage());
}

/**
 * Switch the UI language, loading its bundles first so the re-render triggered
 * by `languageChanged` never shows untranslated keys. Unsupported codes are
 * ignored.
 */
export async function switchLanguage(language: string): Promise<void> {
  if (!languages.some((lang) => lang.value === language)) {
    return;
  }
  await ensureLocaleLoaded(language);
  await i18n.changeLanguage(language);
}

// Save language preference when it changes
i18n.on('languageChanged', (lng: string) => {
  writeUserPreference('userLanguage', lng);
});

// A language chosen on another device arrives with the hydrated preferences,
// after i18n was already initialized with whatever the mirror held.
subscribeToUserPreferences(() => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  if (saved && saved !== i18n.language && languages.some(lang => lang.value === saved)) {
    void switchLanguage(saved);
  }
});

export default i18n;
