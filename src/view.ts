// ─────────────────────────────────────────────────────────────────────────
// view.ts — Tier 2 view entry, loaded by dist/view.html.
//
// Bootstrap only. All panel logic lands in SessionsView.svelte (#5) and the
// modules it imports; keeping this file free of logic is what lets the pure
// layer (#3) be unit-tested without a launcher.
//
// `asyar-sdk/view` asserts `window.__ASYAR_ROLE__ === "view"` at module load.
// The Rust `asyar-extension://` scheme handler injects that global based on
// the requested filename alone — renaming view.html breaks the import.
// ─────────────────────────────────────────────────────────────────────────

import 'asyar-sdk/tokens.css';
import { mount } from 'svelte';
import {
  ExtensionContext,
  extensionBridge,
  registerIconElement,
  type Extension,
  type IExtensionManager,
} from 'asyar-sdk/view';
import manifest from '../manifest.json';
import SessionsView from './SessionsView.svelte';

const FALLBACK_ID = 'blog.osthoff.shepherd';

// Copied from the shipped asyar-browser-extension: under the dev server the
// id is the first path segment, otherwise the iframe hostname is the id.
const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || FALLBACK_ID
    : window.location.hostname || FALLBACK_ID;

class ShepherdViewExtension implements Extension {
  private extensionManager?: IExtensionManager;

  async initialize(ctx: ExtensionContext): Promise<void> {
    this.extensionManager = ctx.getService<IExtensionManager>('extensions');
  }

  async activate(): Promise<void> {}

  async deactivate(): Promise<void> {}

  async executeCommand(commandId: string): Promise<unknown> {
    if (commandId !== 'sessions') return undefined;
    const viewPath = `${extensionId}/SessionsView`;
    this.extensionManager?.navigateToView(viewPath);
    return { type: 'view', viewPath };
  }
}

const context = new ExtensionContext();
context.setExtensionId(extensionId);
registerIconElement();

const viewExtension = new ShepherdViewExtension();

// Order is load-bearing: registerExtensionImplementation() logs an error and
// silently returns when no manifest is registered for the id.
extensionBridge.registerManifest(
  manifest as Parameters<typeof extensionBridge.registerManifest>[0],
);
extensionBridge.registerExtensionImplementation(extensionId, viewExtension);

void (async () => {
  await viewExtension.initialize(context);
  await viewExtension.activate();
})();

const viewName = new URLSearchParams(window.location.search).get('view');
const target = document.getElementById('app');
if (viewName === 'SessionsView' && target) {
  mount(SessionsView, { target, props: { context } });
}
