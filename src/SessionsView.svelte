<script lang="ts">
  // The triage panel. Three sections, hold before status — see
  // docs/superpowers/specs/2026-08-16-sessions-panel-design.md §7.
  //
  // Data is fetched on open. There is no background poll in this slice, so
  // nothing here is cached and nothing is notified.
  import type {
    ExtensionAction,
    ExtensionContext,
    IClipboardHistoryService,
    INetworkService,
  } from 'asyar-sdk/contracts';
  import { untrack } from 'svelte';
  import { ActionContext, ClipboardItemType } from 'asyar-sdk/contracts';
  import { fetchPanelData, normalizeBaseUrl, sessionUrl, type FetchOutcome } from './shepherd/client';
  import { buildPanel, type PanelModel, type PanelRow } from './shepherd/view-model';
  import { moveSelection, settleSelection } from './shepherd/selection';
  import { resolveLanguage } from './shepherd/copy';
  import { openExternal } from './opener';

  let { context, extensionId }: { context: ExtensionContext; extensionId: string } = $props();

  let outcome = $state<FetchOutcome | null>(null);
  let panel = $state<PanelModel>({ needsYou: [], active: [], done: [], orphanHolds: 0 });
  let doneOpen = $state(false);
  /** Driven by the launcher's own search bar via postMessage — see
   *  `handleParentMessage` below — not by an input inside this iframe. */
  let filter = $state('');
  let baseUrlForLinks = $state('');
  let openError = $state<string | null>(null);
  /** Bound to the row container so keyboard navigation can query the
   *  currently rendered row buttons in render order instead of maintaining a
   *  parallel index. The listener itself is on `svelte:window` (see below) —
   *  `<main>` is not an interactive element, so it must not own key
   *  handling directly. */
  let containerEl = $state<HTMLElement | null>(null);
  /** The highlighted row, as a session id rather than DOM focus. While the
   *  launcher's search bar owns focus — the normal case, since that bar is
   *  what filters this list — no keystroke reaches this iframe's DOM at all
   *  (see `selection.ts` for the launcher code that intercepts them), and
   *  focusing a row here would take focus off the search bar and stop the
   *  typing that drives the filter. */
  let selectedId = $state<string | null>(null);
  /** Set when `load()` itself throws or rejects before an `outcome` can be
   *  produced — e.g. `preferences.refresh()` IPC failure or a synchronous
   *  throw from `getService()`. This is not a client-layer failure (see
   *  `FetchOutcome` in client.ts), so it gets its own state rather than a
   *  new union variant on a type that module is shared and owns. */
  let fatalError = $state<string | null>(null);

  /** Guards `refresh()` against overlapping loads and drives the Refresh
   *  button's busy state. Set for the very first load too — `refresh()` is
   *  what the bottom-of-file `void refresh()` call now uses instead of
   *  calling `load()` directly. */
  let isLoading = $state(false);

  /** Transient confirmation for the copy-deep-link shortcut (see
   *  `copySessionLink` / `handleKeydown`) and for the "Copy session link"
   *  ⌘K action (see `copyFocusedSessionLink`). Cleared on a short timeout,
   *  not a poll — a one-shot UI fade, not a re-fetch. */
  let copyMessage = $state<string | null>(null);
  let copyMessageTimer: ReturnType<typeof setTimeout> | undefined;

  /** Read a preference, recovering from an empty boot snapshot.
   *
   *  `context.preferences.values` is a synchronous, permission-free read off a
   *  frozen snapshot — but the snapshot can arrive empty. refresh() is IPC and
   *  needs `preferences:read`, which the manifest declares. */
  async function readPreferences(): Promise<{
    baseUrl: string;
    token: string | undefined;
    language: string | undefined;
  }> {
    let values = context.preferences.values;
    if (typeof values?.apiBaseUrl !== 'string' || values.apiBaseUrl.trim() === '') {
      values = await context.preferences.refresh();
    }
    return {
      baseUrl: typeof values?.apiBaseUrl === 'string' ? values.apiBaseUrl : '',
      token: typeof values?.apiToken === 'string' ? values.apiToken : undefined,
      language: typeof values?.holdLanguage === 'string' ? values.holdLanguage : undefined,
    };
  }

  async function load(): Promise<void> {
    try {
      const prefs = await readPreferences();
      baseUrlForLinks = prefs.baseUrl;
      const net = context.getService<INetworkService>('network');
      const result = await fetchPanelData(net, prefs.baseUrl, prefs.token);
      outcome = result;
      if (result.kind === 'ok') {
        const lang = resolveLanguage(prefs.language, globalThis.navigator?.language);
        panel = buildPanel(result.sessions, result.holds, lang);
      } else {
        panel = { needsYou: [], active: [], done: [], orphanHolds: 0 };
      }
    } catch (error) {
      console.error('Shepherd panel load failed:', error);
      fatalError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Re-runs `load()` on demand — the Refresh button's handler, the "Refresh"
   *  ⌘K action's handler, and also what the initial mount call now goes
   *  through (see bottom of file). Clears `fatalError` before retrying:
   *  `load()` itself never clears it on success (see the field doc above),
   *  so without this a fatal error was terminal — closing and reopening the
   *  panel was the only way out. Guards against a second load starting while
   *  one is already in flight. */
  async function refresh(): Promise<void> {
    if (isLoading) return;
    fatalError = null;
    isLoading = true;
    try {
      await load();
    } finally {
      isLoading = false;
    }
  }

  /** Shows a transient status line and resets its own timeout — shared by
   *  `copySessionLink`'s success/failure paths and `copyFocusedSessionLink`'s
   *  no-session-to-copy path, so all three share one fade timer instead of
   *  each reimplementing it. */
  function showCopyMessage(message: string): void {
    copyMessage = message;
    if (copyMessageTimer !== undefined) clearTimeout(copyMessageTimer);
    copyMessageTimer = setTimeout(() => {
      copyMessage = null;
      copyMessageTimer = undefined;
    }, 3000);
  }

  /** Writes a session's HUD deep link to the clipboard, for pasting into a
   *  message instead of opening a browser. Always builds the URL through
   *  `sessionUrl()` — never hand-assembled — so it can never drift from the
   *  one `open()` navigates to. */
  async function copySessionLink(sessionId: string): Promise<void> {
    const url = sessionUrl(baseUrlForLinks, sessionId);
    try {
      const clipboard = context.getService<IClipboardHistoryService>('clipboard');
      await clipboard.writeToClipboard({
        id: `shepherd-link-${sessionId}-${Date.now()}`,
        type: ClipboardItemType.Text,
        content: url,
        createdAt: Date.now(),
        favorite: false,
      });
      showCopyMessage('Copied session link to clipboard.');
    } catch (error) {
      console.error('Shepherd: copy session link failed:', error);
      showCopyMessage("Couldn't copy the session link.");
    }
  }

  /** The first row in render order across the visible sections (Needs you,
   *  then Active, then Done if expanded) — the "most relevant session"
   *  fallback used when a ⌘K action needs a session but no row is focused. */
  function firstVisibleRow(): PanelRow | undefined {
    return needsYou[0] ?? active[0] ?? (doneOpen ? done[0] : undefined);
  }

  /** Handler for the "Copy session link" ⌘K action (see the action
   *  registration effect below). Unlike the Cmd+C keyboard shortcut in
   *  `handleKeydown` — which does nothing when no row is focused, because a
   *  bare keystroke firing unexpectedly would be surprising — an explicit
   *  ⌘K action must not fail silently. Chosen fallback: copy the top of the
   *  list (`firstVisibleRow()`), i.e. the most relevant session, when
   *  nothing is focused; report "nothing to copy" only when the list itself
   *  is empty. */
  async function copyFocusedSessionLink(): Promise<void> {
    const activeEl = document.activeElement;
    const focusedId = activeEl instanceof HTMLElement ? activeEl.dataset.sessionId : undefined;
    const targetId = focusedId ?? selectedId ?? firstVisibleRow()?.id;
    if (!targetId) {
      showCopyMessage('No session to copy — the list is empty.');
      return;
    }
    await copySessionLink(targetId);
  }

  async function open(row: PanelRow): Promise<void> {
    openError = null;
    const route = await openExternal(sessionUrl(baseUrlForLinks, row.id));
    if (route === 'failed') {
      openError = "Couldn't open the browser.";
      return;
    }
    context.hideLauncher();
  }

  /** Handler for the "Open Shepherd HUD" ⌘K action — same behaviour as the
   *  manifest's `open-hud` action (handled in worker.ts for the root-search
   *  surface), reimplemented here for the in-panel surface: open the base
   *  URL with no `session` query param. */
  async function openHud(): Promise<void> {
    openError = null;
    const base = normalizeBaseUrl(baseUrlForLinks);
    if (base === '') {
      openError = "Couldn't open the browser — no Shepherd base URL is configured.";
      return;
    }
    const route = await openExternal(base);
    if (route === 'failed') {
      openError = "Couldn't open the browser.";
      return;
    }
    context.hideLauncher();
  }

  function matches(row: PanelRow, needle: string): boolean {
    const q = needle.trim().toLowerCase();
    if (q === '') return true;
    return (
      row.desig.toLowerCase().includes(q) ||
      row.name.toLowerCase().includes(q) ||
      row.repo.toLowerCase().includes(q)
    );
  }

  let needsYou = $derived(panel.needsYou.filter((r) => matches(r, filter)));
  let active = $derived(panel.active.filter((r) => matches(r, filter)));
  let done = $derived(panel.done.filter((r) => matches(r, filter)));
  let isFiltering = $derived(filter.trim() !== '');

  /** Every visible row id in render order — the order ArrowDown/ArrowUp walk,
   *  and the same order `firstVisibleRow()` picks its head from. Done rows
   *  count only while the section is expanded, because that's when they are
   *  on screen. */
  let visibleIds = $derived([...needsYou, ...active, ...(doneOpen ? done : [])].map((r) => r.id));

  /** Holds the highlight on a row that is actually on screen: the top one
   *  when the list first loads or when filtering hides the previous pick. The
   *  panel is therefore a one-keystroke jump — open it, press Enter, land on
   *  the most urgent session — and typing a filter re-aims that Enter at the
   *  top match without touching the arrow keys. */
  $effect(() => {
    // `selectedId` is read through `untrack` deliberately: this effect writes
    // it, and tracking its own write would make the effect depend on itself.
    // The visible set changing is the only thing that should re-settle it.
    const settled = settleSelection(visibleIds, untrack(() => selectedId));
    if (settled !== untrack(() => selectedId)) selectedId = settled;
  });

  function rowById(id: string): PanelRow | undefined {
    return needsYou.find((r) => r.id === id) ?? active.find((r) => r.id === id) ?? done.find((r) => r.id === id);
  }

  /** Keeps the highlighted row on screen as the selection walks past the
   *  bottom (or top) of the scroll area. `block: 'nearest'` so a row that is
   *  already visible doesn't jump. */
  function scrollSelectionIntoView(): void {
    if (!containerEl || selectedId === null) return;
    const rows = Array.from(containerEl.querySelectorAll<HTMLButtonElement>('button.row'));
    rows.find((el) => el.dataset.sessionId === selectedId)?.scrollIntoView({ block: 'nearest' });
  }

  /** The launcher's own search bar (in the PARENT window) now drives
   *  filtering instead of an input in this iframe — see the (now-removed)
   *  `Filter…` input this replaces. `asyar-sdk`'s shipped `dist/` never
   *  actually calls `Extension.onViewSearch`/`onViewSubmit`/`onViewKeydown`
   *  even though all three are declared on the `Extension` interface —
   *  confirmed by grepping every `.js` file under `asyar-sdk/dist` for those
   *  names: they appear only in the `.d.ts`. So implementing them here would
   *  do nothing; the only way to receive the query is to listen for the
   *  launcher's postMessage directly, the same way `ExtensionBridge`'s own
   *  constructor does for `asyar:action:execute` / `asyar:command:execute` /
   *  `asyar:search:request`. */
  function handleParentMessage(event: MessageEvent): void {
    // Defensive on two axes: only the parent frame is a legitimate sender
    // (mirrors the check `ExtensionBridge`'s own listener uses), and only a
    // recognised message shape is acted on — everything else, including
    // messages this SDK sends for unrelated purposes, is ignored outright.
    if (event.source !== window.parent) return;
    const type = (event.data as { type?: unknown } | null)?.type;

    // The launcher owns the arrow keys while its search bar has focus: it
    // preventDefault()s them and re-delivers them here as a message, so this
    // is the only path by which they can reach the panel at all. See the
    // header comment in selection.ts for the launcher code that does it.
    if (type === 'asyar:view:keydown') {
      const key = (event.data as { payload?: { key?: unknown } }).payload?.key;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        selectedId = moveSelection(visibleIds, selectedId, key);
        scrollSelectionIntoView();
        return;
      }
      // Enter arrives the same way, so a <button>'s native activation never
      // fires — open the highlighted row explicitly instead.
      if (key === 'Enter' && selectedId !== null) {
        const row = rowById(selectedId);
        if (row) void open(row);
      }
      return;
    }

    if (type !== 'asyar:view:search' && type !== 'asyar:view:submit') return;
    const query = (event.data as { payload?: { query?: unknown } }).payload?.query;
    if (typeof query !== 'string') return;
    filter = query;
  }

  $effect(() => {
    window.addEventListener('message', handleParentMessage);
    return () => window.removeEventListener('message', handleParentMessage);
  });

  /** Registers three actions in the launcher's ⌘K drawer for as long as this
   *  panel is mounted, and unregisters them on unmount. Manifest-declared
   *  actions (`ExtensionLoader.registerManifestActions()`) can't cover this:
   *  they get `ActionContext.CORE` and a visibility rule requiring the
   *  highlighted root-search item to be one of this extension's commands —
   *  never true once this view is open. `ActionContext.EXTENSION_VIEW` is
   *  the value documented as "Action available only within extension views".
   *
   *  `execute` is a real closure, not JSON, and this proxy crosses an iframe
   *  boundary — the same SDK is known to drop functions across `postMessage`
   *  (see `search()` results in docs/asyar-sdk-notes.md). It survives here
   *  regardless: reading `ActionServiceProxy.js` / `ExtensionBridge.js`
   *  shows `registerAction()` keeps the *whole* action object, `execute`
   *  included, in this iframe's own local `actionRegistry` map, and that
   *  same iframe's own `window.addEventListener('message', ...)` handler is
   *  what looks the id up in that same map and calls `.execute()` directly
   *  when `asyar:action:execute` arrives — the closure never needs to
   *  survive a `postMessage` round trip. Only the copy sent to the host (for
   *  the drawer's title/description/icon) strips `execute`, since only that
   *  copy is serialized. That's confirmed by reading `asyar-sdk/dist`, not
   *  by a running launcher — whether the host actually addresses
   *  `asyar:action:execute` back to this specific iframe, and whether it
   *  honours `ActionContext.EXTENSION_VIEW` when building the drawer, is
   *  unverified without one. */
  $effect(() => {
    const actions: ExtensionAction[] = [
      {
        id: 'refresh',
        title: 'Refresh',
        description: 'Reload the sessions list from Shepherd.',
        icon: '🔄',
        extensionId,
        context: ActionContext.EXTENSION_VIEW,
        execute: () => refresh(),
      },
      {
        id: 'copy-session-link',
        title: 'Copy session link',
        description:
          "Copy the focused session's HUD deep link. Falls back to the top session when none is focused.",
        icon: '🔗',
        extensionId,
        context: ActionContext.EXTENSION_VIEW,
        execute: () => copyFocusedSessionLink(),
      },
      {
        id: 'panel-open-hud',
        title: 'Open Shepherd HUD',
        description: 'Open the Shepherd HUD root in your browser, with no session preselected.',
        icon: '🐑',
        extensionId,
        context: ActionContext.EXTENSION_VIEW,
        execute: () => openHud(),
      },
    ];
    for (const action of actions) context.registerAction(action);
    return () => {
      for (const action of actions) context.unregisterAction(action.id);
    };
  });

  /** ArrowDown/ArrowUp move focus across the visible row buttons in render
   *  order (Needs you, then Active, then Done if expanded), which is also
   *  their DOM order since the Done rows only exist when doneOpen is true.
   *
   *  This is the DOM path, and it only runs when focus is already inside
   *  this iframe — which now happens only after a mouse click on a row.
   *  Keyboard use from the launcher's search bar goes through
   *  `handleParentMessage` instead (the launcher intercepts those keys
   *  before they can become DOM events here; see selection.ts). Both paths
   *  write `selectedId`, so there is one highlighted row either way.
   *  Enter is not reimplemented here — it already activates a focused row
   *  natively via <button>. Escape and other keys are left untouched: the
   *  launcher owns dismissal, not this panel. */
  function handleKeydown(event: KeyboardEvent): void {
    // Cmd/Ctrl+C on a focused row copies that session's HUD deep link.
    // Chosen over a bare letter because a bare key must stay free for
    // ordinary typing; guarded on `sessionId` below so it never fires
    // without a row focused. It also doesn't collide with the launcher's own
    // bindings: asyar-sdk's navigation-key forwarder
    // (`installNavigationKeyForwarder` in ExtensionBridge) unconditionally
    // forwards only Cmd/Ctrl+K, Cmd/Ctrl+, and Cmd/Ctrl+Q to the host, plus
    // Escape/Backspace when no text field is focused — Cmd/Ctrl+C is in none
    // of those sets, so it reaches this handler instead of being swallowed
    // upstream. And it is the operator's existing "copy" instinct, which a
    // novel binding would not be.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      const active = document.activeElement;
      const sessionId = active instanceof HTMLElement ? active.dataset.sessionId : undefined;
      if (!sessionId) return; // no row focused — leave default copy alone
      event.preventDefault();
      void copySessionLink(sessionId);
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = containerEl
      ? Array.from(containerEl.querySelectorAll<HTMLButtonElement>('button.row'))
      : [];
    if (rows.length === 0) return;

    const index = rows.indexOf(document.activeElement as HTMLButtonElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRow(rows[index === -1 ? 0 : Math.min(index + 1, rows.length - 1)]);
      return;
    }

    // ArrowUp: only act when a row is currently focused — otherwise (e.g.
    // focus is outside this iframe entirely) leave default behaviour alone.
    if (index === -1) return;
    event.preventDefault();
    focusRow(rows[Math.max(index - 1, 0)]);
  }

  /** Keeps the DOM-focus path and the virtual selection pointing at the same
   *  row, so a click-then-arrow session doesn't render two different
   *  "current" rows (a focus ring on one, the highlight on another). */
  function focusRow(el: HTMLButtonElement): void {
    el.focus();
    selectedId = el.dataset.sessionId ?? null;
  }

  /** Coarse elapsed label. Deliberately not a live ticker — the panel is open
   *  for seconds at a time and a timer would be motion for its own sake. */
  function elapsed(updatedAt: number): string {
    const mins = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  void refresh();
</script>

<svelte:window onkeydown={handleKeydown} />

<main bind:this={containerEl}>
  <div class="toolbar">
    <button
      type="button"
      class="refresh"
      onclick={() => void refresh()}
      disabled={isLoading}
      aria-busy={isLoading}
    >
      {isLoading ? 'Refreshing…' : 'Refresh'}
    </button>
  </div>

  {#if copyMessage}
    <p class="state copy-status" role="status">{copyMessage}</p>
  {/if}

  {#if openError}
    <p class="state error">{openError}</p>
  {/if}

  {#if fatalError !== null}
    <p class="state error">Shepherd panel failed to load: {fatalError}</p>
  {:else if outcome === null}
    <p class="state">Loading…</p>
  {:else if outcome.kind === 'unconfigured'}
    <p class="state">
      Set your Shepherd base URL in this extension's preferences to get started.
    </p>
  {:else if outcome.kind === 'unreachable'}
    <p class="state error">Can't reach Shepherd at {outcome.baseUrl}.</p>
  {:else if outcome.kind === 'unauthorized'}
    <p class="state error">
      Shepherd rejected the token — check the extension preferences. ({outcome.baseUrl})
    </p>
  {:else if outcome.kind === 'http-error'}
    <p class="state error">
      Shepherd answered {outcome.status} at {outcome.baseUrl}.
    </p>
  {:else if outcome.kind === 'malformed'}
    <p class="state error">
      Unexpected response from {outcome.baseUrl} — is that a Shepherd core?
    </p>
  {:else}
    {#if panel.orphanHolds > 0}
      <p class="state error">
        {panel.orphanHolds}
        {panel.orphanHolds === 1 ? 'hold references a session' : 'holds reference sessions'} this
        panel didn't receive — the list may be incomplete.
      </p>
    {/if}

    <section>
      <h2>Needs you <span class="count">{needsYou.length}</span></h2>
      {#if needsYou.length === 0}
        <p class="state">{isFiltering ? 'No matches for this filter.' : 'Nothing needs you.'}</p>
      {:else}
        <ul>
          {#each needsYou as row (row.id)}
            <li data-tier={row.tier}>
              <button
                type="button"
                class="row"
                class:selected={selectedId === row.id}
                aria-current={selectedId === row.id ? 'true' : undefined}
                data-session-id={row.id}
                onclick={() => open(row)}
              >
                <span class="desig">{row.desig}</span>
                <span class="name">{row.name}</span>
                <span class="repo">{row.repo}</span>
                <span class="reason">{row.reason}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>Active <span class="count">{active.length}</span></h2>
      {#if active.length === 0}
        <p class="state">{isFiltering ? 'No matches for this filter.' : 'Nothing active.'}</p>
      {:else}
        <ul>
          {#each active as row (row.id)}
            <li>
              <button
                type="button"
                class="row"
                class:selected={selectedId === row.id}
                aria-current={selectedId === row.id ? 'true' : undefined}
                data-session-id={row.id}
                onclick={() => open(row)}
              >
                <span class="desig">{row.desig}</span>
                <span class="name">{row.name}</span>
                <span class="repo">{row.repo}</span>
                <span class="reason">{row.reason ?? `${row.status} · ${elapsed(row.updatedAt)}`}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>
        <button
          type="button"
          class="disclosure"
          aria-expanded={doneOpen}
          onclick={() => (doneOpen = !doneOpen)}
        >
          {doneOpen ? '▾' : '▸'} Done <span class="count">{done.length}</span>
        </button>
      </h2>
      {#if doneOpen}
        <ul>
          {#each done as row (row.id)}
            <li>
              <button
                type="button"
                class="row"
                class:selected={selectedId === row.id}
                aria-current={selectedId === row.id ? 'true' : undefined}
                data-session-id={row.id}
                onclick={() => open(row)}
              >
                <span class="desig">{row.desig}</span>
                <span class="name">{row.name}</span>
                <span class="repo">{row.repo}</span>
                <span class="reason">{elapsed(row.updatedAt)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    padding: var(--space-4);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--font-size-base);
  }

  .toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--space-2);
  }

  .refresh {
    padding: var(--space-1) var(--space-3);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .refresh:hover:not(:disabled),
  .refresh:focus-visible {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .refresh:disabled {
    cursor: default;
    opacity: 0.7;
  }

  .copy-status {
    color: var(--accent-success);
  }

  section {
    margin-bottom: var(--space-4);
  }

  h2 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 var(--space-2);
  }

  .count {
    color: var(--text-tertiary);
  }

  .disclosure {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-transform: inherit;
    letter-spacing: inherit;
    cursor: pointer;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li[data-tier='1'] {
    border-left: 2px solid var(--accent-primary);
    border-radius: var(--radius-md);
  }

  .row {
    display: grid;
    grid-template-columns: 6rem 1fr 8rem;
    grid-template-areas: 'desig name repo' 'desig reason reason';
    gap: 0 var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius-md);
  }

  button.row {
    width: 100%;
    background: none;
    border: none;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.row:hover,
  button.row:focus-visible {
    background: var(--bg-secondary);
  }

  /* The arrow-key highlight. It cannot be `:focus-visible`: the launcher's
     search bar keeps DOM focus while the arrows are being pressed (see
     selection.ts), so this row is never the focused element. An outline on
     top of the background carries the "this is the one Enter opens" cue that
     a focus ring would otherwise carry. */
  button.row.selected {
    background: var(--bg-secondary);
    outline: 1px solid var(--accent-primary);
    outline-offset: -1px;
  }

  .desig {
    grid-area: desig;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
  }

  .name {
    grid-area: name;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .repo {
    grid-area: repo;
    color: var(--text-tertiary);
    font-size: var(--font-size-sm);
    text-align: right;
  }

  .reason {
    grid-area: reason;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
  }
</style>
