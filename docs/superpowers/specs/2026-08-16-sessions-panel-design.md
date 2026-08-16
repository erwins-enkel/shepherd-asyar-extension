# Design — Shepherd Sessions panel (vertical slice)

**Status:** approved design, pre-implementation
**Date:** 2026-08-16
**Owner:** Kai Osthoff
**Implements:** PRD §8 items 1–5, 7, 8, 9 (US-1, US-2, US-3, US-5, US-6)
**Defers:** PRD §8 items 6 (root search) and the background poll + cache

## 1. Goal

One keystroke answers *which agents are waiting on me right now*, and one more lands on that
session in the Shepherd HUD. Everything else in the PRD is secondary to that sentence.

Measured against the live core on 2026-08-16, the answer is **12 of 24 sessions** — 11 tier-1,
1 tier-2. That ratio is the whole justification for the extension: without it, finding those 12
means opening the HUD and scanning.

## 2. Scope

**In:** preferences → authenticated parallel fetch of `/api/sessions` + `/api/holds` → join →
three-section panel (Needs you / Active / Done) → `Enter` opens `<baseUrl>/?session=<id>` →
error and empty states → unit tests for the pure layer.

**Out (deferred, not cancelled):** the 60 s background poll, the storage cache, and the root-search
contribution. These three are one unit of work: root search cannot fetch live (the launcher caps a
whole extension-search round at 200 ms), so it needs the cache, which needs the poll. Shipping any
of them alone is not viable. `searchable: true` stays in the manifest and the worker keeps
returning `[]` until then.

**Out (per PRD §4):** steering sessions, creating sessions, notifications, rendering
terminal/diff/transcript, multiple cores.

## 3. Verified data contract

Probed against the live core on 2026-08-16 with a minted `shp_` token. Both endpoints answered
`200`.

- **`GET /api/sessions`** → a flat JSON **array** (24 rows). Each row carries 60+ fields; this
  design uses exactly six: `id`, `desig`, `name`, `repoPath`, `status`, `updatedAt`. Archived
  sessions never arrive — the payload contained zero rows with `status: "archived"` and zero with a
  non-null `archivedAt`, so the server filters them and the client needs no archive handling.
- **`GET /api/holds`** → a JSON **object** keyed by session id (12 entries), each
  `{ code: HoldCode, params?: HoldParams }`. Sessions absent from the object are un-held.

Codes observed in the wild: `autopilot-paused` (4), `blocked-menu` (3), `quota-rework` (2),
`recap-attention`, `quota-plan`, `critic-rework`. Params observed: `findings`, `question`.

Status distribution observed: `done` (21), `blocked` (3) — the finding that drives §7. Note that
`running` and `idle` did **not** appear in this snapshot, so the Active section's behaviour for
them is designed from the PRD rather than confirmed against live data; the rule is written to be
status-agnostic (anything not `done` and not tier-1/2 held) so an unobserved status cannot fall
through the cracks.

## 4. Architecture

Six modules, one responsibility each, with all impurity confined to `client.ts`.

| Module | Responsibility | Depends on |
|---|---|---|
| `src/shepherd/types.ts` | The `HoldCode` union, `HoldParams`, and the eight-field `Session` subset — mirrored from Shepherd `src/types.ts` | nothing |
| `src/shepherd/copy.ts` | `HoldCode` → sentence, EN + DE, with the unknown-code fallback | `types` |
| `src/shepherd/tiers.ts` | `HoldCode` → tier 1/2/3, unknown → 1 | `types` |
| `src/shepherd/view-model.ts` | Join, group, sort → `{ needsYou, active, done }` | `types`, `tiers`, `copy` |
| `src/shepherd/client.ts` | Both GETs in parallel via `INetworkService`; classifies failures | `types`, SDK |
| `src/SessionsView.svelte` | Renders, handles keyboard, opens the deep link | all of the above |

Everything except `client.ts` and the component is pure and takes its types from
`asyar-sdk/contracts` only, which is what lets it run under plain Node in tests — the SDK's own
`contracts.purity.test.ts` guarantees that entry resolves with no DOM and no `__ASYAR_ROLE__`.

`client.ts` is the single place that knows Shepherd is an HTTP service. If `/api/holds` changes
shape (PRD risk R3 — it has no stability contract), exactly one file changes.

## 5. Hold copy — lifted, not written

PRD §7.4 planned to write an English copy map from scratch as "deliberate duplication". That is
unnecessary: Shepherd's `src/hold.ts` already contains complete `EN` and `DE` maps as pure
`(params, locale) => string` functions with no server dependencies.

