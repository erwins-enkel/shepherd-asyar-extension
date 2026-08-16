# Shepherd Sessions Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Asyar panel that shows, on one keystroke, which Shepherd sessions are waiting on the operator — and opens the chosen one in the HUD.

**Architecture:** A pure layer (types, tier mapping, hold copy, view model) with no SDK or DOM dependency, unit-tested in plain Node; one impure client module that is the only place that knows Shepherd is an HTTP service; one Svelte component that renders three sections and opens a deep link.

**Tech Stack:** TypeScript 5 (strict), Svelte 5 (runes), Vite 6, Vitest, `asyar-sdk` 4.6.0.

**Design spec:** `docs/superpowers/specs/2026-08-16-sessions-panel-design.md`

## Global Constraints

- **Language of artifacts:** English. Code, comments, docs, commit messages. (Conversation with the operator is German; that does not apply to files.)
- **Imports in the pure layer:** `src/shepherd/*.ts` may import from `asyar-sdk/contracts` only — never `asyar-sdk/view` or `asyar-sdk/worker`. Both of those assert `window.__ASYAR_ROLE__` at module load and would break the Node test run and, if hoisted into the shared chunk, the worker iframe.
- **No `window.fetch` / `XMLHttpRequest`.** The extension iframe's CSP is `default-src asyar-extension: 'self'`. All network goes through `INetworkService`.
- **`net.fetch` contract:** returns `{ ok, status, statusText, headers, body }` where `body` is a **string** — there is no `.json()`. A non-2xx **resolves** with `ok: false`; only transport failures reject, and their message is replaced with a generic `'fetch_url failed'`. Always pass an explicit `timeout`.
- **Hold before status.** A session's section is decided by its hold first and its status only afterwards. 9 of 12 waiting sessions in the reference snapshot had status `done`. Never invert this.
- **Unknown hold codes degrade, never disappear:** unknown → tier 1 + generic copy.
- **Do not commit secrets.** The operator's token and the real core URL stay out of the repo; `manifest.json` keeps the placeholder `https://host.example.ts.net:1234`.
- **Manifest strictness:** the launcher parses `ExtensionManifest`, `ExtensionCommand` and `BackgroundSpec` with `#[serde(deny_unknown_fields)]` — one stray key breaks discovery with no warning from `asyar validate`. `preferences[]` entries are *not* strict.
- **Verification commands** that must pass before any commit that touches `src/`: `npx tsc --noEmit`, `npx vitest run`, `npx vite build`, `npx asyar validate`.

---

### Task 1: Test infrastructure, Shepherd types, and the tier map

**Files:**
- Create: `vitest.config.ts`
- Create: `src/shepherd/types.ts`
- Create: `src/shepherd/tiers.ts`
- Create: `src/shepherd/tiers.test.ts`
- Modify: `package.json` (add the `test` script and the `vitest` devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces: `HoldCode`, `HoldParams`, `RawHold`, `SessionStatus`, `Session`, `HoldsResponse` from `./types`; `Tier`, `ALL_HOLD_CODES`, `tierOf(code: string): Tier` from `./tiers`.

- [ ] **Step 1: Add Vitest**

```bash
npm install --save-dev --save-exact vitest@3.2.4
```

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"` (keep the existing three):

```json
    "test": "vitest run"
```

- [ ] **Step 3: Create `vitest.config.ts`**

A config of its own, not a `test` block in `vite.config.ts` — the build config has a dual HTML entry and the Svelte plugin, neither of which the pure-layer tests need.

```ts
import { defineConfig } from 'vitest/config';

// The pure layer imports nothing from the DOM, so `node` is the honest
// environment: if a test needs jsdom, that module is not pure any more.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `src/shepherd/types.ts`**

```ts
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
  desig: string;
  name: string;
  repoPath: string;
  status: SessionStatus;
  updatedAt: number;
}

/** `GET /api/holds` — an object keyed by session id. A session absent from it
 *  is simply un-held. */
export type HoldsResponse = Record<string, RawHold>;
```

- [ ] **Step 5: Write the failing test**

Create `src/shepherd/tiers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ALL_HOLD_CODES, tierOf } from './tiers';

