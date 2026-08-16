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

  it('counts holds for sessions that are not in the list as orphanHolds, without fabricating a row', () => {
    const panel = buildPanel([session({ id: 's1' })], { ghost: { code: 'ci-red' } }, 'en');

    expect(panel.needsYou).toEqual([]);
    expect(panel.active.map((r) => r.id)).toEqual(['s1']);
    expect(panel.orphanHolds).toBe(1);
  });

  it('reports zero orphanHolds when every hold matches a session', () => {
    const sessions = [session({ id: 's1' })];
    const holds: HoldsResponse = { s1: { code: 'ci-red' } };

    const panel = buildPanel(sessions, holds, 'en');

    expect(panel.orphanHolds).toBe(0);
  });

  it('does not treat prototype-chain properties as holds', () => {
    for (const id of ['toString', '__proto__', 'constructor']) {
      const panel = buildPanel([session({ id, status: 'running' })], {}, 'en');

      expect(panel.active.map((r) => r.id)).toEqual([id]);
      expect(panel.needsYou).toEqual([]);
      expect(panel.active[0].reason).toBeNull();
      expect(panel.active[0].tier).toBeNull();
    }
  });

  it('exposes the repo basename and renders in the requested language', () => {
    const sessions = [session({ id: 's1', repoPath: '/home/moe/projects/shepherd' })];
    const holds: HoldsResponse = { s1: { code: 'blocked-menu' } };

    const panel = buildPanel(sessions, holds, 'de');

    expect(panel.needsYou[0].repo).toBe('shepherd');
    expect(panel.needsYou[0].reason).toBe('Wartet auf eine Menüauswahl.');
  });
});
