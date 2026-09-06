/// <reference types="vite/client" />

/**
 * Installed package version, injected by Vite's `define` at build time.
 * Read it through `APP_VERSION` in `@/shared/constants`, which also covers
 * runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __APP_VERSION__: string;

/**
 * Build fingerprint injected by Vite's `define` at build time: the git short hash
 * of the built tree (suffixed `-dirty` for uncommitted changes), the build
 * timestamp, and `git describe --tags --dirty --always` output — the full
 * tag-anchored identity (e.g. `v2.0.0-14-g273e294`) of the built tree. Read it
 * through `BUILD_INFO` in `@/shared/constants`, which also covers runners such
 * as `tsx` that do not apply Vite's define replacement.
 */
declare const __BUILD_INFO__: { commit: string; buildTime: string; describe: string };
