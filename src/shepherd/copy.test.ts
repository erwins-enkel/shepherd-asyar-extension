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

  // Each of these codes has a param-present branch that the blanket
  // "non-empty" loops above never actually exercise, since that loop only
  // ever calls with {}. Exact strings here, derived from the map entries in
  // copy.ts, catch wrong punctuation or a swapped clause.
  it('interpolates the pr param when present, in both languages', () => {
    expect(renderHold('pr-conflict', { pr: 118 }, 'en')).toBe(
      "PR #118 has merge conflicts — CI can't run until it's rebased.",
    );
    expect(renderHold('pr-conflict', { pr: 118 }, 'de')).toBe(
      'PR #118 hat Merge-Konflikte — CI kann bis zum Rebase nicht laufen.',
    );

    expect(renderHold('awaiting-merge', { pr: 118 }, 'en')).toBe(
      'Ready and handed to a merger (PR #118).',
    );
    expect(renderHold('awaiting-merge', { pr: 118 }, 'de')).toBe(
      'Bereit und an einen Merger übergeben (PR #118).',
    );

    expect(renderHold('train-error', { pr: 118 }, 'en')).toBe(
      'Merge train hit an error on PR #118 — needs you.',
    );
    expect(renderHold('train-error', { pr: 118 }, 'de')).toBe(
      'Merge-Train hat einen Fehler bei PR #118 — braucht dich.',
    );

    expect(renderHold('merging', { pr: 118 }, 'en')).toBe('In the merge train (PR #118).');
    expect(renderHold('merging', { pr: 118 }, 'de')).toBe('Im Merge-Train (PR #118).');

    expect(renderHold('ready-merge', { pr: 118 }, 'en')).toBe(
      'Ready to merge (PR #118) — waiting on you.',
    );
    expect(renderHold('ready-merge', { pr: 118 }, 'de')).toBe(
      'Bereit zum Mergen (PR #118) — wartet auf dich.',
    );
  });

  it('defaults manual-steps to 1 step when called with {}, in both languages', () => {
    expect(renderHold('manual-steps', {}, 'en')).toBe(
      '1 manual step to do before merge — ack to proceed.',
    );
    expect(renderHold('manual-steps', {}, 'de')).toBe(
      '1 manueller Schritt vor dem Mergen — bestätigen zum Fortfahren.',
    );
  });

  // The rendered clock time depends on the machine's timezone, so this
  // constructs its expectation with the exact same Intl.DateTimeFormat call
  // the implementation uses, rather than pinning a literal clock string.
  it('formats the halted-usage reset time with the locale-appropriate formatter', () => {
    const resetAt = Date.UTC(2026, 0, 1, 12, 30);
    const enTime = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(resetAt));
    const deTime = new Intl.DateTimeFormat('de-DE', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(resetAt));

    expect(renderHold('halted-usage', { resetAt }, 'en')).toBe(
      `Paused at the usage limit — resumes at ${enTime}.`,
    );
    expect(renderHold('halted-usage', { resetAt }, 'de')).toBe(
      `Am Nutzungslimit pausiert — wird um ${deTime} fortgesetzt.`,
    );
    // Sentence structure + presence of a time, without pinning the clock
    // string itself.
    expect(renderHold('halted-usage', { resetAt }, 'en')).toMatch(
      /^Paused at the usage limit — resumes at .+\.$/,
    );
    expect(renderHold('halted-usage', { resetAt }, 'de')).toMatch(
      /^Am Nutzungslimit pausiert — wird um .+ fortgesetzt\.$/,
    );
  });

  it('treats a literal undefined params argument the same as {}', () => {
    expect(renderHold('blocked-menu', undefined, 'en')).toBe('Waiting on a menu choice.');
    expect(renderHold('ci-red', undefined, 'en')).toBe('CI is failing — needs a fix.');
    expect(renderHold('blocked-menu', undefined, 'de')).toBe('Wartet auf eine Menüauswahl.');
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

  // Regression for the prototype-chain leak: a plain `map[code]` bracket
  // lookup on an object literal falls through to Object.prototype for these
  // codes, so it throws or returns a non-string instead of degrading to the
  // generic copy. Must fail before the Map-based fix and pass after.
  it('does not fall through to Object.prototype for colliding codes', () => {
    const dangerousCodes = [
      '__proto__',
      'hasOwnProperty',
      'valueOf',
      'constructor',
      'toString',
    ];
    for (const code of dangerousCodes) {
      expect(() => renderHold(code, {}, 'en')).not.toThrow();
      expect(() => renderHold(code, {}, 'de')).not.toThrow();
      expect(renderHold(code, {}, 'en')).toBe('Needs you.');
      expect(renderHold(code, {}, 'de')).toBe('Braucht dich.');
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

  it('honours an explicit preference regardless of case', () => {
    expect(resolveLanguage('DE', 'en-US')).toBe('de');
    expect(resolveLanguage('EN', 'de-DE')).toBe('en');
    expect(resolveLanguage('De', 'en-US')).toBe('de');
  });
});