describe('tierOf', () => {
  it('puts blocking codes in tier 1', () => {
    expect(tierOf('blocked-menu')).toBe(1);
    expect(tierOf('autopilot-paused')).toBe(1);
    expect(tierOf('quota-rework')).toBe(1);
    expect(tierOf('critic-rework')).toBe(1);
    expect(tierOf('manual-steps')).toBe(1);
  });

  it('puts needs-a-look-soon codes in tier 2', () => {
    expect(tierOf('recap-attention')).toBe(2);
    expect(tierOf('halted-usage')).toBe(2);
    expect(tierOf('awaiting-merge')).toBe(2);
    expect(tierOf('stalled')).toBe(2);
    expect(tierOf('train-error')).toBe(2);
  });

  it('puts routine in-flight codes in tier 3', () => {
    expect(tierOf('ready-merge')).toBe(3);
    expect(tierOf('merging')).toBe(3);
    expect(tierOf('merge-rebasing')).toBe(3);
  });

  it('assigns a tier to every known code', () => {
    for (const code of ALL_HOLD_CODES) {
      expect([1, 2, 3]).toContain(tierOf(code));
    }
  });

  it('lists all 25 known codes exactly once', () => {
    expect(ALL_HOLD_CODES).toHaveLength(25);
    expect(new Set(ALL_HOLD_CODES).size).toBe(25);
  });

  // The tier table is this extension's own invention — Shepherd has no
  // HOLD_TIER map to mirror. So an unknown code is not hypothetical, it is
  // what every future Shepherd release looks like on day one.
  it('degrades an unknown code to tier 1 rather than dropping it', () => {
    expect(tierOf('some-code-shepherd-adds-in-2027')).toBe(1);
    expect(tierOf('')).toBe(1);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/shepherd/tiers.test.ts`
Expected: FAIL — `Failed to resolve import "./tiers"`.

- [ ] **Step 7: Create `src/shepherd/tiers.ts`**

```ts
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
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/shepherd/tiers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 9: Verify the toolchain is still clean**

Run: `npx tsc --noEmit && npx asyar validate`
Expected: exit 0 from both; `asyar validate` prints "All checks passed".

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/shepherd/types.ts src/shepherd/tiers.ts src/shepherd/tiers.test.ts
git commit -m "feat(pure): hold-code tier mapping with unknown-code fallback"
```

---

### Task 2: Hold copy, lifted from Shepherd

**Files:**
- Create: `src/shepherd/copy.ts`
- Create: `src/shepherd/copy.test.ts`

**Interfaces:**
- Consumes: `HoldCode`, `HoldParams` from `./types`; `ALL_HOLD_CODES` from `./tiers`.
- Produces: `HoldLanguage` (`'en' | 'de'`), `resolveLanguage(pref: string | undefined, navigatorLanguage: string | undefined): HoldLanguage`, `renderHold(code: string, params: HoldParams | undefined, lang: HoldLanguage): string`.

- [ ] **Step 1: Write the failing test**

Create `src/shepherd/copy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ALL_HOLD_CODES } from './tiers';
import { renderHold, resolveLanguage } from './copy';

describe('renderHold', () => {
  it('renders every known code in both languages, non-empty', () => {
    for (const code of ALL_HOLD_CODES) {
      expect(renderHold(code, {}, 'en').length).toBeGreaterThan(0);
      expect(renderHold(code, {}, 'de').length).toBeGreaterThan(0);
    }
  });

  it('interpolates params when present', () => {
    expect(renderHold('ci-red', { pr: 118 }, 'en')).toBe(
      'CI is failing on PR #118 — needs a fix.',
    );
    expect(renderHold('critic-rework', { findings: 3 }, 'en')).toBe(
      'Critic requested changes (3 open) — steered back to the agent.',
    );
    expect(renderHold('plan-rework', { round: 2, cap: 3 }, 'en')).toBe(
      'Plan review wants changes (round 2/3) — your call.',
    );
  });

  it('falls back inside a line when a param is missing', () => {
    expect(renderHold('ci-red', {}, 'en')).toBe('CI is failing — needs a fix.');
    expect(renderHold('critic-rework', {}, 'en')).toBe(
      'Critic requested changes — steered back to the agent.',
    );
    expect(renderHold('plan-rework', {}, 'en')).toBe(
      'Plan review wants changes (round ?/?) — your call.',
    );
  });

  it('pluralises manual steps in both languages', () => {
    expect(renderHold('manual-steps', { steps: 1 }, 'en')).toContain('1 manual step ');
    expect(renderHold('manual-steps', { steps: 2 }, 'en')).toContain('2 manual steps ');
    expect(renderHold('manual-steps', { steps: 1 }, 'de')).toContain('1 manueller Schritt ');
    expect(renderHold('manual-steps', { steps: 2 }, 'de')).toContain('2 manuelle Schritte ');
  });

  it('uses the agent question verbatim for autopilot-paused, else a default', () => {
    expect(renderHold('autopilot-paused', { question: 'Ship it?' }, 'en')).toBe('Ship it?');
    expect(renderHold('autopilot-paused', { question: '   ' }, 'en')).toBe(
      'Autopilot paused for your input.',
    );
    expect(renderHold('autopilot-paused', {}, 'de')).toBe('Autopilot pausiert für deine Eingabe.');
  });

  it('renders German for a German language', () => {
    expect(renderHold('blocked-menu', {}, 'de')).toBe('Wartet auf eine Menüauswahl.');
  });

  // Shepherd's own renderHold() THROWS on an unknown code (bare map lookup,
  // then call). Ours must not: an unrecognised hold still means someone is
  // waiting.
  it('returns generic copy for an unknown code instead of throwing', () => {
    expect(() => renderHold('brand-new-code', {}, 'en')).not.toThrow();
    expect(renderHold('brand-new-code', {}, 'en')).toBe('Needs you.');
    expect(renderHold('brand-new-code', {}, 'de')).toBe('Braucht dich.');
  });

  it('does not interpolate undefined into a missing-param line', () => {
    for (const code of ALL_HOLD_CODES) {
      expect(renderHold(code, {}, 'en')).not.toContain('undefined');
      expect(renderHold(code, {}, 'de')).not.toContain('undefined');
    }
  });
});

describe('resolveLanguage', () => {
  it('honours an explicit preference', () => {
    expect(resolveLanguage('de', 'en-US')).toBe('de');
    expect(resolveLanguage('en', 'de-DE')).toBe('en');
  });

  it('follows the platform language when set to auto', () => {
    expect(resolveLanguage('auto', 'de-DE')).toBe('de');
    expect(resolveLanguage('auto', 'de')).toBe('de');
    expect(resolveLanguage('auto', 'en-GB')).toBe('en');
  });

  it('defaults to English when nothing is known', () => {
    expect(resolveLanguage(undefined, undefined)).toBe('en');
    expect(resolveLanguage('auto', undefined)).toBe('en');
    expect(resolveLanguage('nonsense', 'de-DE')).toBe('de');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shepherd/copy.test.ts`
Expected: FAIL — `Failed to resolve import "./copy"`.

- [ ] **Step 3: Create `src/shepherd/copy.ts`**

The two maps are copied **verbatim** from upstream. Do not reword them — matching the HUD's wording exactly is the point.

```ts
// ─────────────────────────────────────────────────────────────────────────
// Hold copy.
//
// The EN and DE maps below are copied VERBATIM from erwins-enkel/shepherd,
// src/hold.ts, commit 2e2fd0888be517e9381adc591784a414fb5bbbf2. Do not
// reword them: matching the HUD line-for-line is the whole point, so that a
// reason read here and the same reason read there are the same sentence.
//
// One deliberate difference from upstream: renderHold() there does a bare
// `map[hold.code]` lookup and calls the result, so an unknown code THROWS.
// Here it degrades to generic copy — a hold code we do not recognise still
// means a session is waiting.
// ─────────────────────────────────────────────────────────────────────────
import type { HoldCode, HoldParams } from './types';

export type HoldLanguage = 'en' | 'de';

/** Locale-formatted clock time of a usage-window reset. */
function resetTimeLabel(resetAt: number | undefined, locale: HoldLanguage): string | null {
  if (resetAt === undefined) return null;
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(resetAt));
}

type CopyMap = Record<HoldCode, (params: HoldParams, locale: HoldLanguage) => string>;

const EN: CopyMap = {
  'halted-error': () => 'Halted on an error — needs you.',
  'halted-usage': (p, locale) => {
    const time = resetTimeLabel(p.resetAt, locale);
    return time ? `Paused at the usage limit — resumes at ${time}.` : 'Paused at the usage limit.';
  },
  'autopilot-paused': (p) =>
    p.question && p.question.trim() ? p.question : 'Autopilot paused for your input.',
  'blocked-menu': () => 'Waiting on a menu choice.',
  'blocked-yes-no': () => 'Waiting on a yes/no.',
  'blocked-awaiting-input': () => 'Waiting on your input.',
  'blocked-stall': () => 'Quiet — no recent activity; may be stuck.',
  'blocked-generic': () => 'Waiting on your input.',
  'quota-rework': () => 'Auto-fix hit its limit — open findings still need you.',
  'quota-review': () => 'Critic keeps finding issues — auto-review paused.',
  'quota-error': () => "Critic can't review this PR — needs you.",
  'quota-plan': () => 'Plan review stuck — keeps requesting changes.',
  'plan-rework': (p) =>
    `Plan review wants changes (round ${p.round ?? '?'}/${p.cap ?? '?'}) — your call.`,
  'plan-question': () => 'The plan has questions waiting on your answer.',
  'critic-rework': (p) =>
    p.findings !== undefined
      ? `Critic requested changes (${p.findings} open) — steered back to the agent.`
      : 'Critic requested changes — steered back to the agent.',
  'ci-red': (p) => `CI is failing${p.pr !== undefined ? ` on PR #${p.pr}` : ''} — needs a fix.`,
  'pr-conflict': (p) =>
    `${p.pr !== undefined ? `PR #${p.pr} has` : 'The PR has'} merge conflicts — CI can't run until it's rebased.`,
  'awaiting-merge': (p) =>
    `Ready and handed to a merger${p.pr !== undefined ? ` (PR #${p.pr})` : ''}.`,
  'train-error': (p) =>
    `Merge train hit an error${p.pr !== undefined ? ` on PR #${p.pr}` : ''} — needs you.`,
  stalled: () => 'Quiet — no recent activity; may be stuck.',
  'recap-attention': () => 'Recap flagged this for your attention.',
  merging: (p) => `In the merge train${p.pr !== undefined ? ` (PR #${p.pr})` : ''}.`,
  'merge-rebasing': (p) => `Rebasing in the merge train (attempt ${p.rebaseCount ?? '?'}).`,
  'ready-merge': (p) =>
    `Ready to merge${p.pr !== undefined ? ` (PR #${p.pr})` : ''} — waiting on you.`,
  'manual-steps': (p) =>
    `${p.steps ?? 1} manual step${(p.steps ?? 1) === 1 ? '' : 's'} to do before merge — ack to proceed.`,
};

const DE: CopyMap = {
  'halted-error': () => 'Auf einem Fehler gestoppt — braucht dich.',
  'halted-usage': (p, locale) => {
    const time = resetTimeLabel(p.resetAt, locale);
    return time
      ? `Am Nutzungslimit pausiert — wird um ${time} fortgesetzt.`
      : 'Am Nutzungslimit pausiert.';
  },
  'autopilot-paused': (p) =>
    p.question && p.question.trim() ? p.question : 'Autopilot pausiert für deine Eingabe.',
  'blocked-menu': () => 'Wartet auf eine Menüauswahl.',
  'blocked-yes-no': () => 'Wartet auf ein Ja/Nein.',
  'blocked-awaiting-input': () => 'Wartet auf deine Eingabe.',
  'blocked-stall': () => 'Ruhig — keine Aktivität; möglicherweise hängengeblieben.',
  'blocked-generic': () => 'Wartet auf deine Eingabe.',
  'quota-rework': () => 'Auto-Fix am Limit — offene Punkte brauchen dich.',
  'quota-review': () => 'Kritiker findet weiter Probleme — Auto-Review pausiert.',
  'quota-error': () => 'Kritiker kann den PR nicht prüfen — braucht dich.',
  'quota-plan': () => 'Plan-Review hängt — fordert weiter Änderungen.',
  'plan-rework': (p) =>
    `Plan-Review fordert Änderungen (Runde ${p.round ?? '?'}/${p.cap ?? '?'}) — deine Entscheidung.`,
  'plan-question': () => 'Der Plan hat Fragen, die auf deine Antwort warten.',
  'critic-rework': (p) =>
    p.findings !== undefined
      ? `Kritiker fordert Änderungen (${p.findings} offen) — zurück zum Agenten gesteuert.`
      : 'Kritiker fordert Änderungen — zurück zum Agenten gesteuert.',
  'ci-red': (p) =>
    `CI schlägt fehl${p.pr !== undefined ? ` bei PR #${p.pr}` : ''} — braucht eine Korrektur.`,
  'pr-conflict': (p) =>
    `${p.pr !== undefined ? `PR #${p.pr} hat` : 'Der PR hat'} Merge-Konflikte — CI kann bis zum Rebase nicht laufen.`,
  'awaiting-merge': (p) =>
    `Bereit und an einen Merger übergeben${p.pr !== undefined ? ` (PR #${p.pr})` : ''}.`,
  'train-error': (p) =>
    `Merge-Train hat einen Fehler${p.pr !== undefined ? ` bei PR #${p.pr}` : ''} — braucht dich.`,
  stalled: () => 'Ruhig — keine Aktivität; möglicherweise hängengeblieben.',
  'recap-attention': () => 'Recap hat dies für deine Aufmerksamkeit markiert.',
  merging: (p) => `Im Merge-Train${p.pr !== undefined ? ` (PR #${p.pr})` : ''}.`,
  'merge-rebasing': (p) => `Rebase im Merge-Train (Versuch ${p.rebaseCount ?? '?'}).`,
  'ready-merge': (p) =>
    `Bereit zum Mergen${p.pr !== undefined ? ` (PR #${p.pr})` : ''} — wartet auf dich.`,
  'manual-steps': (p) =>
    `${p.steps ?? 1} manuelle${(p.steps ?? 1) === 1 ? 'r' : ''} Schritt${(p.steps ?? 1) === 1 ? '' : 'e'} vor dem Mergen — bestätigen zum Fortfahren.`,
};

const UNKNOWN: Record<HoldLanguage, string> = {
  en: 'Needs you.',
  de: 'Braucht dich.',
};

/**
 * Render a hold reason. `code` is `string`, not `HoldCode`, because the wire
 * can carry a code newer than this file.
 */
export function renderHold(
  code: string,
  params: HoldParams | undefined,
  lang: HoldLanguage,
): string {
  const map = lang === 'de' ? DE : EN;
  const fn = (map as Record<string, CopyMap[HoldCode] | undefined>)[code];
  if (!fn) return UNKNOWN[lang];
  return fn(params ?? {}, lang);
}

/**
 * Resolve the language to render in.
 *
 * Asyar has no locale surface — neither `asyar-sdk` nor the launcher contains
 * any i18n code, and nothing passes a language to an extension. So `auto`
 * reads `navigator.language` from the view's webview, which inherits the OS
 * locale, and the explicit values are the escape hatch when that is wrong.
 */
export function resolveLanguage(
  pref: string | undefined,
  navigatorLanguage: string | undefined,
): HoldLanguage {
  if (pref === 'de') return 'de';
  if (pref === 'en') return 'en';
  return navigatorLanguage?.toLowerCase().startsWith('de') ? 'de' : 'en';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shepherd/copy.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Verify types**

Run: `npx tsc --noEmit`
Expected: exit 0. (`CopyMap` is a `Record<HoldCode, …>`, so a missing or misspelled code is a compile error — that is the check that both maps stay complete.)

- [ ] **Step 6: Commit**

```bash
git add src/shepherd/copy.ts src/shepherd/copy.test.ts
git commit -m "feat(pure): hold copy lifted verbatim from Shepherd, EN + DE"
```

---

### Task 3: View model — join, classify, sort

**Files:**
- Create: `src/shepherd/view-model.ts`
- Create: `src/shepherd/view-model.test.ts`

**Interfaces:**
- Consumes: `Session`, `HoldsResponse`, `SessionStatus` from `./types`; `Tier`, `tierOf` from `./tiers`; `HoldLanguage`, `renderHold` from `./copy`.
- Produces: `PanelRow`, `PanelModel`, `repoBasename(repoPath: string): string`, `buildPanel(sessions: Session[], holds: HoldsResponse, lang: HoldLanguage): PanelModel`.

- [ ] **Step 1: Write the failing test**

Create `src/shepherd/view-model.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Session, HoldsResponse, SessionStatus } from './types';
import { buildPanel, repoBasename } from './view-model';

function session(over: Partial<Session> & { id: string }): Session {
  return {
    desig: 'TASK-1',
    name: 'a session',
    repoPath: '/home/moe/projects/demo',
    status: 'running' as SessionStatus,
    updatedAt: 1_000,
    ...over,
  };
}

describe('repoBasename', () => {
  it('takes the last path segment', () => {
    expect(repoBasename('/home/moe/projects/shepherd')).toBe('shepherd');
  });

  it('ignores trailing slashes', () => {
    expect(repoBasename('/home/moe/projects/shepherd/')).toBe('shepherd');
  });

  it('falls back to the input when there is no segment', () => {
    expect(repoBasename('')).toBe('');
    expect(repoBasename('/')).toBe('/');
  });
});

describe('buildPanel', () => {
  // The rule that matters most: in the reference snapshot 9 of the 12 waiting
  // sessions had status "done". Classifying by status first would hide them.
  it('puts a done session with a tier-1 hold in needsYou, not done', () => {
    const sessions = [session({ id: 's1', status: 'done' })];
    const holds: HoldsResponse = { s1: { code: 'blocked-menu' } };

    const panel = buildPanel(sessions, holds, 'en');

    expect(panel.needsYou.map((r) => r.id)).toEqual(['s1']);
    expect(panel.done).toEqual([]);
    expect(panel.active).toEqual([]);
  });

  it('puts a tier-3 hold in active even when the session is done', () => {
    const sessions = [session({ id: 's1', status: 'done' })];
    const holds: HoldsResponse = { s1: { code: 'ready-merge', params: { pr: 9 } } };

    const panel = buildPanel(sessions, holds, 'en');

    expect(panel.active.map((r) => r.id)).toEqual(['s1']);
    expect(panel.active[0].reason).toBe('Ready to merge (PR #9) — waiting on you.');
    expect(panel.done).toEqual([]);
  });

  it('puts an unheld done session in done', () => {
    const panel = buildPanel([session({ id: 's1', status: 'done' })], {}, 'en');

    expect(panel.done.map((r) => r.id)).toEqual(['s1']);
    expect(panel.needsYou).toEqual([]);
  });

  it('puts an unheld running session in active with no reason', () => {
    const panel = buildPanel([session({ id: 's1', status: 'running' })], {}, 'en');

    expect(panel.active.map((r) => r.id)).toEqual(['s1']);
    expect(panel.active[0].reason).toBeNull();
    expect(panel.active[0].tier).toBeNull();
  });

  it('orders needsYou by tier, then oldest wait first', () => {
    const sessions = [
      session({ id: 'tier2-old', updatedAt: 100 }),
      session({ id: 'tier1-new', updatedAt: 900 }),
      session({ id: 'tier1-old', updatedAt: 200 }),
    ];
    const holds: HoldsResponse = {
      'tier2-old': { code: 'recap-attention' },
      'tier1-new': { code: 'blocked-menu' },
      'tier1-old': { code: 'ci-red' },
    };

    const panel = buildPanel(sessions, holds, 'en');

    expect(panel.needsYou.map((r) => r.id)).toEqual(['tier1-old', 'tier1-new', 'tier2-old']);
  });

  it('orders active and done newest first', () => {
    const sessions = [
      session({ id: 'old', status: 'running', updatedAt: 100 }),
      session({ id: 'new', status: 'running', updatedAt: 900 }),
      session({ id: 'done-old', status: 'done', updatedAt: 100 }),
      session({ id: 'done-new', status: 'done', updatedAt: 900 }),
    ];

    const panel = buildPanel(sessions, {}, 'en');

    expect(panel.active.map((r) => r.id)).toEqual(['new', 'old']);
    expect(panel.done.map((r) => r.id)).toEqual(['done-new', 'done-old']);
  });

  it('surfaces an unknown hold code in needsYou with generic copy', () => {
    const sessions = [session({ id: 's1', status: 'done' })];
    const holds: HoldsResponse = { s1: { code: 'invented-tomorrow' } };

    const panel = buildPanel(sessions, holds, 'en');

    expect(panel.needsYou.map((r) => r.id)).toEqual(['s1']);
    expect(panel.needsYou[0].tier).toBe(1);
    expect(panel.needsYou[0].reason).toBe('Needs you.');
  });

  it('ignores holds for sessions that are not in the list', () => {
    const panel = buildPanel([session({ id: 's1' })], { ghost: { code: 'ci-red' } }, 'en');

    expect(panel.needsYou).toEqual([]);
    expect(panel.active.map((r) => r.id)).toEqual(['s1']);
  });

  it('exposes the repo basename and renders in the requested language', () => {
    const sessions = [session({ id: 's1', repoPath: '/home/moe/projects/shepherd' })];
    const holds: HoldsResponse = { s1: { code: 'blocked-menu' } };

    const panel = buildPanel(sessions, holds, 'de');

    expect(panel.needsYou[0].repo).toBe('shepherd');
    expect(panel.needsYou[0].reason).toBe('Wartet auf eine Menüauswahl.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shepherd/view-model.test.ts`
Expected: FAIL — `Failed to resolve import "./view-model"`.

- [ ] **Step 3: Create `src/shepherd/view-model.ts`**

```ts
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
  // value.
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

  // Most urgent first; within a tier, the longest wait first.
  needsYou.sort((a, b) => (a.tier ?? 1) - (b.tier ?? 1) || a.updatedAt - b.updatedAt);
  active.sort((a, b) => b.updatedAt - a.updatedAt);
  done.sort((a, b) => b.updatedAt - a.updatedAt);

  return { needsYou, active, done };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shepherd/view-model.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/shepherd/view-model.ts src/shepherd/view-model.test.ts
git commit -m "feat(pure): three-section view model, hold before status"
```

---

### Task 4: Shepherd client

**Files:**
- Create: `src/shepherd/client.ts`
- Create: `src/shepherd/client.test.ts`

**Interfaces:**
- Consumes: `Session`, `HoldsResponse` from `./types`; `INetworkService`, `NetworkResponse`, `RequestOptions` types from `asyar-sdk/contracts`.
- Produces: `FetchOutcome`, `normalizeBaseUrl(baseUrl: string): string`, `sessionUrl(baseUrl: string, sessionId: string): string`, `fetchPanelData(net: INetworkService, baseUrl: string, token: string | undefined): Promise<FetchOutcome>`.

- [ ] **Step 1: Write the failing test**

Create `src/shepherd/client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { INetworkService, NetworkResponse, RequestOptions } from 'asyar-sdk/contracts';
import { fetchPanelData, normalizeBaseUrl, sessionUrl } from './client';

const BASE = 'https://core.example.ts.net:7330';

function ok(body: unknown): NetworkResponse {
  return { ok: true, status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(body) };
}

function status(code: number): NetworkResponse {
  return { ok: false, status: code, statusText: 'nope', headers: {}, body: '{"error":"nope"}' };
}

/** Records every call so the test can assert on headers and timeout. */
class FakeNet implements INetworkService {
  calls: Array<{ url: string; options?: RequestOptions }> = [];
  constructor(private readonly reply: (url: string) => Promise<NetworkResponse>) {}
  async fetch(url: string, options?: RequestOptions): Promise<NetworkResponse> {
    this.calls.push({ url, options });
    return this.reply(url);
  }
}

const SESSIONS = [
  {
    id: 's1',
    desig: 'TASK-1',
    name: 'a session',
    repoPath: '/repos/demo',
    status: 'done',
    updatedAt: 5,
  },
];
const HOLDS = { s1: { code: 'blocked-menu' } };

function bothOk(): FakeNet {
  return new FakeNet(async (url) => (url.includes('/api/holds') ? ok(HOLDS) : ok(SESSIONS)));
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://x.ts.net:7330/')).toBe('https://x.ts.net:7330');
    expect(normalizeBaseUrl('https://x.ts.net:7330///')).toBe('https://x.ts.net:7330');
    expect(normalizeBaseUrl('  https://x.ts.net:7330  ')).toBe('https://x.ts.net:7330');
  });
});

describe('sessionUrl', () => {
  it('builds the HUD deep link', () => {
    expect(sessionUrl(BASE, 'abc')).toBe(`${BASE}/?session=abc`);
  });

  it('is unaffected by a trailing slash on the base url', () => {
    expect(sessionUrl(`${BASE}/`, 'abc')).toBe(`${BASE}/?session=abc`);
  });

  it('encodes the session id', () => {
    expect(sessionUrl(BASE, 'a b&c')).toBe(`${BASE}/?session=a%20b%26c`);
  });
});

describe('fetchPanelData', () => {
  it('returns both payloads on success', async () => {
    const net = bothOk();

    const outcome = await fetchPanelData(net, BASE, 'shp_token');

    expect(outcome).toEqual({ kind: 'ok', sessions: SESSIONS, holds: HOLDS });
  });

  it('requests both endpoints with the bearer token and an explicit timeout', async () => {
    const net = bothOk();

    await fetchPanelData(net, BASE, 'shp_token');

    expect(net.calls.map((c) => c.url).sort()).toEqual([
      `${BASE}/api/holds`,
      `${BASE}/api/sessions`,
    ]);
    for (const call of net.calls) {
      expect(call.options?.headers?.Authorization).toBe('Bearer shp_token');
      expect(call.options?.timeout).toBeGreaterThan(0);
    }
  });

  it('omits the Authorization header when no token is configured', async () => {
    const net = bothOk();

    await fetchPanelData(net, BASE, undefined);

    for (const call of net.calls) {
      expect(call.options?.headers?.Authorization).toBeUndefined();
    }
  });

  it('reports unconfigured for an empty base url', async () => {
    const net = bothOk();

    expect(await fetchPanelData(net, '', 'shp_token')).toEqual({ kind: 'unconfigured' });
    expect(await fetchPanelData(net, '   ', 'shp_token')).toEqual({ kind: 'unconfigured' });
    expect(net.calls).toHaveLength(0);
  });

  // net.fetch REJECTS only on transport failure, and the Rust error text is
  // replaced with a generic 'fetch_url failed' — so a rejection is not a
  // diagnosis, and the message must name the URL instead.
  it('reports unreachable when the fetch rejects', async () => {
    const net = new FakeNet(async () => {
      throw new Error('fetch_url failed');
    });

    expect(await fetchPanelData(net, BASE, 'shp_token')).toEqual({
      kind: 'unreachable',
      baseUrl: BASE,
    });
  });

  // A non-2xx RESOLVES with ok:false. Forgetting to check `ok` is the easy bug
  // here, so these two cases are not optional.
  it('reports unauthorized on 401', async () => {
    const net = new FakeNet(async () => status(401));

    expect(await fetchPanelData(net, BASE, 'bad')).toEqual({
      kind: 'unauthorized',
      baseUrl: BASE,
    });
  });

  it('reports an http error on any other non-2xx', async () => {
    const net = new FakeNet(async () => status(503));

    expect(await fetchPanelData(net, BASE, 'shp_token')).toEqual({
      kind: 'http-error',
      baseUrl: BASE,
      status: 503,
    });
  });

  it('reports unauthorized when only one of the two calls is 401', async () => {
    const net = new FakeNet(async (url) =>
      url.includes('/api/holds') ? status(401) : ok(SESSIONS),
    );

    expect(await fetchPanelData(net, BASE, 'bad')).toEqual({
      kind: 'unauthorized',
      baseUrl: BASE,
    });
  });

  it('reports malformed on unparseable json', async () => {
    const net = new FakeNet(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {},
      body: 'not json',
    }));

    expect(await fetchPanelData(net, BASE, 'shp_token')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });
  });

  it('reports malformed when the shapes are wrong', async () => {
    const sessionsNotArray = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok(HOLDS) : ok({ nope: true }),
    );
    expect(await fetchPanelData(sessionsNotArray, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });

    const holdsNotObject = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok([1, 2, 3]) : ok(SESSIONS),
    );
    expect(await fetchPanelData(holdsNotObject, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });
  });

  it('treats an empty core as success, not an error', async () => {
    const net = new FakeNet(async (url) => (url.includes('/api/holds') ? ok({}) : ok([])));

    expect(await fetchPanelData(net, BASE, 't')).toEqual({ kind: 'ok', sessions: [], holds: {} });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shepherd/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 3: Create `src/shepherd/client.ts`**

```ts
// ─────────────────────────────────────────────────────────────────────────
// The only module that knows Shepherd is an HTTP service.
//
// Everything Shepherd-shaped that could change — endpoint paths, auth header,
// response envelopes — lives here, so a breaking change upstream is a
// one-file fix. `/api/holds` in particular is an internal endpoint with no
// stability contract.
//
// Three INetworkService properties shape this file:
//   1. `body` is a STRING. There is no .json().
//   2. A non-2xx RESOLVES with ok:false. Only transport failures reject.
//   3. A rejection's message is replaced with a generic 'fetch_url failed',
//      so it cannot be used as a diagnosis — hence naming the URL instead.
// ─────────────────────────────────────────────────────────────────────────
import type { INetworkService, NetworkResponse } from 'asyar-sdk/contracts';
import type { HoldsResponse, Session } from './types';

/** Every layer disagrees about the default (30000 / 25000+15000 / 20000), so
 *  we pass our own. A panel that has not answered in 10s has failed. */
const TIMEOUT_MS = 10_000;

export type FetchOutcome =
  | { kind: 'ok'; sessions: Session[]; holds: HoldsResponse }
  | { kind: 'unconfigured' }
  | { kind: 'unreachable'; baseUrl: string }
  | { kind: 'unauthorized'; baseUrl: string }
  | { kind: 'http-error'; baseUrl: string; status: number }
  | { kind: 'malformed'; baseUrl: string };

/** Trim whitespace and trailing slashes so URL building can be naive. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** The HUD selects a session from the `session` query parameter on load. */
export function sessionUrl(baseUrl: string, sessionId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/?session=${encodeURIComponent(sessionId)}`;
}

export async function fetchPanelData(
  net: INetworkService,
  baseUrl: string,
  token: string | undefined,
): Promise<FetchOutcome> {
  const base = normalizeBaseUrl(baseUrl);
  if (base.length === 0) return { kind: 'unconfigured' };

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token && token.trim().length > 0) headers.Authorization = `Bearer ${token.trim()}`;

  let responses: [NetworkResponse, NetworkResponse];
  try {
    responses = await Promise.all([
      net.fetch(`${base}/api/sessions`, { method: 'GET', headers, timeout: TIMEOUT_MS }),
      net.fetch(`${base}/api/holds`, { method: 'GET', headers, timeout: TIMEOUT_MS }),
    ]);
  } catch {
    return { kind: 'unreachable', baseUrl: base };
  }

  // Check every response before parsing any: a non-2xx still carries a body.
  for (const res of responses) {
    if (res.ok) continue;
    if (res.status === 401 || res.status === 403) return { kind: 'unauthorized', baseUrl: base };
    return { kind: 'http-error', baseUrl: base, status: res.status };
  }

  let sessions: unknown;
  let holds: unknown;
  try {
    sessions = JSON.parse(responses[0].body);
    holds = JSON.parse(responses[1].body);
  } catch {
    return { kind: 'malformed', baseUrl: base };
  }

  if (!Array.isArray(sessions)) return { kind: 'malformed', baseUrl: base };
  if (typeof holds !== 'object' || holds === null || Array.isArray(holds)) {
    return { kind: 'malformed', baseUrl: base };
  }

  return {
    kind: 'ok',
    sessions: sessions as Session[],
    holds: holds as HoldsResponse,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shepherd/client.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify the pure layer really is pure**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass under `environment: 'node'` — no jsdom, no `window`. If a test needs a DOM, a module took a dependency it should not have.

- [ ] **Step 6: Commit**

```bash
git add src/shepherd/client.ts src/shepherd/client.test.ts
git commit -m "feat(client): authenticated parallel fetch with classified failures"
```

---

### Task 5: The panel

**Files:**
- Modify: `manifest.json` (add the `holdLanguage` preference)
- Modify: `src/SessionsView.svelte` (replace the scaffold placeholder wholesale)

**Interfaces:**
- Consumes: `fetchPanelData`, `FetchOutcome` from `./shepherd/client`; `buildPanel`, `PanelModel`, `PanelRow` from `./shepherd/view-model`; `resolveLanguage` from `./shepherd/copy`; `ExtensionContext` from `asyar-sdk/contracts`.
- Produces: the rendered panel. Task 6 adds the row action to it.

- [ ] **Step 1: Add the `holdLanguage` preference to `manifest.json`**

Append to the `preferences` array, after `apiToken`. Do **not** touch any other key: the launcher parses the top level with `deny_unknown_fields`.

```json
    {
      "name": "holdLanguage",
      "type": "dropdown",
      "title": "Reason language",
      "description": "Language for the hold reasons. Auto follows your system language, matching the Shepherd HUD.",
      "default": "auto",
      "data": [
        { "title": "Auto", "value": "auto" },
        { "title": "English", "value": "en" },
        { "title": "Deutsch", "value": "de" }
      ]
    }
```

- [ ] **Step 2: Verify the manifest still validates**

Run: `npx asyar validate`
Expected: exit 0, "All checks passed". (The CLI type-checks `default` against the declared `data` values for a dropdown — a typo here fails now rather than at load.)

- [ ] **Step 3: Replace `src/SessionsView.svelte`**

```svelte
<script lang="ts">
  // The triage panel. Three sections, hold before status — see
  // docs/superpowers/specs/2026-08-16-sessions-panel-design.md §7.
  //
  // Data is fetched on open. There is no background poll in this slice, so
  // nothing here is cached and nothing is notified.
  import type { ExtensionContext, INetworkService } from 'asyar-sdk/contracts';
  import { fetchPanelData, type FetchOutcome } from './shepherd/client';
  import { buildPanel, type PanelModel, type PanelRow } from './shepherd/view-model';
  import { resolveLanguage } from './shepherd/copy';

  let { context }: { context: ExtensionContext } = $props();

  let outcome = $state<FetchOutcome | null>(null);
  let panel = $state<PanelModel>({ needsYou: [], active: [], done: [] });
  let doneOpen = $state(false);
  let filter = $state('');

  /** Read a preference, recovering from an empty boot snapshot.
   *
   *  `context.preferences.values` is a synchronous, permission-free read off a
   *  frozen snapshot — but the snapshot can arrive empty. refresh() is IPC and
   *  needs `preferences:read`, which the manifest declares. */
  async function readPreferences(): Promise<{
    baseUrl: string;
    token: string | undefined;
    language: string | undefined;
  }> {
    let values = context.preferences.values as Record<string, unknown>;
    if (typeof values?.apiBaseUrl !== 'string' || values.apiBaseUrl.trim() === '') {
      values = (await context.preferences.refresh()) as unknown as Record<string, unknown>;
    }
    return {
      baseUrl: typeof values?.apiBaseUrl === 'string' ? values.apiBaseUrl : '',
      token: typeof values?.apiToken === 'string' ? values.apiToken : undefined,
      language: typeof values?.holdLanguage === 'string' ? values.holdLanguage : undefined,
    };
  }

  async function load(): Promise<void> {
    const prefs = await readPreferences();
    const net = context.getService<INetworkService>('network');
    const result = await fetchPanelData(net, prefs.baseUrl, prefs.token);
    outcome = result;
    if (result.kind === 'ok') {
      const lang = resolveLanguage(prefs.language, globalThis.navigator?.language);
      panel = buildPanel(result.sessions, result.holds, lang);
    } else {
      panel = { needsYou: [], active: [], done: [] };
    }
  }

  function matches(row: PanelRow, needle: string): boolean {
    if (needle === '') return true;
    const q = needle.toLowerCase();
    return (
      row.desig.toLowerCase().includes(q) ||
      row.name.toLowerCase().includes(q) ||
      row.repo.toLowerCase().includes(q)
    );
  }

  let needsYou = $derived(panel.needsYou.filter((r) => matches(r, filter)));
  let active = $derived(panel.active.filter((r) => matches(r, filter)));
  let done = $derived(panel.done.filter((r) => matches(r, filter)));

  /** Coarse elapsed label. Deliberately not a live ticker — the panel is open
   *  for seconds at a time and a timer would be motion for its own sake. */
  function elapsed(updatedAt: number): string {
    const mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  void load();
</script>

<main>
  {#if outcome === null}
    <p class="state">Loading…</p>
  {:else if outcome.kind === 'unconfigured'}
    <p class="state">
      Set your Shepherd base URL in this extension's preferences to get started.
    </p>
  {:else if outcome.kind === 'unreachable'}
    <p class="state error">Can't reach Shepherd at {outcome.baseUrl}.</p>
  {:else if outcome.kind === 'unauthorized'}
    <p class="state error">
      Shepherd rejected the token — check the extension preferences. ({outcome.baseUrl})
    </p>
  {:else if outcome.kind === 'http-error'}
    <p class="state error">
      Shepherd answered {outcome.status} at {outcome.baseUrl}.
    </p>
  {:else if outcome.kind === 'malformed'}
    <p class="state error">
      Unexpected response from {outcome.baseUrl} — is that a Shepherd core?
    </p>
  {:else}
    <input class="filter" type="text" placeholder="Filter…" bind:value={filter} />

    <section>
      <h2>Needs you <span class="count">{needsYou.length}</span></h2>
      {#if needsYou.length === 0}
        <p class="state">Nothing needs you.</p>
      {:else}
        <ul>
          {#each needsYou as row (row.id)}
            <li class="row" data-tier={row.tier}>
              <span class="desig">{row.desig}</span>
              <span class="name">{row.name}</span>
              <span class="repo">{row.repo}</span>
              <span class="reason">{row.reason}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>Active <span class="count">{active.length}</span></h2>
      <ul>
        {#each active as row (row.id)}
          <li class="row">
            <span class="desig">{row.desig}</span>
            <span class="name">{row.name}</span>
            <span class="repo">{row.repo}</span>
            <span class="reason">{row.reason ?? `${row.status} · ${elapsed(row.updatedAt)}`}</span>
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>
        <button class="disclosure" onclick={() => (doneOpen = !doneOpen)}>
          {doneOpen ? '▾' : '▸'} Done <span class="count">{done.length}</span>
        </button>
      </h2>
      {#if doneOpen}
        <ul>
          {#each done as row (row.id)}
            <li class="row">
              <span class="desig">{row.desig}</span>
              <span class="name">{row.name}</span>
              <span class="repo">{row.repo}</span>
              <span class="reason">{elapsed(row.updatedAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    padding: var(--space-4);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--font-size-base);
  }

  .filter {
    width: 100%;
    padding: var(--space-2);
    margin-bottom: var(--space-3);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font-family: var(--font-ui);
  }

  section {
    margin-bottom: var(--space-4);
  }

  h2 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 var(--space-2);
  }

  .count {
    color: var(--text-tertiary);
  }

  .disclosure {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    display: grid;
    grid-template-columns: 6rem 1fr 8rem;
    grid-template-areas: 'desig name repo' 'desig reason reason';
    gap: 0 var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius-md);
  }

  .row[data-tier='1'] {
    border-left: 2px solid var(--accent-primary);
  }

  .desig {
    grid-area: desig;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .name {
    grid-area: name;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo {
    grid-area: repo;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    text-align: right;
  }

  .reason {
    grid-area: reason;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
</style>
```

- [ ] **Step 4: Type-check and build**

Run: `npx tsc --noEmit && npx vite build`
Expected: exit 0; `dist/view.html`, `dist/view.js`, `dist/worker.html`, `dist/worker.js` emitted.

- [ ] **Step 5: Re-run the shared-chunk role assertion check**

The view now imports modules the worker does not, so the shared chunk changed. Confirm no role assertion leaked into it — if one had, the worker iframe would throw on every boot with a message pointing at the SDK.

```bash
comm -12 <(grep -oE '\./(assets/)?[A-Za-z0-9._-]+\.js' dist/view.html | sort -u) \
         <(grep -oE '\./(assets/)?[A-Za-z0-9._-]+\.js' dist/worker.html | sort -u)
for f in $(find dist -name '*.js'); do echo "$(grep -c 'Imported outside a' "$f")  $f"; done
```

Expected: every chunk listed by the first command shows count `0` in the second.

- [ ] **Step 6: Load it in the launcher**

```bash
npx asyar link
```

Then in Asyar: open the extension's preferences, set **Shepherd API base URL** to your core's Tailnet FQDN and paste the minted `shp_` token, then run the **Shepherd Sessions** command.

Expected: a Needs-you section listing the sessions that are waiting, each with a reason sentence matching the HUD's line for the same session. Confirm at least one row whose session shows status `done` in the HUD still appears under **Needs you** — that is the hold-before-status rule working.

- [ ] **Step 7: Walk the error states**

- Clear the base URL → the first-run message, not an error.
- Set a wrong token → "Shepherd rejected the token…".
- Stop the core (or set an unreachable FQDN) → "Can't reach Shepherd at …".

- [ ] **Step 8: Commit**

```bash
git add manifest.json src/SessionsView.svelte
git commit -m "feat(panel): three-section triage view with error and empty states"
```

---

### Task 6: Deep link

**Files:**
- Create: `src/opener.ts`
- Modify: `src/SessionsView.svelte` (rows become buttons; add keyboard selection)

**Interfaces:**
- Consumes: `sessionUrl` from `./shepherd/client`; `messageBroker` and the `IBrowserService` type from `asyar-sdk/contracts` (it is re-exported there — **not** from `asyar-sdk/view`).
- Produces: `openExternal(context: ExtensionContext, url: string): Promise<OpenRoute>` where `OpenRoute = 'broker' | 'browser' | 'failed'`.

- [ ] **Step 1: Create `src/opener.ts`**

No test: both branches are IPC into the launcher, so a unit test would assert only that mocks were called. The real verification is Step 4, in a running launcher — which is also the question this module exists to answer.

```ts
// ─────────────────────────────────────────────────────────────────────────
// Opening a URL in the operator's browser.
//
// Asyar exposes NO typed opener service — ctx.getService('opener') throws.
// Two routes exist under different permissions, and the SDK notes could not
// settle which one actually works without a running launcher:
//
//   A  messageBroker.invoke('opener:open', { url })   — shell:open-url
//      Undocumented but real. NB the form in Asyar's troubleshooting.md, with
//      `url` at the top level of the postMessage, is a silent no-op: the
//      router reads `data.payload`.
//   B  getService<IBrowserService>('browser').openUrl(url) — browser:tabs.write
//      Documented and typed, but may prefer a paired browser companion over
//      the OS default.
//
// So: try A, fall back to B, and return which one won. Once the first real run
// answers it, delete the loser AND its permission from manifest.json — the
// narrower permission set is the point of finding out.
// ─────────────────────────────────────────────────────────────────────────
import type { ExtensionContext, IBrowserService } from 'asyar-sdk/contracts';
import { messageBroker } from 'asyar-sdk/contracts';

export type OpenRoute = 'broker' | 'browser' | 'failed';

export async function openExternal(context: ExtensionContext, url: string): Promise<OpenRoute> {
  try {
    await messageBroker.invoke('opener:open', { url });
    return 'broker';
  } catch {
    // fall through to route B
  }

  try {
    const browser = context.getService<IBrowserService>('browser');
    await browser.openUrl(url);
    return 'browser';
  } catch {
    return 'failed';
  }
}
```

- [ ] **Step 2: Wire it into the panel**

In `src/SessionsView.svelte`, add to the `<script>` block, after the existing imports:

```ts
  import { sessionUrl } from './shepherd/client';
  import { openExternal } from './opener';

  let baseUrlForLinks = $state('');
  let openError = $state<string | null>(null);

  async function open(row: PanelRow): Promise<void> {
    const route = await openExternal(context, sessionUrl(baseUrlForLinks, row.id));
    if (route === 'failed') {
      openError = "Couldn't open the browser.";
      return;
    }
    // Route taken is worth knowing exactly once: it decides which permission
    // survives in the manifest.
    console.log(`[shepherd] opened via ${route}`);
    context.hideLauncher();
  }
```

In `load()`, record the base URL for link building — add this line immediately after `const prefs = await readPreferences();`:

```ts
    baseUrlForLinks = prefs.baseUrl;
```

- [ ] **Step 3: Make rows activatable**

Replace each of the three `<li class="row" …>` blocks so the row content sits inside a button. The Needs-you one becomes:

```svelte
          {#each needsYou as row (row.id)}
            <li data-tier={row.tier}>
              <button class="row" onclick={() => open(row)}>
                <span class="desig">{row.desig}</span>
                <span class="name">{row.name}</span>
                <span class="repo">{row.repo}</span>
                <span class="reason">{row.reason}</span>
              </button>
            </li>
          {/each}
```

Apply the same change to the Active and Done loops, keeping each one's existing `<span class="reason">` expression.

Add the open-failure message directly after the `<input class="filter" …>` element:

```svelte
    {#if openError}
      <p class="state error">{openError}</p>
    {/if}
```

Update the style block: move the tier accent onto the `li`, and make the button look like the row did.

```css
  li[data-tier='1'] {
    border-left: 2px solid var(--accent-primary);
    border-radius: var(--radius-md);
  }

  button.row {
    width: 100%;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.row:hover,
  button.row:focus-visible {
    background: var(--bg-secondary);
  }
```

Delete the now-unused `.row[data-tier='1']` rule.

- [ ] **Step 4: Build and verify in the launcher**

Run: `npx tsc --noEmit && npx vite build && npx asyar validate`
Expected: exit 0 from all three.

Reload the extension in Asyar, open the panel, `Tab` to a row and press `Enter` (or click it).

Expected: the browser opens `<baseUrl>/?session=<id>`, the HUD has that session selected, and the launcher closes. **Record which route the console reports** — that decides Step 5.

- [ ] **Step 5: Drop the losing route**

Now that a real launcher has answered the question, delete the branch that did not fire from `src/opener.ts`, and remove its permission from `manifest.json`:

- if `broker` won → remove the `browser` fallback and drop `"browser:tabs.write"` from `permissions`
- if `browser` won → remove the `messageBroker` attempt and drop `"shell:open-url"` from `permissions`

Then update the module header to state which route works and that the other was observed not to, so the next reader does not re-litigate it.

Run: `npx tsc --noEmit && npx vite build && npx asyar validate`
Expected: exit 0. Re-open a session from the panel to confirm the surviving route still works with the narrowed permissions.

- [ ] **Step 6: Commit**

```bash
git add src/opener.ts src/SessionsView.svelte manifest.json
git commit -m "feat(panel): open the selected session in the Shepherd HUD"
```

---

### Task 7: README

**Files:**
- Modify: `README.md` (replace the placeholder note wholesale)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Replace `README.md`**

````markdown
# Shepherd Sessions — Asyar extension

An [Asyar](https://asyar.org) launcher extension that answers one question in a keystroke:
**which of my [Shepherd](https://github.com/erwins-enkel/shepherd) sessions need me right now?**
Selecting a session opens the Shepherd HUD on it.

Read-only. It observes Shepherd and navigates to it; it never steers an agent.

## What it shows

| Section | Contents |
|---|---|
| **Needs you** | Sessions whose hold is critical (tier 1) or high (tier 2), most urgent first, longest wait first within a tier |
| **Active** | Sessions in flight, plus routine tier-3 holds such as `ready-merge` |
| **Done** | Finished sessions, collapsed |

A session is filed by its **hold** before its **status**. An agent that has finished its turn is
very often finished *because* it needs an answer, so a `done` session with a blocking hold appears
under **Needs you**, not under **Done**.

## Requirements

- Asyar installed, with the extension loaded (below).
- A reachable Shepherd core. **It must not be on `localhost`:** Asyar's SSRF gate rejects
  `localhost`, loopback, RFC1918 and link-local addresses *before* DNS resolution, so a core
  reachable only at `http://127.0.0.1:7330` cannot be used. Serve it over Tailscale and use the
  `*.ts.net` FQDN.
- Shepherd new enough to mint access tokens (the **Settings → Access** panel).

## Getting a token

The extension is a machine client, so it authenticates with a bearer token — the browser's session
cookie is `HttpOnly` and unavailable to it.

In Shepherd, open **Settings → Access**, create a token (name it after this client, e.g.
*"Asyar extension"*), and copy it. The value is shown **once**; Shepherd stores only a hash. If you
lose it, revoke the token and mint a new one.

A minted token currently has the same reach you do, including the web terminal — per-token scopes
are tracked upstream as [shepherd#2083](https://github.com/erwins-enkel/shepherd/issues/2083). When
those land, mint a read-scoped token and paste it in; nothing here has to change.

`SHEPHERD_TOKEN` in the core's environment also works, if your deployment provisions one.

## Install

```sh
npm install
npm run build
npx asyar link
```

Then enable the extension in Asyar and open its preferences:

| Preference | Value |
|---|---|
| **Shepherd API base URL** | Your core's URL, e.g. `https://host.example.ts.net:7330` |
| **API token** | The token from above |
| **Reason language** | `Auto` follows your system language; `English` / `Deutsch` override it |

Preferences take effect the next time the panel opens — the launcher reloads the extension when
they change.

## Development

```sh
npm run check     # tsc --noEmit
npm test          # vitest run
npm run build     # vite build
npm run validate  # asyar validate
```

The pure layer (`src/shepherd/types.ts`, `tiers.ts`, `copy.ts`, `view-model.ts`) has no SDK or DOM
dependency and is unit-tested in plain Node. `src/shepherd/client.ts` is the only module that knows
Shepherd is an HTTP service.

The hold copy in `copy.ts` is lifted verbatim from Shepherd's own `src/hold.ts` so that a reason
read here is the same sentence as in the HUD. The tier table in `tiers.ts` is *not* upstream —
Shepherd's `SIGNAL_TIER` is keyed by a different vocabulary — which is why an unrecognised hold code
degrades to tier 1 with generic copy rather than disappearing.

## Not in this version

Root search (typing `TASK-42` straight into the Asyar root), the background poll and its cache, and
any way to reply to or steer a session. Notifications are deliberately absent: Shepherd's web push
already covers "tell me when something changes", and `notifications:send` is never requested.

## Design notes

- `docs/PRD.md` — the product requirements
- `docs/superpowers/specs/2026-08-16-sessions-panel-design.md` — this slice's design
- `docs/asyar-sdk-notes.md` — verified facts about the Asyar SDK, with evidence
````

- [ ] **Step 2: Verify the documented commands actually work**

Run: `npm run check && npm test && npm run build && npm run validate`
Expected: all four exit 0. A README that documents a command that does not exist is worse than no README.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README covering install, token, and what the panel shows"
```

---

## Plan self-review

**Spec coverage.** §4 architecture → Tasks 1–5. §5 copy → Task 2. §6 tiers → Task 1. §7 sections
and hold-before-status → Task 3 (and its two dedicated tests). §8 deep link with both routes →
Task 6, including the delete-the-loser step §8 calls for. §9 preferences and the boot race →
Task 5, Steps 1 and 3. §10 error states → Task 4 (classification) and Task 5 (rendering + the
manual walk). §11 testing → the test steps throughout, plus Task 5 Step 6 and Task 6 Step 4 for the
manual items. No spec section is unimplemented.

**Deferred deliberately, per spec §2:** the background poll, the storage cache, and root search.
`searchable: true` stays in the manifest and the worker keeps returning `[]`, which is a valid
contribution of nothing — not a broken promise.

**Type consistency.** `tierOf(code: string): Tier` is used with a `string` everywhere.
`renderHold(code, params, lang)` keeps that argument order in Tasks 2, 3 and its tests.
`PanelRow.reason` is `string | null` at definition and every use site. `sessionUrl(baseUrl, id)`
matches between Task 4 and Task 6. `FetchOutcome.kind` values are spelled identically in the client,
its tests, and the panel's `{#if}` chain: `ok`, `unconfigured`, `unreachable`, `unauthorized`,
`http-error`, `malformed`.

**One known rough edge, accepted:** Task 6 edits the component Task 5 created, rather than Task 5
writing its final form. That is deliberate — Task 5 is verifiable on its own (the panel renders
real data before anything can be clicked), and splitting them keeps the "which opener route works"
question isolated in one reviewable task.
