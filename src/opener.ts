// ─────────────────────────────────────────────────────────────────────────
// Opening a URL in the operator's browser.
//
// Asyar exposes NO typed opener service — ctx.getService('opener') throws.
// `messageBroker.invoke('opener:open', { url })`, under the `shell:open-url`
// permission, is the one route this extension uses. Verified on a live
// launcher: pressing Enter on a session row opened its terminal in the
// browser, and the launcher log recorded
//   Received message from iframe (dev.erwins-enkel.shepherd): asyar:api:opener:open
//   [Main] Received IPC message from dev.erwins-enkel.shepherd: asyar:api:opener:open
// with no `browser:*` call following. An earlier version of this module also
// tried `getService<IBrowserService>('browser').openUrl(url)` under
// `browser:tabs.write` as a fallback; that route was removed once the above
// confirmed it was never needed.
//
// NB the form documented in Asyar's own `troubleshooting.md`, with `url` at
// the top level of the postMessage rather than under `payload`, is a silent
// no-op: the router reads `data.payload`.
//
// Callable from both roles. The parameter is typed as `ExtensionContextCore`
// (the base both `asyar-sdk/view`'s and `asyar-sdk/worker`'s `ExtensionContext`
// extend), not the full view-only `ExtensionContext`, so the worker's HUD
// action handler can call this too.
// ─────────────────────────────────────────────────────────────────────────
import type { ExtensionContextCore } from 'asyar-sdk/contracts';
import { messageBroker } from 'asyar-sdk/contracts';

export type OpenRoute = 'broker' | 'failed';

/** The SDK's ambient invoke() default (10s, see MessageBroker.js) is tuned for
 *  IPC that may genuinely take a while. Opening a URL is a local operation, so
 *  if this hasn't answered in 3s it isn't "slow" — the host isn't routing
 *  `opener:open` at all, and we want the failure reported promptly instead of
 *  the panel looking frozen. */
const OPEN_INVOKE_TIMEOUT_MS = 3_000;

export async function openExternal(context: ExtensionContextCore, url: string): Promise<OpenRoute> {
  try {
    await messageBroker.invoke('opener:open', { url }, undefined, OPEN_INVOKE_TIMEOUT_MS);
    return 'broker';
  } catch {
    return 'failed';
  }
}