**Decision:** copy both maps verbatim into `src/shepherd/copy.ts`, with a header comment pinning the
source: `erwins-enkel/shepherd`, `src/hold.ts`, commit `2e2fd0888be517e9381adc591784a414fb5bbbf2`. Still duplication, but *exact* duplication —
risk R2 shrinks from "our copy is wrong" to "Shepherd reworded something".

**One thing we must add.** Shepherd's `renderHold()` does a bare `map[hold.code]` lookup and calls
the result. An unknown code makes it **throw**, not degrade. Our version returns a generic
`"Needs you." / "Braucht dich."` for any code not in the map. PRD S7 requires this, and it is what
keeps a newly-added Shepherd hold code visible rather than crashing the panel.

## 6. Tier mapping — the one piece we invent

`SIGNAL_TIER` in Shepherd's `src/rundown-core.ts` cannot be mirrored: it is keyed by `SignalCode`,
a **different vocabulary** from `HoldCode`. `blocked-decision` and `in-flight` exist only as
signals; `blocked-menu`, `blocked-yes-no`, `blocked-awaiting-input`, `blocked-stall`,
`blocked-generic`, `autopilot-paused`, the four `quota-*` codes and `merge-rebasing` exist only as
holds. There is no `HOLD_TIER` map anywhere in Shepherd.

So the PRD §7.3 table is our translation, and it is the only place this extension asserts something
Shepherd does not:

- **Tier 1 (critical):** `halted-error`, `blocked-menu`, `blocked-yes-no`,
  `blocked-awaiting-input`, `blocked-stall`, `blocked-generic`, `quota-rework`, `quota-review`,
  `quota-error`, `quota-plan`, `autopilot-paused`, `plan-rework`, `plan-question`, `critic-rework`,
  `ci-red`, `pr-conflict`, `manual-steps`
- **Tier 2 (high):** `halted-usage`, `awaiting-merge`, `stalled`, `recap-attention`, `train-error`
- **Tier 3 (routine):** `ready-merge`, `merging`, `merge-rebasing`
- **Unknown → tier 1**, with generic copy.

Unknown-to-tier-1 is load-bearing, not defensive politeness: because the table is hand-written, a
code Shepherd adds tomorrow is *guaranteed* to be unknown to us. Surfacing it vaguely is right;
dropping it silently would break the extension's one promise.

## 7. Sections — three, not two

PRD US-2 puts every non-waiting session into one **Active** list. Against real data that list is
21 of 24 rows of finished work, which buries the three that are actually in flight.

**Decision:** three sections.

| Section | Contents | Order |
|---|---|---|
| **Needs you** | tier 1 and 2 holds | tier asc, then `updatedAt` asc (oldest wait first) |
| **Active** | no hold, or a tier-3 hold; status not `done` | `updatedAt` desc |
| **Done** | status `done` | `updatedAt` desc |

**Done is collapsed by default** with its count in the header. Collapsed, not dropped: a
just-finished session is often the next thing you want to open.

Each row shows designation, name, repo basename, and either the rendered hold reason (Needs you,
and tier-3 rows in Active) or status + elapsed time. Section headers carry counts. Zero waiting
sessions renders an explicit "Nothing needs you", not an empty list.

## 8. Deep link

`Enter` opens `<baseUrl>/?session=<id>` and closes the launcher. The HUD already selects a session
from the `session` query parameter.

Asyar exposes **no** opener service — `ctx.getService('opener')` throws. Two routes exist and only
a running launcher can decide between them, so the implementation **tries A, falls back to B**:

- **A:** `messageBroker.invoke('opener:open', { url })`, under `shell:open-url`. Undocumented but
  real. Note the form in Asyar's own `troubleshooting.md` — `url` at the top level of the
  postMessage — is a silent no-op; the router reads `data.payload`.
- **B:** `getService<IBrowserService>('browser').openUrl(url)`, under `browser:tabs.write`.
  Documented and typed, but may prefer a paired browser companion over the OS default.

Both permissions are already declared. Once the first manual run shows which works, the loser and
its permission are deleted — a two-line change, and the narrower permission set is the point.

## 9. Preferences

Existing: `apiBaseUrl` (textfield, required) and `apiToken` (password). The manifest default for
`apiBaseUrl` stays the placeholder `https://host.example.ts.net:1234` — the operator's real Tailnet
FQDN is deployment detail and does not belong in a repository.

**New:** `holdLanguage`, a dropdown of `auto` (default) / `en` / `de`.

