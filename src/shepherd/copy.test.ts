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
