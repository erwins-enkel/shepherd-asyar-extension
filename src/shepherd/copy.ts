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
