# PRD — Shepherd Sessions for Asyar

**Status:** draft, pre-implementation
**Date:** 2026-08-05
**Owner:** Kai Osthoff

## 1. Summary

An [Asyar](https://asyar.org) launcher extension that answers one question in a keystroke:
**which of my Shepherd sessions need me right now, and which are still running?** Selecting a
session opens the Shepherd HUD directly on that session.

v1 is strictly read-only: it observes Shepherd and navigates to it. It never steers an agent.

## 2. Problem

Shepherd runs many `claude`/`codex` sessions in parallel. Each one periodically stops and waits on
the operator — a permission menu, an unanswered plan question, red CI, a merge conflict, an
un-acked manual step. Shepherd already classifies these states precisely (`explainHold()` in
`src/rundown-core.ts`), surfaces them in the HUD, and pushes them to a phone.

What is missing is the **desktop-keyboard path**. Today, finding out whether an agent is waiting
means: leave the editor → find or open the browser tab → wait for the HUD to load → visually scan
the herd → click the session. That is a context switch measured in seconds and attention, repeated
dozens of times a day, and it is exactly the interaction a launcher exists to collapse.

Consequences today:

- **Idle agents.** A session that hit a yes/no prompt sits blocked until the next manual HUD check.
  Wall-clock is lost on a question that takes two seconds to answer.
- **Attention tax.** The operator keeps a mental model of "who might be waiting" because checking
  is expensive. The mental model is what should be replaced.
- **Phone-only push.** Shepherd's web push reaches the phone. At the desk, the phone is the wrong
  device and the wrong interaction.

## 3. Goals

| # | Goal | Measured by |
|---|------|-------------|
| G1 | Show, on one keystroke, every session that is waiting on the operator, with the concrete reason | Panel opens and renders the grouped list |
| G2 | Land on the right session in one more keystroke | `Enter` opens `<baseUrl>/?session=<id>` in the default browser |
| G3 | Find a known session by name or designation without opening the panel | Typing `TASK-42` in the Asyar root surfaces it as a result |
| G4 | Never invent state — reuse Shepherd's own classification verbatim | Reasons come from `GET /api/holds`, not from a re-derivation |
| G5 | Fail legibly when the core is unreachable or unauthorized | Distinct, actionable empty/error states for offline, 401, misconfigured |

## 4. Non-goals

- **NG1** Steering sessions (reply, interrupt, plan release, ready-to-merge) — v1 is read-only.
- **NG2** Creating sessions or filing tasks. Shepherd's Chrome extension (`extension/` in the
  Shepherd repo) already owns capture-and-file.
- **NG3** Launcher badges and OS notifications. Shepherd's web push already covers "tell me when
  something changes"; duplicating it on the desktop creates double pings, so `notifications:send`
  is never requested. A *silent* background poll is unavoidable and in scope — the launcher caps a
  whole extension-search round at 200 ms, so root search can only answer from a pre-filled cache
  (see D2) — but it stays silent: it fills a cache and raises nothing.
- **NG4** Rendering the terminal, diff, or transcript inside Asyar. The HUD is the place for that.
- **NG5** Multiple Shepherd cores. Exactly one configured instance.
- **NG6** The Up Next / backlog feed (`GET /api/up-next`) — startable issues, not sessions.

## 5. Target audience

**Primary — the Shepherd operator (single user, initially the author).** Runs 3–15 parallel agent
sessions across several repos on a self-hosted Shepherd core, reachable over Tailscale at a
`*.ts.net` FQDN. It must be Tailscale-reachable: Asyar's SSRF gate rejects `localhost`, loopback
and RFC1918 addresses before DNS resolution, so a core that is only reachable at `localhost:7330`
cannot be used from the extension at all (see §7.5). Lives in a keyboard-driven desktop with Asyar
bound to a global hotkey. Technical enough to paste a bearer token into a preferences field.

**Secondary — other self-hosting Shepherd users** who also run Asyar. They shape the requirement
that nothing is hardcoded to one host, port, or token, but they are not a v1 distribution target.

