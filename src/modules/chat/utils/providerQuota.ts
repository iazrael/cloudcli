import type { ProviderQuotaGroupPartitioning } from '@/shared/types';

/**
 * Builds the backend URL to query account quota for a provider.
 *
 * Whether to ask at all is the capability matrix's answer (`supportsQuota`),
 * not this module's: the list of providers with a quota adapter used to be
 * restated here, which is why adding one to the backend never showed up in the
 * UI until someone remembered to edit the list too.
 */
export function buildProviderQuotaUrl(provider: string, forceRefresh = false): string {
  const searchParams = new URLSearchParams({ provider });
  if (forceRefresh) {
    searchParams.set('refresh', 'true');
  }
  return `/api/providers/quota?${searchParams.toString()}`;
}

/** Returns null when the model doesn't belong to any known family bucket. */
function matchesFamily(groupText: string, normalizedModel: string): boolean | null {
  if (normalizedModel.includes('gemini')) {
    return groupText.includes('gemini');
  }
  if (normalizedModel.includes('claude') || normalizedModel.includes('gpt')) {
    return groupText.includes('claude') || groupText.includes('gpt');
  }
  if (normalizedModel.includes('glm')) {
    return groupText.includes('glm') || groupText.includes('zcode');
  }
  return null;
}

/**
 * Determines whether a quota group corresponds to the active session model.
 *
 * Rules:
 * 1. A single group is the active session's by definition.
 * 2. `model-family` partitioning: each group's own text names its family, so a family
 *    keyword match reliably tells them apart.
 * 3. `bucket` partitioning: the groups share one family and split it by allowance — a
 *    "reserve" carve-out sitting beside the main pool. A family match would wrongly tag the
 *    reserve as active for every model of that family, so a reserve bucket's text must name
 *    the running model explicitly; an unmatched non-reserve bucket is the account's
 *    general-purpose pool.
 *
 * Which of the two applies is stated by the provider in its quota payload, never
 * inferred here from the provider's name.
 */
export function resolveIsActiveQuotaGroup(
  currentModel: string | undefined,
  group: { name: string; description?: string },
  totalGroupsCount: number,
  partitioning?: ProviderQuotaGroupPartitioning,
): boolean {
  if (totalGroupsCount <= 1) {
    return true;
  }

  const groupText = `${group.name} ${group.description || ''}`.toLowerCase();
  const normalizedModel = (currentModel || '').toLowerCase();
  const bucketPartitioned = partitioning === 'bucket';

  if (bucketPartitioned && groupText.includes('reserve')) {
    return Boolean(normalizedModel) && groupText.includes(normalizedModel);
  }

  const familyMatch = matchesFamily(groupText, normalizedModel);
  if (familyMatch !== null) {
    if (familyMatch) {
      return true;
    }
    if (!bucketPartitioned) {
      return false;
    }
    // Bucket-partitioned providers: the family keyword missed (e.g. Codex's
    // main pool is just called "Codex (Plus)") — fall through below.
  }

  if (normalizedModel && groupText.includes(normalizedModel)) {
    return true;
  }

  // Bucket-partitioned providers with no family or model mention at all:
  // treat this non-reserve bucket as the account's general-purpose pool.
  return bucketPartitioned && familyMatch !== null && Boolean(normalizedModel);
}
