/**
 * Antigravity provider module barrel exports.
 */

export { AntigravityProvider } from './antigravity.provider.js';
// Shutdown hook for the resident ACP session processes; consumed by the
// server's composition root (server/index.ts shutdown sequence).
export { closeAntigravityAcpSessions } from './antigravity-runtime.provider.js';
export {
  getAntigravityBrainRoots,
  getAntigravityDataRoot,
  getAntigravityOauthTokenPath,
  getAntigravitySettingsPath,
  getAntigravitySummariesDbPath,
  getAntigravityTranscriptCandidates,
} from './antigravity-data-root.js';
export {
  fetchAntigravityQuota,
  resetAntigravityQuotaCache,
  type AntigravityQuotaBucket,
  type AntigravityQuotaGroup,
  type AntigravityQuotaData,
} from './antigravity-quota.provider.js';