**Explicitly not the audience:** Shepherd's phone/mobile users, and non-Asyar launcher users
(Raycast, Alfred). The extension may later port, but no abstraction is built for that now.

## 6. User stories

### US-1 — See who is waiting on me

> As the operator, I open Asyar, type `shepherd`, and see every session that needs me, grouped and
> ordered by urgency, each with the concrete reason.

**Acceptance criteria**

- The **Needs you** section lists every active session whose hold code maps to tier 1 or 2
  (see §7.3), ordered tier 1 before tier 2, and within a tier oldest `updatedAt` first.
- Each row shows: designation (`TASK-42`), session name, repo basename, and the hold reason
  rendered as a human sentence (e.g. *"CI is failing on PR #118 — needs a fix."*).
- The section header carries the count.
- With zero waiting sessions the section is replaced by an explicit "Nothing needs you" state — not
  an empty list.

### US-2 — See what is running

> As the operator, I glance at the same panel to see which sessions are in flight, so I know what
> is cooking without having to open the HUD.

**Acceptance criteria**

- The **Active** section lists all remaining non-archived sessions (status `running`, `idle`,
  `done`, and tier-3 holds such as `ready-merge` / `merging`), ordered by `updatedAt` descending.
- Each row shows designation, name, repo basename, status, and elapsed time since `updatedAt`.
- A tier-3 hold is rendered as the row's subtitle instead of the bare status.

### US-3 — Land on the session

> As the operator, I press `Enter` on any row and land in the Shepherd HUD with that session
> already selected.

**Acceptance criteria**

- `Enter` opens `<baseUrl>/?session=<sessionId>` in the default browser and closes the launcher.
- The HUD selects the session on load (existing behaviour — `ui/src/routes/+page.svelte` reads the
  `session` query parameter).
- An already-open HUD tab is reused by the browser where the OS/browser allows it; correctness does
  not depend on it.

### US-4 — Jump by name from the root search

> As the operator, I type `TASK-42` (or part of a session name) straight into the Asyar root and
> the session appears as a result; `Enter` jumps to it.

**Acceptance criteria**

- The extension declares `searchable: true` and forwards root queries to its worker.
- A query matches against `desig`, `name`, and repo basename via the launcher's ranker
  (`SearchService`).
- Result subtitles carry the same hold reason / status text as the panel.

### US-5 — Understand why nothing is showing

> As the operator, when the core is down or my token is wrong, I want to be told which of the two
> it is, not shown an empty list.

**Acceptance criteria**

- Connection refused / DNS failure → *"Can't reach Shepherd at `<baseUrl>`."*
- `401` → *"Shepherd rejected the token — check the extension preferences."*
- Unset base URL → a first-run state pointing at the preferences, not an error.
- A reachable core with no active sessions → the ordinary empty state, **not** an error.
- Every error state names the configured base URL so the misconfiguration is self-evident.

Note: both reads are outside Shepherd's first-run gate — `firstRunBlock()` in `src/server.ts`
guards only spawn/write paths — so a freshly installed core with no workspace picked returns empty
collections rather than `409 first_run_pending`. There is no first-run error state to build.

### US-6 — Point it at my core

> As the operator, I set the base URL and an optional bearer token once, in the extension's
> preferences.

**Acceptance criteria**

- `baseUrl` (required, default `https://host.example.ts.net:1234`) and `token` (optional,
  password-type). The default is a Tailnet FQDN, not `http://localhost:7330` — see §7.5; a
  loopback default could never resolve.
- The token, when set, is sent as `Authorization: Bearer <token>` on every request.
- Changing preferences takes effect on the next panel open — no launcher restart.

## 7. System context

### 7.1 Data sources (existing Shepherd HTTP API — no server change required)

| Call | Returns | Used for |
|------|---------|----------|
| `GET /api/sessions` | `Session[]`, all rows with `status != 'archived'`, ordered by `createdAt` | Row identity: `id`, `desig`, `name`, `repoPath`, `status`, `updatedAt`, `agentProvider` |
| `GET /api/holds` | `Record<sessionId, HoldReason>` where `HoldReason = { code: HoldCode, params?: HoldParams }` | The reason a session needs the operator, and its grouping tier |

