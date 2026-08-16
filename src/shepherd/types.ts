// ─────────────────────────────────────────────────────────────────────────
// The subset of Shepherd's domain this extension depends on.
//
// Mirrored from erwins-enkel/shepherd, src/types.ts, commit
// 2e2fd0888be517e9381adc591784a414fb5bbbf2. A Session there carries 60+
// fields; six of them are enough to render a row, and narrowing here means a
// field we never read cannot break us when it changes.
// ─────────────────────────────────────────────────────────────────────────

/** Every hold code Shepherd defines today. The wire may carry one we do not
 *  know yet — see RawHold. */
export type HoldCode =
  | 'halted-error'
  | 'halted-usage'
  | 'autopilot-paused'
  | 'blocked-menu'
  | 'blocked-yes-no'
  | 'blocked-awaiting-input'
  | 'blocked-stall'
  | 'blocked-generic'
  | 'quota-rework'
  | 'quota-review'
  | 'quota-error'
  | 'quota-plan'
  | 'plan-rework'
  | 'plan-question'
  | 'critic-rework'
  | 'ci-red'
  | 'pr-conflict'
  | 'awaiting-merge'
  | 'train-error'
  | 'stalled'
  | 'recap-attention'
  | 'merging'
  | 'merge-rebasing'
  | 'ready-merge'
  | 'manual-steps';

/** Display params interpolated into a hold line. All optional; each code uses
 *  the subset it needs. `question` is verbatim agent text. */
export interface HoldParams {
  round?: number;
  cap?: number;
  findings?: number;
  resetAt?: number;
  pr?: number;
  rebaseCount?: number;
  question?: string;
  steps?: number;
}

/** A hold as it arrives on the wire. `code` is deliberately `string`, not
 *  `HoldCode`: Shepherd can add a code any time, and the whole point of the
 *  tier-1 fallback is that such a session still shows up. */
export interface RawHold {
  code: string;
  params?: HoldParams;
}

export type SessionStatus = 'running' | 'idle' | 'blocked' | 'done' | 'archived';

/** `GET /api/sessions` never returns archived rows — the server filters them —
 *  so no archive handling is needed downstream. */
export interface Session {
  id: string;
  /** Human-facing designation, e.g. `TASK-42`. */
  desig: string;
  name: string;
  repoPath: string;
  status: SessionStatus;
  updatedAt: number;
}

/** `GET /api/holds` — an object keyed by session id. A session absent from it
 *  is simply un-held. */
export type HoldsResponse = Record<string, RawHold>;
