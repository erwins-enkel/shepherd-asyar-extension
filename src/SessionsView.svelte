<script lang="ts">
  // Scaffold placeholder. Issue #5 replaces this wholesale with the real
  // triage panel (Needs-you / Active sections, keyboard nav, deep link).
  // The `context` prop is the contract view.ts already satisfies; #5 uses it
  // to reach preferences and the Shepherd client.
  import type { ExtensionContext } from 'asyar-sdk/contracts';

  let { context: _context }: { context: ExtensionContext } = $props();
</script>

<main>
  <p>Shepherd Sessions — scaffold placeholder. The panel arrives with issue #5.</p>
</main>

<style>
  main {
    padding: var(--space-4);
    color: var(--text-primary);
    font-family: var(--font-ui);
    font-size: var(--font-size-base);
  }
</style>