This is a **deviation** from the "follow the Asyar locale" decision, forced by a finding: Asyar has
no locale surface at all. Neither `asyar-sdk` nor the launcher contains any `locale`/`i18n` code —
the launcher is English-only and passes no language to extensions. `auto` therefore resolves via
`navigator.language` in the view's webview, which inherits the OS locale; the explicit values are
the escape hatch when that guesses wrong.

**Boot race.** `context.preferences.values.<key>` is a synchronous, permission-free read off a
frozen snapshot, but that snapshot can arrive empty. The view reads it, and on a missing
`apiBaseUrl` calls `await ctx.preferences.refresh()` once before concluding anything is
unconfigured — `preferences:read` is already declared for exactly this.

## 10. Error and empty states

Every message names the configured base URL, so a misconfiguration is self-evident.

| Condition | Detection | Message |
|---|---|---|
| Base URL unset | empty after `refresh()` | First-run state pointing at preferences — not an error |
| Unreachable | `net.fetch` **rejects** | "Can't reach Shepherd at `<baseUrl>`." |
| Unauthorized | resolves with `ok: false`, status 401 | "Shepherd rejected the token — check the extension preferences." |
| Other non-2xx | resolves with `ok: false` | Status code plus the base URL |
| Reachable, no sessions | 200, empty array | Ordinary empty state |

Two SDK properties shape this: `net.fetch` returns a **string** body (there is no `.json()`), and a
non-2xx **resolves** with `ok: false` rather than rejecting — so `ok` must be checked explicitly. A
rejection is not a diagnosis: the Rust error text is replaced with a generic `'fetch_url failed'`,
which is why the unreachable message names the URL instead of quoting the error. Every call passes
an explicit `timeout`.

Both reads sit outside Shepherd's first-run gate (`firstRunBlock()` guards only spawn/write paths),
so a fresh core returns empty collections rather than `409` — there is no first-run error state.

## 11. Testing

**Vitest**, sharing the existing Vite resolution and leaving the door open for component tests of
`SessionsView.svelte` later.

Unit tests over the pure layer:

- tier mapping for **every** code in the `HoldCode` union, plus a synthetic unknown code asserting
  tier 1 and generic copy (PRD S7)
- grouping and ordering against a fixture set covering all three sections (PRD S6)
- copy rendering for every code in both languages, including every `HoldParams` branch and the
  missing-param fallbacks (`round ?? "?"`, `steps ?? 1`, absent `pr`)
- deep-link URL building, including a `baseUrl` with and without a trailing slash
- error classification, driven by a fake `INetworkService` covering reject / `ok: false` 401 /
  `ok: false` 500 / malformed JSON body

Fixtures are derived from the real payloads captured on 2026-08-16, with session names, repo paths
and designations replaced by synthetic values — the shapes are what matter, and the real ones name
private work.

**Manual verification in the launcher** (nothing below can be automated without a running Asyar):

1. `npx asyar link`, enable the extension, open *Shepherd Sessions*.
2. Needs-you list matches the HUD's own hold lines for the same sessions (PRD S1).
3. `Enter` opens the browser on the right session (PRD S2) — and records which opener route worked.
4. Each error state, forced by: stopping the core, corrupting the token, clearing the base URL
   (PRD S5).

## 12. Deviations from the PRD, collected

| # | PRD said | This design does | Why |
|---|---|---|---|
| 1 | §7.4 write our own EN copy map | Lift EN **and** DE verbatim from `src/hold.ts` | The map already exists as pure functions; exact duplication beats a re-write |
| 2 | US-2 one Active list | Three sections, Done collapsed | 21 of 24 live sessions are `done`; one list buries the 3 in flight |
| 3 | D6 English throughout | `holdLanguage` preference, `auto` by default | The HUD is read in German; Asyar exposes no locale, so `auto` uses `navigator.language` |
| 4 | §7.5 pick one opener route | Ship both with fallback, delete the loser after the first run | Only a running launcher can decide; this design refuses to guess |

## 13. Risks

- **The tier table is ours** (§6). Mitigated by unknown → tier 1, and by being one small file.
- **`/api/holds` has no stability contract** (PRD R3). Mitigated by confining all Shepherd
  knowledge to `client.ts` + `types.ts`.
- **The minted token is full-parity** — it authenticates every gated surface including `/events`
  and `/pty/:id`, because per-token scopes are still open as
  [shepherd#2083](https://github.com/erwins-enkel/shepherd/issues/2083). A read-only extension
  holding a credential that could spawn sessions is more authority than it needs. Accepted for now;
  when #2083 lands, re-mint a read-scoped token and change nothing else here.
- **No third-party precedent for `searchable: true` with a worker `search()`** — deferred with the
  root-search work, so it cannot block this slice.
