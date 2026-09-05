/// <reference types="vite/client" />

/**
 * Installed package version, injected by Vite's `define` at build time.
 * Read it through `APP_VERSION` in `@/shared/constants`, which also covers
 * runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __APP_VERSION__: string;

/**
 * Build fingerprint injected by Vite's `define` at build time: the git short hash
 * of the built tree (suffixed `-dirty` for uncommitted changes) and the build
 * timestamp. Read it through `BUILD_INFO` in `@/shared/constants`, which also
 * covers runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __BUILD_INFO__: { commit: string; buildTime: string };