Both are plain authenticated GETs served by `src/server.ts` (`handleSessionReads`,
`handleHoldsSnapshot`). The two are fetched in parallel on every panel open and joined on session
id; a session with no hold entry is simply un-held. **No WebSocket subscription in v1** — the
`/events` stream exists but on-demand snapshots are sufficient and far cheaper.

### 7.2 Authentication

Shepherd is gated by default. Browser clients use a session cookie; machine clients must send
`Authorization: Bearer $SHEPHERD_TOKEN` (see `docs/external-task-api.md` in the Shepherd repo). The
extension is a machine client. Requests carry no `Origin` header, so the CSRF origin guard does not
apply, and all reads are `GET` anyway — the guard only runs on POST/PUT/DELETE.

### 7.3 Hold-code → tier mapping

`GET /api/holds` returns the code of the *primary* signal. Tiers are Shepherd's own, from
`SIGNAL_TIER` in `src/rundown-core.ts`, expanded here to hold codes:

| Tier | Meaning | Hold codes |
|------|---------|-----------|
| 1 — critical | Forward progress is blocked on the operator | `halted-error`, `blocked-menu`, `blocked-yes-no`, `blocked-awaiting-input`, `blocked-stall`, `blocked-generic`, `quota-rework`, `quota-review`, `quota-error`, `quota-plan`, `autopilot-paused`, `plan-rework`, `plan-question`, `critic-rework`, `ci-red`, `pr-conflict`, `manual-steps` |
| 2 — high | Needs a look soon | `halted-usage`, `awaiting-merge`, `stalled`, `recap-attention`, `train-error` |
| 3 — normal | Routine in-flight state | `ready-merge`, `merging`, `merge-rebasing` |

Tiers 1 and 2 populate **Needs you**; tier 3 stays in **Active** with its reason as subtitle.

An unrecognised hold code (Shepherd adds one) must degrade to tier 1 with generic copy — *"Needs
you."* — never be dropped. Surfacing a slightly vague reason is correct; silently hiding a waiting
session is not.

### 7.4 Reason copy

The API returns `{ code, params }`, not rendered text — Shepherd's HUD localizes via paraglide
(`m.hold_<code>()`), the server via `renderHold()` in `src/hold.ts`. The extension therefore ships
its own English copy map keyed by `HoldCode`, interpolating `HoldParams` (`pr`, `findings`,
`round`/`cap`, `steps`, `resetAt`, `question`). This is a deliberate duplication; see R2.

### 7.5 Asyar surface

- One extension, `type: "extension"`, with `background.main` (the worker) and `searchable: true`.
- One `mode: "view"` command — *Shepherd Sessions* — rendering the grouped list.
- Permissions: `network` (reach the core), plus one of the two URL-open routes below, plus
  `preferences:read`. The cache adds `storage:read` / `storage:write`. **`storage` on its own is
  not a valid permission string** and fails `asyar validate`; the valid strings are `storage:read`
  and `storage:write`. `notifications:send` is explicitly **not** requested, per NG3 — and its
  absence is what makes the read-only boundary structural rather than a matter of discipline.
- **Opening a URL (A1 corrected).** There is no typed opener service — no `IOpenerService`, no
  proxy in either bag, so `ctx.getService('opener')` throws. Two routes actually work:
  `messageBroker.invoke('opener:open', { url })` under `shell:open-url` (real, but undocumented),
  or `getService<IBrowserService>('browser').openUrl(url)` under `browser:tabs.write` (documented
  and typed, but it prefers a paired browser companion over the OS default). Picking one is an
  explicit deliverable of the panel work; both permissions are declared until then.
- **Reading preferences (A1 clause 2, amended).** `context.preferences.values.<key>` is a
  synchronous, permission-free read off a frozen boot snapshot — the manifest declaration *is* the
  authorization. But the worker's snapshot can arrive empty, and the shipped workaround
  (`await ctx.preferences.refresh()`) is IPC and requires `preferences:read`.
