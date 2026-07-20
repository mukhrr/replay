import { randomUUID } from 'node:crypto';

/**
 * Placeholder expansion for recorded step values.
 *
 * Some repros are single-shot as recorded: the flow mutates server state, so
 * the second replay finds the work already done and the bug cannot recur. A
 * developer looping on `--expect-fixed` then gets green from run 2 onward
 * whether or not they fixed anything — a silent false pass, the worst outcome
 * this tool can produce.
 *
 * Client-side session seeding cannot help, because the mutation is on the
 * server. What does help is making the input unique per run, so each replay
 * creates fresh state. Hand-edit the recorded value:
 *
 *   "value": "merchant:walmart"        ->  "value": "merchant:walmart-{{random}}"
 *
 * Expansion happens at replay time and never touches the stored IR.
 */

const PLACEHOLDERS: Record<string, () => string> = {
  uuid: () => randomUUID(),
  random: () => Math.random().toString(36).slice(2, 10),
  now: () => String(Date.now()),
  isodate: () => new Date().toISOString(),
};

export const PLACEHOLDER_NAMES = Object.keys(PLACEHOLDERS);

/** True if the value contains at least one recognised placeholder. */
export function hasPlaceholder(value: string | null): boolean {
  if (!value) return false;
  return PLACEHOLDER_NAMES.some((name) => value.includes(`{{${name}}}`));
}

/**
 * Replace `{{uuid}}`, `{{random}}`, `{{now}}` and `{{isodate}}`.
 * Unknown placeholders are left alone rather than blanked, so a typo is visible
 * in the failure message instead of silently producing an empty field.
 */
export function expandValue(value: string | null): string | null {
  if (!value) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const make = PLACEHOLDERS[name];
    return make ? make() : match;
  });
}
