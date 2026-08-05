// ─────────────────────────────────────────────────────────────────────────
// worker.ts — Tier 2 worker entry, loaded by dist/worker.html.
//
// Bootstrap only. The scheduled poll + cache land in #6, the cache-backed
// search() in #7; both go in modules this file imports, typed from
// `asyar-sdk/contracts` so they stay unit-testable without a launcher.
//
// `asyar-sdk/worker` asserts `window.__ASYAR_ROLE__ === "worker"` at module
// load, and does NOT re-export the DOM-dependent SDK surface — that is what
// keeps the worker bundle small and unable to touch the document.
// ─────────────────────────────────────────────────────────────────────────

import {
  ExtensionContext as WorkerExtensionContext,
  extensionBridge,
} from 'asyar-sdk/worker';
import type {
  Extension,
  ExtensionContext,
  ExtensionResult,
  ILogService,
} from 'asyar-sdk/contracts';
import manifest from '../manifest.json';

const FALLBACK_ID = 'blog.osthoff.shepherd';

const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || FALLBACK_ID
    : window.location.hostname || FALLBACK_ID;

const workerContext = new WorkerExtensionContext();
workerContext.setExtensionId(extensionId);

const log = workerContext.getService<ILogService>('log');

// The Extension interface's `initialize(ctx)` expects the contracts-flavored
// ExtensionContext, a sibling (not a supertype) of the worker-flavored class
// constructed above. This worker owns its context lexically, so the hook is
// a no-op and is never called — matching the shipped Tier 2 extensions.
class ShepherdWorkerExtension implements Extension {
  async initialize(_ctx: ExtensionContext): Promise<void> {}

  async activate(): Promise<void> {
    log.info(`[${extensionId}] worker activated`);
  }

  async deactivate(): Promise<void> {}

  // Root-search contribution. The launcher caps a whole extension-search
  // round at 200 ms, so this must always answer from cache, never fetch. #7
  // fills it in once #6's cache exists.
  async search(_query: string): Promise<ExtensionResult[]> {
    return [];
  }

  async executeCommand(commandId: string): Promise<unknown> {
    if (commandId !== 'poll') {
      log.warn(`[${extensionId}] unknown command: ${commandId}`);
      return undefined;
    }
    // #6 replaces this with the fetch-into-cache tick.
    return undefined;
  }

  onUnload = (): void => {};
}

const workerExtension = new ShepherdWorkerExtension();

// Order is load-bearing: registerExtensionImplementation() logs an error and
// silently returns when no manifest is registered for the id.
extensionBridge.registerManifest(
  manifest as Parameters<typeof extensionBridge.registerManifest>[0],
);
extensionBridge.registerExtensionImplementation(extensionId, workerExtension);

void (async () => {
  try {
    await workerExtension.activate();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[${extensionId}] worker activate failed: ${msg}`);
  }
})();

window.addEventListener('beforeunload', () => {
  void workerExtension.deactivate();
});
