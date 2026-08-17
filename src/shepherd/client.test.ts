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

    expect(outcome).toEqual({ kind: 'ok', sessions: SESSIONS, holds: HOLDS, icons: {} });
  });

  it('requests all three endpoints with the bearer token and an explicit timeout', async () => {
    const net = bothOk();

    await fetchPanelData(net, BASE, 'shp_token');

    expect(net.calls.map((c) => c.url).sort()).toEqual([
      `${BASE}/api/holds`,
      `${BASE}/api/project-icons`,
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

  // A session row missing a required string field must not survive to
  // buildPanel — it would throw later inside the filter's matches(), which is
  // outside load()'s try/catch, producing a broken render with no message.
  it('reports malformed when a session value is not a shape-valid object', async () => {
    const notAnObject = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok(HOLDS) : ok(['not-an-object']),
    );
    expect(await fetchPanelData(notAnObject, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });

    const nullEntry = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok(HOLDS) : ok([null]),
    );
    expect(await fetchPanelData(nullEntry, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });
  });

  it('reports malformed when a session is missing a required string field', async () => {
    for (const field of ['id', 'desig', 'name', 'repoPath']) {
      const broken = { ...SESSIONS[0] } as Record<string, unknown>;
      delete broken[field];
      const net = new FakeNet(async (url) =>
        url.includes('/api/holds') ? ok(HOLDS) : ok([broken]),
      );
      expect(await fetchPanelData(net, BASE, 't')).toEqual({
        kind: 'malformed',
        baseUrl: BASE,
      });
    }
  });

  it('treats an empty core as success, not an error', async () => {
    const net = new FakeNet(async (url) => (url.includes('/api/holds') ? ok({}) : ok([])));

    expect(await fetchPanelData(net, BASE, 't')).toEqual({
      kind: 'ok',
      sessions: [],
      holds: {},
      icons: {},
    });
  });

  // A future Shepherd version could wrap the holds map, e.g.
  // `{ "holds": { "s1": {...} } }` instead of the bare `{ "s1": {...} }`.
  // That wrapper is a non-null, non-array object, so the old guard let it
  // through — no session id would ever match the single "holds" key, every
  // session would read as un-held, and the panel would wrongly report
  // "Nothing needs you". This must be classified malformed instead.
  it('reports malformed when the holds payload is wrapped in an envelope', async () => {
    const wrapped = { holds: { s1: { code: 'blocked-menu' } } };
    const net = new FakeNet(async (url) => (url.includes('/api/holds') ? ok(wrapped) : ok(SESSIONS)));

    expect(await fetchPanelData(net, BASE, 't')).toEqual({ kind: 'malformed', baseUrl: BASE });
  });

  it('reports malformed when holds values are not hold-shaped', async () => {
    const stringValues = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok({ s1: 'blocked-menu' }) : ok(SESSIONS),
    );
    expect(await fetchPanelData(stringValues, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });

    const missingCode = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok({ s1: { reason: 'x' } }) : ok(SESSIONS),
    );
    expect(await fetchPanelData(missingCode, BASE, 't')).toEqual({
      kind: 'malformed',
      baseUrl: BASE,
    });
  });

  it('reports ok for an empty holds object — the ordinary happy path, never malformed', async () => {
    const net = new FakeNet(async (url) => (url.includes('/api/holds') ? ok({}) : ok(SESSIONS)));

    expect(await fetchPanelData(net, BASE, 't')).toEqual({
      kind: 'ok',
      sessions: SESSIONS,
      holds: {},
      icons: {},
    });
  });

  it('accepts a valid holds payload where a value carries params', async () => {
    const withParams = { s1: { code: 'quota-rework', params: { round: 2, cap: 5 } } };
    const net = new FakeNet(async (url) =>
      url.includes('/api/holds') ? ok(withParams) : ok(SESSIONS),
    );

    expect(await fetchPanelData(net, BASE, 't')).toEqual({
      kind: 'ok',
      sessions: SESSIONS,
      holds: withParams,
      icons: {},
    });
  });
});

describe('fetchPanelData — project icons', () => {
  it('carries the repoPath→emoji map from /api/project-icons', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/holds')) return ok(HOLDS);
      if (url.includes('/api/project-icons')) return ok({ '/repos/demo': '🚚' });
      return ok(SESSIONS);
    });

    const result = await fetchPanelData(net, BASE, undefined);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.icons).toEqual({ '/repos/demo': '🚚' });
  });

  it('still renders the panel when the core has no project-icons endpoint', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/holds')) return ok(HOLDS);
      if (url.includes('/api/project-icons')) return status(404);
      return ok(SESSIONS);
    });

    const result = await fetchPanelData(net, BASE, undefined);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.icons).toEqual({});
  });

  it('survives a project-icons request that rejects outright', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/project-icons')) throw new Error('fetch_url failed');
      if (url.includes('/api/holds')) return ok(HOLDS);
      return ok(SESSIONS);
    });

    const result = await fetchPanelData(net, BASE, undefined);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.icons).toEqual({});
  });

  it('ignores a malformed project-icons payload instead of failing the panel', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/holds')) return ok(HOLDS);
      if (url.includes('/api/project-icons')) return ok(['not', 'a', 'map']);
      return ok(SESSIONS);
    });

    const result = await fetchPanelData(net, BASE, undefined);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.icons).toEqual({});
  });

  it('drops non-string entries, mirroring Shepherd’s own loadIcons', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/holds')) return ok(HOLDS);
      if (url.includes('/api/project-icons')) return ok({ '/repos/demo': '🚚', '/repos/x': 7 });
      return ok(SESSIONS);
    });

    const result = await fetchPanelData(net, BASE, undefined);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.icons).toEqual({ '/repos/demo': '🚚' });
  });

  it('sends the same auth header to the icons endpoint', async () => {
    const net = new FakeNet(async (url) => {
      if (url.includes('/api/holds')) return ok(HOLDS);
      if (url.includes('/api/project-icons')) return ok({});
      return ok(SESSIONS);
    });

    await fetchPanelData(net, BASE, 'sekrit');

    const call = net.calls.find((c) => c.url.includes('/api/project-icons'));
    expect(call?.options?.headers?.Authorization).toBe('Bearer sekrit');
  });
});
