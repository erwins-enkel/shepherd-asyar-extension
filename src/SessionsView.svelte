<script lang="ts">
  // The triage panel. Three sections, hold before status — see
  // docs/superpowers/specs/2026-08-16-sessions-panel-design.md §7.
  //
  // Data is fetched on open. There is no background poll in this slice, so
  // nothing here is cached and nothing is notified.
  import type { ExtensionContext, IClipboardHistoryService, INetworkService } from 'asyar-sdk/contracts';
  import { ClipboardItemType } from 'asyar-sdk/contracts';
  import { fetchPanelData, sessionUrl, type FetchOutcome } from './shepherd/client';
  import { buildPanel, type PanelModel, type PanelRow } from './shepherd/view-model';
  import { resolveLanguage } from './shepherd/copy';
  import { openExternal } from './opener';

  let { context }: { context: ExtensionContext } = $props();

  let outcome = $state<FetchOutcome | null>(null);
  let panel = $state<PanelModel>({ needsYou: [], active: [], done: [], orphanHolds: 0 });
  let doneOpen = $state(false);
  let filter = $state('');
  let baseUrlForLinks = $state('');
  let openError = $state<string | null>(null);
  /** Bound to the row container so keyboard navigation can query the
   *  currently rendered row buttons in render order instead of maintaining a
   *  parallel index. The listener itself is on `svelte:window` (see below) —
   *  `<main>` is not an interactive element, so it must not own key
   *  handling directly. */
  let containerEl = $state<HTMLElement | null>(null);
  let filterInput = $state<HTMLInputElement | null>(null);
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
   *  `copySessionLink` / `handleKeydown`). Cleared on a short timeout, not a
   *  poll — a one-shot UI fade, not a re-fetch. */
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

  /** Re-runs `load()` on demand — the Refresh button's handler, and also
   *  what the initial mount call now goes through (see bottom of file).
   *  Clears `fatalError` before retrying: `load()` itself never clears it on
   *  success (see the field doc above), so without this a fatal error was
   *  terminal — closing and reopening the panel was the only way out. Guards
   *  against a second load starting while one is already in flight. */
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
      copyMessage = 'Copied session link to clipboard.';
    } catch (error) {
      console.error('Shepherd: copy session link failed:', error);
      copyMessage = "Couldn't copy the session link.";
    }
    if (copyMessageTimer !== undefined) clearTimeout(copyMessageTimer);
    copyMessageTimer = setTimeout(() => {
      copyMessage = null;
      copyMessageTimer = undefined;
    }, 3000);
  }

  async function open(row: PanelRow): Promise<void> {
    openError = null;
    const route = await openExternal(context, sessionUrl(baseUrlForLinks, row.id));
    if (route === 'failed') {
      openError = "Couldn't open the browser.";
      return;
    }
    // Route taken is worth knowing exactly once: it decides which permission
    // survives in the manifest.
    console.log(`[shepherd] opened via ${route}`);
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

  // Autofocus the filter input as soon as the panel has data to show — that
  // is the launcher idiom: typing narrows the list immediately, with no Tab
  // needed to reach it.
  $effect(() => {
    if (outcome?.kind === 'ok') {
      filterInput?.focus();
    }
  });

  /** ArrowDown/ArrowUp move focus across the visible row buttons in render
   *  order (Needs you, then Active, then Done if expanded), which is also
   *  their DOM order since the Done rows only exist when doneOpen is true.
   *  From the filter input, ArrowDown moves into the first row. Enter is not
   *  reimplemented here — it already activates a focused row natively via
   *  <button>. Escape and other keys are left untouched: the launcher owns
   *  dismissal, not this panel. */
  function handleKeydown(event: KeyboardEvent): void {
    // Cmd/Ctrl+C on a focused row copies that session's HUD deep link.
    // Chosen over a bare letter because a bare key must stay free for the
    // filter input; guarded on `sessionId` below so it never fires there.
    // It also doesn't collide with the launcher's own bindings: asyar-sdk's
    // navigation-key forwarder (`installNavigationKeyForwarder` in
    // ExtensionBridge) unconditionally forwards only Cmd/Ctrl+K, Cmd/Ctrl+,
    // and Cmd/Ctrl+Q to the host, plus Escape/Backspace when no text field is
    // focused — Cmd/Ctrl+C is in none of those sets, so it reaches this
    // handler instead of being swallowed upstream. And it is the operator's
    // existing "copy" instinct, which a novel binding would not be.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      const active = document.activeElement;
      const sessionId = active instanceof HTMLElement ? active.dataset.sessionId : undefined;
      if (!sessionId) return; // no row focused (e.g. filter input) — leave default copy alone
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
      rows[index === -1 ? 0 : Math.min(index + 1, rows.length - 1)].focus();
      return;
    }

    // ArrowUp: only act when a row is currently focused — otherwise (e.g.
    // from the filter input) leave the browser's default behaviour alone.
    if (index === -1) return;
    event.preventDefault();
    if (index === 0) {
      filterInput?.focus();
    } else {
      rows[index - 1].focus();
    }
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
    <input
      class="filter"
      type="text"
      placeholder="Filter…"
      aria-label="Filter sessions"
      bind:value={filter}
      bind:this={filterInput}
    />

    {#if openError}
      <p class="state error">{openError}</p>
    {/if}

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

  .filter {
    width: 100%;
    padding: var(--space-2);
    margin-bottom: var(--space-3);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    font-family: var(--font-ui);
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
