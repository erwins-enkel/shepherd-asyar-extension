// ─────────────────────────────────────────────────────────────────────────
// Hold code → urgency tier.
//
// This is the ONE place the extension asserts something Shepherd does not.
// Shepherd's SIGNAL_TIER (src/rundown-core.ts) cannot be mirrored: it is keyed
// by SignalCode, a different vocabulary — `blocked-decision` and `in-flight`
// exist only as signals, while `blocked-menu`, the four `quota-*` codes,
// `autopilot-paused` and `merge-rebasing` exist only as holds. There is no
// HOLD_TIER map anywhere upstream.
//
// Because the table is hand-written, unknown → tier 1 is load-bearing, not
// politeness: a code Shepherd ships tomorrow is guaranteed to be unknown here,
// and a waiting session that silently vanishes breaks the one promise this
// extension makes.
// ─────────────────────────────────────────────────────────────────────────
import type { HoldCode } from './types';

export type Tier = 1 | 2 | 3;

/** Forward progress is blocked on the operator. */
const TIER_1: readonly HoldCode[] = [
  'halted-error',
  'blocked-menu',
  'blocked-yes-no',
  'blocked-awaiting-input',
  'blocked-stall',
  'blocked-generic',
  'quota-rework',
  'quota-review',
  'quota-error',
  'quota-plan',
  'autopilot-paused',
  'plan-rework',
  'plan-question',
  'critic-rework',
  'ci-red',
  'pr-conflict',
  'manual-steps',
];

/** Needs a look soon. */
const TIER_2: readonly HoldCode[] = [
  'halted-usage',
  'awaiting-merge',
  'stalled',
  'recap-attention',
  'train-error',
];

/** Routine in-flight state. */
const TIER_3: readonly HoldCode[] = ['ready-merge', 'merging', 'merge-rebasing'];

/** Every code the table covers. Exported so a test can assert completeness
 *  against the HoldCode union. */
export const ALL_HOLD_CODES: readonly HoldCode[] = [...TIER_1, ...TIER_2, ...TIER_3];

const TIER_BY_CODE = new Map<string, Tier>([
  ...TIER_1.map((c) => [c, 1] as const),
  ...TIER_2.map((c) => [c, 2] as const),
  ...TIER_3.map((c) => [c, 3] as const),
]);

/** Tier for a hold code. Anything unrecognised is tier 1 — see the header. */
export function tierOf(code: string): Tier {
  return TIER_BY_CODE.get(code) ?? 1;
}
