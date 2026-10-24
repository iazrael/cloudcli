/**
 * Model families, in the spelling they are shown in. The provider reports a
 * full id (`claude-opus-5`, `claude-haiku-4-5-20251001`); the footer has room
 * for the family, and the exact id stays in the tooltip.
 */
const MODEL_FAMILY_LABELS: ReadonlyArray<readonly [token: string, label: string]> = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['fable', 'Fable'],
];

/**
 * Shortens a reported model id to the label shown under a reply, or `null`
 * when there is nothing to show. Used by chat's MessageModelLabel.
 *
 * ZCode's engine reports account-scoped ids (`account:bigmodel-individual-coding-plan/GLM-5.3-Flash`);
 * the `account:`/`builtin:` qualifier is engine plumbing rather than part of
 * the model name, so it is stripped before labeling. An id from no known
 * family is shown verbatim rather than dropped, so an unrecognized model still
 * reports itself honestly. A `[1m]` suffix is kept as "1M" instead of being
 * folded into the base family: Claude Code writes the base id on assistant
 * rows today, but if a provider ever reports the 1M variant it must not read
 * as the 200K one.
 */
export const formatAnsweringModelLabel = (model: string | undefined): string | null => {
  const reportedModel = model?.trim();
  if (!reportedModel) {
    return null;
  }

  const withoutAccountScope = /^(?:account|builtin):/i.test(reportedModel)
    ? reportedModel.slice(reportedModel.indexOf('/') + 1)
    : reportedModel;
  const normalized = withoutAccountScope.toLowerCase();
  const family = MODEL_FAMILY_LABELS.find(([token]) => normalized.includes(token));
  if (!family) {
    return withoutAccountScope;
  }

  return normalized.endsWith('[1m]') ? `${family[1]} 1M` : family[1];
};