- **The core must not be at `localhost`.** Asyar's SSRF gate rejects `localhost`, loopback,
  RFC1918, link-local and non-http(s) schemes before resolving DNS. A `*.ts.net` FQDN or a
  `100.64/10` Tailscale address passes; `http://127.0.0.1:7330` cannot.
- Preferences: `baseUrl`, `token`.
- Distribution: local install via `asyar dev` / `asyar build`. Store publication is out of scope.

Sources and evidence for all of the above: `docs/asyar-sdk-notes.md`.

## 8. Scope

### In scope (v1)

1. Asyar extension scaffold: manifest, worker, view command, preferences.
2. Shepherd client: authenticated parallel fetch of `/api/sessions` + `/api/holds`, joined into one
   view model.
3. Grouping and ordering per §7.3 and US-1/US-2.
4. Hold-code → English copy map with parameter interpolation and an unknown-code fallback.
5. Panel: two sections, counts, keyboard navigation, in-view filtering.
6. Root search contribution (`searchable: true`) over `desig`, `name`, repo basename.
7. Primary action: open `<baseUrl>/?session=<id>` in the default browser.
8. Error and empty states per US-5.
9. Unit tests for the pure layer: grouping, tier mapping, ordering, copy rendering, URL building,
   error classification.
10. `README.md` covering install, preferences, and how to obtain `SHEPHERD_TOKEN`.

### Out of scope (v1)

Everything in §4, plus: session detail/preview panes, secondary actions (open PR, copy repo or
worktree path), custom icons or theming beyond Asyar design tokens, localization (English only),
telemetry, and any change to the Shepherd repository.

## 9. Success criteria

The v1 is done when all of the following hold against a live Shepherd core:

| # | Criterion | How it is verified |
|---|-----------|--------------------|
| S1 | With ≥1 session in a tier-1 hold, the panel shows it under **Needs you** with the correct reason | Manual: put a session in a permission prompt, compare the panel line to the HUD's hold line |
| S2 | `Enter` on any row opens the browser at `<baseUrl>/?session=<id>` and the HUD has that session selected | Manual, both from the panel and from root search |
| S3 | Typing a designation in the Asyar root surfaces that session as a result | Manual with `TASK-<n>` and with a name fragment |
| S4 | Panel content is on screen ≤1.5 s after the command opens, on a warm core | Manual, wall-clock; the two GETs are in-memory snapshots server-side |
| S5 | Every failure mode of US-5 renders its distinct message | Manual: core stopped, wrong token, empty base URL |
| S6 | Ordering and grouping match §7.3 exactly for a fixture set covering every hold code | Automated unit tests |
| S7 | An unknown hold code lands in **Needs you** with generic copy rather than disappearing | Automated unit test with a synthetic code |
| S8 | While the panel is closed, Shepherd sees exactly one `/api/sessions` + `/api/holds` pair per scheduled tick (60 s) and nothing else | Manual: measure against Shepherd's request log over several minutes idle; record the observed frequency in `docs/asyar-sdk-notes.md` |
| S9 | No file in the Shepherd repository is modified or added by this work | `git diff` in the Shepherd checkout is empty; note it carries pre-existing untracked logs (`as2.err`, `as2.out`) that are not ours |

## 10. Decisions and assumptions

