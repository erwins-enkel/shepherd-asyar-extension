// ─────────────────────────────────────────────────────────────────────────
// Join sessions with holds, classify into three sections, sort each.
//
// The classification order is the load-bearing part: HOLD FIRST, STATUS
// SECOND. In the reference snapshot (2026-08-16) 9 of the 12 sessions waiting
// on the operator had status "done" — an agent that finished its turn and an
// agent that needs an answer are the same thing more often than not. Reading
// status first would file those 9 under "Done" and hide them.
// ─────────────────────────────────────────────────────────────────────────
import type { HoldsResponse, Session, SessionStatus } from './types';
import { tierOf, type Tier } from './tiers';
import { renderHold, type HoldLanguage } from './copy';

export interface PanelRow {
  id: string;
  desig: string;
  name: string;
  /** Repo directory name — the full path is noise in a list. */
  repo: string;
  status: SessionStatus;
  updatedAt: number;
  /** Null when the session carries no hold. */
  tier: Tier | null;
  /** Rendered hold line; null when the session carries no hold. */
  reason: string | null;
}

export interface PanelModel {
  needsYou: PanelRow[];
  active: PanelRow[];
  done: PanelRow[];
}

/** Last segment of a repo path, trailing slashes ignored. Returns the input
 *  unchanged when there is no segment to take. */
export function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, '');
  const segment = trimmed.split('/').pop();
  return segment && segment.length > 0 ? segment : repoPath;
}

/**
 * Join sessions with their holds and classify each into one of three panel
 * sections. Precedence is hold before status: a tier-1/2 hold always lands a
 * row in `needsYou` and a tier-3 hold always lands it in `active`, regardless
 * of `status`; only an unheld session is classified by `status` (`done` vs.
 * everything else, which falls into `active`).
 */
export function buildPanel(
  sessions: Session[],
  holds: HoldsResponse,
  lang: HoldLanguage,
): PanelModel {
  const needsYou: PanelRow[] = [];
  const active: PanelRow[] = [];
  const done: PanelRow[] = [];

  // A Map has no prototype chain to fall through to, so a session id that
  // collides with an Object.prototype member (e.g. `toString`, `__proto__`,
  // `constructor`) still misses cleanly instead of resolving to an inherited
  // value — mirrors the lookup pattern in tiers.ts and copy.ts.
  const holdById = new Map(Object.entries(holds));

  for (const s of sessions) {
    const hold = holdById.get(s.id);
    const tier = hold ? tierOf(hold.code) : null;
    const row: PanelRow = {
      id: s.id,
      desig: s.desig,
      name: s.name,
      repo: repoBasename(s.repoPath),
      status: s.status,
      updatedAt: s.updatedAt,
      tier,
      reason: hold ? renderHold(hold.code, hold.params, lang) : null,
    };

    if (tier === 1 || tier === 2) needsYou.push(row);
    else if (tier === 3) active.push(row);
    else if (s.status === 'done') done.push(row);
    else active.push(row);
  }

  // Most urgent first; within a tier, the longest wait first. Every row here
  // was pushed because its tier is 1 or 2 (see the classification above), so
  // `tier` is never null at this point; the `?? 1` is belt-and-braces, not
  // reachable.
  needsYou.sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1) || a.updatedAt - b.updatedAt);
  active.sort((a, b) => b.updatedAt - a.updatedAt);
  done.sort((a, b) => b.updatedAt - a.updatedAt);

  return { needsYou, active, done };
}
