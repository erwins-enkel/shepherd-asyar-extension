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
import { normalizeBaseUrl } from './shepherd/client';
import { openExternal } from './opener';

const FALLBACK_ID = 'dev.erwins-enkel.shepherd';

const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || FALLBACK_ID
    : window.location.hostname || FALLBACK_ID;

const workerContext = new WorkerExtensionContext();
workerContext.setExtensionId(extensionId);

const log = workerContext.getService<ILogService>('log');

/** Handler for the manifest's "open-hud" action (`act_<extensionId>_open-hud`
 *  once dispatched — see `registerActionHandler` below). Opens the HUD root,
 *  deliberately with no `session` query param: this is the always-available
 *  root-search action, not a per-session deep link (those live in the panel,
 *  see SessionsView.svelte's `open()`).
 *
 *  Reads `apiBaseUrl` the same way the panel does: a synchronous read off the
 *  preferences snapshot, recovering via `refresh()` (IPC, needs
 *  `preferences:read`) if the snapshot arrived empty. */
async function handleOpenHud(): Promise<void> {
  let values = workerContext.preferences.values;
  if (typeof values?.apiBaseUrl !== 'string' || values.apiBaseUrl.trim() === '') {
    values = await workerContext.preferences.refresh();
  }
  const baseUrl = typeof values?.apiBaseUrl === 'string' ? normalizeBaseUrl(values.apiBaseUrl) : '';
  if (baseUrl.length === 0) {
    log.warn(`[${extensionId}] "Open Shepherd HUD" action fired with no apiBaseUrl configured`);
    return;
  }

  const route = await openExternal(workerContext, baseUrl);
  if (route === 'failed') {
    log.error(`[${extensionId}] "Open Shepherd HUD" action: no opener route succeeded`);
    return;
  }
  log.info(`[${extensionId}] opened Shepherd HUD via ${route}`);
}

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
}

const workerExtension = new ShepherdWorkerExtension();

// Order is load-bearing: registerExtensionImplementation() logs an error and
// silently returns when no manifest is registered for the id.
extensionBridge.registerManifest(
  manifest as Parameters<typeof extensionBridge.registerManifest>[0],
);
extensionBridge.registerExtensionImplementation(extensionId, workerExtension);

// Root-search-only affordance: the launcher only surfaces manifest `actions`
// while this extension's command is highlighted in root search, before the
// panel opens (see docs/asyar-sdk-notes.md). The launcher dispatches it as
// `act_<extensionId>_open-hud`; `registerActionHandler` builds that exact id
// internally, so the manifest's plain `"open-hud"` is passed here unprefixed.
// Registered unconditionally (not inside `activate()`) so the action works
// even if `activate()` itself fails.
extensionBridge.registerActionHandler(extensionId, 'open-hud', handleOpenHud);

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