| # | Decision / assumption | Rationale |
|---|----------------------|-----------|
| D1 | Read-only v1 | Smallest surface that delivers the core value; no risk of mis-steering an agent from a fuzzy-matched list |
| D2 | Panel fetches on demand; a silent scheduled poll fills the root-search cache | The 200 ms extension-search cap makes a live fetch inside `search()` impossible, so the poll is a precondition for US-4, not an optimization. It notifies nothing — Shepherd's web push stays the only notification channel |
| D3 | Panel **and** root search | The root-search hit is the fastest path for a known session; the panel is the triage view |
| D4 | Single instance | Matches the actual deployment; multi-instance adds config UI, result merging, and per-instance error states for no present benefit |
| D5 | Reuse `/api/holds` rather than re-deriving attention | The classification is genuinely intricate (`classifyAttention`, ~25 codes, tiered precedence); duplicating it guarantees drift |
| D6 | English throughout | Consistent with Shepherd's own docs and with eventual Asyar-store publication |
| D7 | Preferences hold the base URL; no discovery | Assumed: the operator knows their core's URL. The choice is not free, though: Asyar's SSRF gate structurally rejects `localhost:7330`, so the URL must be a Tailnet FQDN or another non-private address |
| A1 | **Corrected.** Asyar exposes *no typed opener service* — `ctx.getService('opener')` throws. Two real routes exist, under different permissions; reading manifest-declared preferences needs no permission, but recovering from an empty worker snapshot does | Clause 1 was refuted by the SDK spike, clause 2 amended. See §7.5 for both routes and the `preferences:read` amendment. Which route wins is an explicit deliverable of the panel work |
| A2 | The Shepherd core is reachable from the machine running Asyar | Both run on the operator's desktop, or the core is Tailscale-served |
| A3 | `Session.updatedAt` is a usable freshness signal for ordering the Active list | It is what the HUD's own elapsed-time display is built on |

## 11. Risks

| # | Risk | Impact | Mitigation |
|---|------|--------|------------|
| R1 | Asyar SDK surface differs from the docs read during planning (e.g. the exact URL-opening service) | Implementation stall | Spike the SDK reference and a scaffold (`asyar dev`) as the first implementation step, before any Shepherd wiring |
| R2 | Hold-copy drift — Shepherd adds or renames a `HoldCode` and the extension's copy map goes stale | Rows show generic text | Unknown codes degrade to tier 1 + generic copy (S7); the map is one small file with a pointer to `src/types.ts` |
| R3 | `/api/holds` is an internal endpoint with no stability contract | A future Shepherd release breaks the extension | Accept for v1 (same operator owns both); the client isolates all Shepherd knowledge in one module so a change is a one-file fix |
| R4 | Token stored in Asyar preferences | Credential exposure on a compromised desktop | Password-type preference; the token grants no more than the browser cookie the same desktop already holds |
| R5 | A large herd makes the panel noisy | Triage value erodes | Ordering is urgency-first by construction; in-view filtering covers the rest. Revisit caps only if it actually bites |

## 12. Post-v1 candidates

Not commitments — recorded so v1 does not accidentally foreclose them: inline actions (reply,
interrupt, plan release), a launcher badge via a background schedule, secondary actions (open PR,
copy worktree path), Up Next / backlog integration, German localization, Asyar store publication.

## 13. References

**Asyar** — <https://asyar.org> was unreachable during research (HTTP 403), so the developer
reference was read from the canonical source repository, <https://github.com/Xoshbin/asyar>:
`docs/README.md`, `docs/reference/manifest.md`, `docs/reference/extension-types/README.md`,
`docs/reference/sdk/README.md`, `docs/reference/actions.md`, `docs/reference/background-scheduling.md`.
Those files back the manifest schema, the `view` / `background` command modes, `searchable`,
scheduling bounds, the permission names, the SDK service list (`SearchService`, `NetworkService`,
`StorageService`, `FeedbackService`), and the action/handler model quoted in §7.5. Not yet read, and
deliberately deferred to the implementation spike (A1, R1): `docs/tutorials/`,
`docs/reference/sdk/` per-service pages, and `docs/reference/permissions.md`.

That spike has since run against the launcher and SDK source, and its findings — including the
corrections to A1, D2, D7, NG3, S8 and §7.5 above — are recorded with their evidence in
`docs/asyar-sdk-notes.md`. Where the Asyar docs and the source disagree, the source wins; the
tutorials in particular are stale and do not build.

**Shepherd** — read from the working checkout at `/home/moe/projects/shepherd`: `src/server.ts`,
`src/store.ts`, `src/types.ts`, `src/rundown-core.ts`, `src/hold.ts`, `src/hold-service.ts`,
`src/ready-stage.ts`, `ui/src/routes/+page.svelte`, `ui/static/sw.js`, `docs/external-task-api.md`.
