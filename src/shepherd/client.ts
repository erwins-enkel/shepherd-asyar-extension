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

  // Each session must be a non-null object carrying `id`, `desig`, `name` and
  // `repoPath` as strings — mirrors the per-value validation holds get below.
  // Without this, a row missing e.g. `desig` sails through as `Session[]` and
  // later throws inside the filter's `matches()`, which sits in a `$derived`
  // outside `load()`'s try/catch: a broken render with no message. `status`
  // is deliberately left unchecked against a union — that would be more
  // validation than this endpoint's contract warrants.
  for (const value of sessions) {
    if (typeof value !== 'object' || value === null) {
      return { kind: 'malformed', baseUrl: base };
    }
    const v = value as Record<string, unknown>;
    if (
      typeof v.id !== 'string' ||
      typeof v.desig !== 'string' ||
      typeof v.name !== 'string' ||
      typeof v.repoPath !== 'string'
    ) {
      return { kind: 'malformed', baseUrl: base };
    }
  }

  // An empty holds object is the ordinary happy path (a core with nothing
  // held) and must never be reported as malformed. For a non-empty object,
  // every value must look like a RawHold: a non-null object carrying a
  // `code` of type string. This catches, in particular, a future Shepherd
  // response wrapped in an envelope like `{ "holds": { "<id>": {...} } }` —
  // that wrapper is itself a non-null, non-array object, so without this
  // check it would pass through as an (empty-looking) holds map and every
  // session would silently read as un-held.
  //
  // Iterate with Object.values, not bracket access on the untrusted payload,
  // so a key like "toString" cannot fall through to Object.prototype.
  for (const value of Object.values(holds as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) {
      return { kind: 'malformed', baseUrl: base };
    }
    if (typeof (value as { code?: unknown }).code !== 'string') {
      return { kind: 'malformed', baseUrl: base };
    }
  }

  return {
    kind: 'ok',
    sessions: sessions as Session[],
    holds: holds as HoldsResponse,
  };
}
