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
