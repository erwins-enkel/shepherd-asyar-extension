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
