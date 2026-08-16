<script lang="ts">
  // The triage panel. Three sections, hold before status — see
  // docs/superpowers/specs/2026-08-16-sessions-panel-design.md §7.
  //
  // Data is fetched on open. There is no background poll in this slice, so
  // nothing here is cached and nothing is notified.
  import type { ExtensionContext, INetworkService } from 'asyar-sdk/contracts';
  import { fetchPanelData, type FetchOutcome } from './shepherd/client';
  import { buildPanel, type PanelModel, type PanelRow } from './shepherd/view-model';
  import { resolveLanguage } from './shepherd/copy';

  let { context }: { context: ExtensionContext } = $props();

  let outcome = $state<FetchOutcome | null>(null);
  let panel = $state<PanelModel>({ needsYou: [], active: [], done: [] });
  let doneOpen = $state(false);
  let filter = $state('');
  /** Set when `load()` itself throws or rejects before an `outcome` can be
   *  produced — e.g. `preferences.refresh()` IPC failure or a synchronous
   *  throw from `getService()`. This is not a client-layer failure (see
   *  `FetchOutcome` in client.ts), so it gets its own state rather than a
   *  new union variant on a type that module is shared and owns. */
  let fatalError = $state<string | null>(null);

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
    let values = context.preferences.values as Record<string, unknown>;
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
      const net = context.getService<INetworkService>('network');
      const result = await fetchPanelData(net, prefs.baseUrl, prefs.token);
      outcome = result;
      if (result.kind === 'ok') {
        const lang = resolveLanguage(prefs.language, globalThis.navigator?.language);
        panel = buildPanel(result.sessions, result.holds, lang);
      } else {
        panel = { needsYou: [], active: [], done: [] };
      }
    } catch (error) {
      fatalError = error instanceof Error ? error.message : String(error);
    }
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

  void load();
</script>

<main>
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
    />

    <section>
      <h2>Needs you <span class="count">{needsYou.length}</span></h2>
      {#if needsYou.length === 0}
        <p class="state">Nothing needs you.</p>
      {:else}
        <ul>
          {#each needsYou as row (row.id)}
            <li class="row" data-tier={row.tier}>
              <span class="desig">{row.desig}</span>
              <span class="name">{row.name}</span>
              <span class="repo">{row.repo}</span>
              <span class="reason">{row.reason}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>Active <span class="count">{active.length}</span></h2>
      {#if active.length === 0}
        <p class="state">Nothing active.</p>
      {:else}
        <ul>
          {#each active as row (row.id)}
            <li class="row">
              <span class="desig">{row.desig}</span>
              <span class="name">{row.name}</span>
              <span class="repo">{row.repo}</span>
              <span class="reason">{row.reason ?? `${row.status} · ${elapsed(row.updatedAt)}`}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h2>
        <button
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
            <li class="row">
              <span class="desig">{row.desig}</span>
              <span class="name">{row.name}</span>
              <span class="repo">{row.repo}</span>
              <span class="reason">{elapsed(row.updatedAt)}</span>
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

  .row {
    display: grid;
    grid-template-columns: 6rem 1fr 8rem;
    grid-template-areas: 'desig name repo' 'desig reason reason';
    gap: 0 var(--space-2);
    padding: var(--space-2);
    border-radius: var(--radius-md);
  }

  .row[data-tier='1'] {
    border-left: 2px solid var(--accent-primary);
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
