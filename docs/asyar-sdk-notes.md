# Asyar SDK — verified facts

What this project actually knows about the Asyar extension SDK, and how it knows it. Written
during issue #2 (scaffold + SDK verification); the facts here are what issues #3–#8 build on.

**Pins:** `asyar-sdk` **4.6.0** (npm) · launcher source read at `github.com/Xoshbin/asyar`
@ `a7277286` (launcher 0.1.1-41, matching the installed app) · Node 24.18.0 · npm 11.16.0 · vite 6.4.3 ·
svelte 5 · TypeScript 5.

Every entry is tagged:

| Tag | Meaning |
|---|---|
| **CONFIRMED** | Executed in this repository. Reproducible with the commands given. |
| **SOURCE-READ** | Read out of launcher or SDK source at the pinned commit. Not executed. |
| **UNVERIFIED** | Needs a running launcher session exercising the behaviour in question. Asyar **is** installed on this machine — `/Applications/Asyar.app` (release build `0.1.1-41`), app data at `~/Library/Application Support/org.asyar.app/` — and this extension **has** now been run against a live Shepherd core: the panel rendered twelve waiting sessions with their German hold copy, and pressing Enter on a row opened that session's terminal in the browser. What remains unverified is the surface added after that run — the launcher-search-bar filtering, the three in-view ⌘K actions, and the clipboard write. |

> The Asyar tutorials are stale and do not build. Trust order for anything not settled here:
> **launcher/SDK source → shipped third-party extensions → docs.**

## Build output

**CONFIRMED.** `npx vite build` in the project root emits:

```
dist/view.html      dist/view.js                      entry, role "view"
dist/worker.html    dist/worker.js                    entry, role "worker"
dist/assets/view-<hash>.css                           view-only styles
dist/assets/ExtensionContext-<hash>.js                view-only chunk
dist/assets/manifest-<hash>.js                        chunk shared by BOTH entries
```

Only the two entry names are stable — `entryFileNames: '[name].js'` in `vite.config.ts` keeps them
hash-free. Everything under `assets/` is content-hashed and its name will change.

This settles the open question from the spike brief: `background.main: "dist/worker.js"` names a
file that genuinely exists. It had only ever been inferred from the rollup config, never observed.
`npx asyar build` also passes and prints the same file list.

### Standing check: role assertions must not enter the shared chunk

**CONFIRMED, and it must be re-checked whenever the two entries gain a shared import.**

`src/view.ts` and `src/worker.ts` both `import manifest from '../manifest.json'`, so Rollup emits a
chunk that `view.html` **and** `worker.html` load. `asyar-sdk/view` and `asyar-sdk/worker` each
throw at module load when `window.__ASYAR_ROLE__` does not match. If such an assertion were ever
hoisted into the shared chunk, the worker iframe would throw on every boot — with a message
pointing at the SDK rather than at our build.

Today it does not: each throw stays in its own entry, and the shared chunk only *reads* the global
in `resolveRole()` / `resolveRuntimeRole()`, falling back to `"view"` without throwing.

```sh
# chunks loaded by both HTML entries
comm -12 <(grep -oE '\./(assets/)?[A-Za-z0-9._-]+\.js' dist/view.html | sort -u) \
         <(grep -oE '\./(assets/)?[A-Za-z0-9._-]+\.js' dist/worker.html | sort -u)
# must print 0 for every chunk in that list
for f in $(find dist -name '*.js'); do echo "$(grep -c 'Imported outside a' "$f")  $f"; done
```

Corollary: modules shared between the two entries must take their types from
`asyar-sdk/contracts` only. The SDK's own `contracts.purity.test.ts` guarantees that entry resolves
with no DOM and no `__ASYAR_ROLE__` — which is also what lets the pure layer be unit-tested in
plain Node.

## Module resolution

**CONFIRMED.** The bare specifier `asyar-sdk` is **not importable**. `asyar-sdk@4.6.0`'s
`package.json` declares no `"."` key in its exports map; the only entries are:

| Specifier | Use |
|---|---|
| `asyar-sdk/view` | view-role entry — full SDK surface, DOM helpers, `ExtensionContext` |
| `asyar-sdk/worker` | worker-role entry — no DOM-dependent surface, keeps the bundle small |
| `asyar-sdk/contracts` | pure types + `messageBroker`; safe in shared modules |
| `asyar-sdk/tokens.css` | design tokens |

(The package sets `"main": "dist/index.js"`, but the exports map wins — that field is unreachable
for `import`.)

Design tokens actually shipped in `tokens.css` (**CONFIRMED**, read from the installed package):
`--space-1`…`--space-11`, `--font-size-2xs`…`--font-size-display`, `--font-ui`, `--font-mono`,
`--text-primary` / `--text-secondary` / `--text-tertiary`, `--bg-*`, `--accent-*`, `--radius-*`,
`--shadow-*`, `--border-color`, `--separator`. There is no `--spacing-md`, no `--color-text` and no
`--font-family`.

## Manifest

Two validators, and **neither one is the other's superset** — passing `asyar validate` does not
mean the launcher will accept the manifest.

### `asyar validate` (CLI, TypeScript)

**CONFIRMED** — passes for this project's `manifest.json`. Rules that actually bite
(**SOURCE-READ**, `asyar-sdk/dist/cli/lib/manifest.js`):

- `id` must match `/^[a-z][a-z0-9\-]*(\.[a-z][a-z0-9\-]*)+$/`. Hyphens *are* allowed by the CLI,
  though the docs' regex forbids them. This project's id is `dev.erwins-enkel.shepherd` — the
  reverse-DNS form of the owner's domain `erwins-enkel.dev`, hyphen included. Two things make that
  safe despite the docs: the CLI regex above accepts it (verified against the installed
  `manifest.js`), and the launcher itself never validates the id's charset — it only requires that
  `id` equals the on-disk directory name. The shipped `org.erwinsenkel.home-assistant` is further
  evidence that a hyphenated id loads. Prefer matching the real domain over appeasing a stale doc.
- `description` must be **10–200 characters**. Undocumented and easy to trip.
- `name` 2–50 characters; `version` valid semver; `author` required.
- `permissions[]` are checked against a closed 46-entry list. `storage` is **not** on it —
  see below.
- `schedule.intervalSeconds`: integer, **10 ≤ n ≤ 86400**, and only legal on `mode: "background"`.
- `mode: "view"` requires `component`.
- `searchable: true` requires `background.main`, which requires `worker.html` in the project root.
- Any view command requires `view.html` in the project root; either requires a `vite.config.ts`
  or `.js`.

The CLI does **not** reject unknown keys, and it never checks command `description`.

### The launcher (Rust, `extensions/mod.rs`)

**SOURCE-READ.** `ExtensionManifest`, `ExtensionCommand` and `BackgroundSpec` are
`#[serde(deny_unknown_fields)]` — one stray key fails discovery outright, with no help from
`asyar validate`. `PreferenceDeclaration` and `ScheduleDeclaration` are **not** strict, so extra
keys there are tolerated.

Legal top-level keys: `id`, `name`, `version`, `description`, `author`, `type`, `background`,
`searchable`, `icon`, `commands`, `permissions`, `permissionArgs`, `minAppVersion`, `asyarSdk`,
`platforms`, `preferences`, `actions`, `onboarding`, `tools`, `runtimes`.

Legal command keys: `id`, `name`, `description`, `trigger`, `mode`, `icon`, `component`,
`schedule`, `preferences`, `actions`, `arguments`, `requireAnyOf`, `searchBarAccessory`.

Conversely, Rust never inspects `permissions` at load — an invalid permission string is a
CLI-only failure. `id` must equal the on-disk directory name.

### Field notes

- **`description` on a `mode: "background"` command.** Rust defaults it and the CLI never checks
  it, but the SDK's TypeScript `ManifestCommand.description` is non-optional. Declaring it
  satisfies all three layers.
- **A `default` on a `textfield` preference is legal** (**CONFIRMED** — `asyar validate` passes
  with one). The CLI type-checks preference defaults only for `dropdown`, `number` and `checkbox`;
  Rust's `PreferenceDeclaration.default` is an untyped `serde_json::Value`.
- **`background.main` is a boolean flag in disguise.** The launcher uses it only to answer "does
  this extension have a worker?" — the string is never resolved as a path, and the worker iframe
  always loads `worker.html`. `"dist/worker.js"` is convention.

## Permissions

**SOURCE-READ**, `VALID_PERMISSIONS` in the CLI. Relevant to this project:

| String | Gates |
|---|---|
| `network` | `INetworkService.fetch` |
| `shell:open-url` | the raw `opener:open` wire command |
| `preferences:read` | `preferences.refresh()` / `getAll` |
| `storage:read`, `storage:write` | the cache (#6 declares these) |

`storage` **alone is not a valid permission string** and fails `asyar validate`. Also avoid
`store:read` / `store:write` — valid strings, but a different, undocumented subsystem.

`notifications:send` is deliberately never requested. Its absence is what makes the read-only
boundary structural rather than a matter of discipline.

## Runtime contracts (not exercised here)

**SOURCE-READ** unless noted. These are recorded because later issues depend on them; none has
been observed running.

- **Registration order is load-bearing.** `extensionBridge.registerManifest(manifest)` must precede
  `registerExtensionImplementation(id, impl)`. Out of order, the bridge logs a `console.error` and
  silently returns — the implementation is simply dropped. Both entries here do it in order.
- **SSRF gate.** `network/service.rs` rejects `localhost` (trailing dot included), loopback,
  RFC1918, link-local, unspecified, broadcast and any non-http(s) scheme, **before** DNS
  resolution. Hostnames are not resolved first, and `100.64/10` (Tailscale CGNAT) is not covered
  by Rust's `is_private()`. So a `*.ts.net` FQDN or a `100.x` address passes and
  `http://127.0.0.1:7330` cannot. This is why the `apiBaseUrl` preference's `placeholder` models a
  Tailnet FQDN (`https://host.example.ts.net:1234`) and its description warns against localhost.
  **CONFIRMED**, `manifest.json`: the preference is `required: true` with no `default` — the
  operator must supply their own Shepherd core URL; there is nothing to fall back to.
- **`net.fetch` returns a string body.** There is no `.json()`. Non-2xx **resolves** with
  `ok: false` — check it. Transport failures reject, but the Rust error text is replaced with a
  generic `'fetch_url failed'`, so a rejection is not a diagnosis. Always pass an explicit
  `timeout` (the layers disagree: 30000 / 25000+15000 / 20000).
- **There is no opener service.** No `IOpenerService`, no `OpenerServiceProxy`, and `opener` is in
  neither proxy bag — `ctx.getService('opener')` **throws**. `messageBroker.invoke('opener:open',
  { url })` under `shell:open-url` (undocumented) is the route this extension uses. The form
  documented in `troubleshooting.md` / `permissions.md`, with `url` at the top level of the
  postMessage, is a **silent no-op**: the router reads `data.payload`.
  **CONFIRMED** on a live launcher: pressing Enter on a session row opened its terminal in the
  browser, and the launcher log recorded
  ```
  Received message from iframe (dev.erwins-enkel.shepherd): asyar:api:opener:open
  [Main] Received IPC message from dev.erwins-enkel.shepherd: asyar:api:opener:open
  ```
  with no `browser:*` call following. The `getService<IBrowserService>('browser').openUrl(url)`
  fallback under `browser:tabs.write` that `src/opener.ts` used to try has been removed, along with
  the permission.
- **Root search is capped at 200 ms** for the whole extension-search round, even though the
  per-iframe request timeout is 5000 ms. `search()` must answer from cache; a live HTTP GET inside
  it will never appear. This is why #6 (poll + cache) blocks #7.
- **Settings → Advanced → "Extension Search" gates Tier 2 `search()` only, not commands.**
  **SOURCE-READ**, launcher source at the pinned commit:
  `asyar-launcher/src/services/extension/extensionSearchAggregator.ts` — `searchAll()` collects
  Tier 1 results (built-ins with a direct `search()` function) unconditionally, and only wraps the
  Tier 2 branch — sending a search request to a `searchable` extension's iframe — in
  `if (enableExtensionSearch)`. `asyar-launcher/src/services/search/searchOrchestrator.svelte.ts`
  calls `commands.mergedSearch(query, externalResults, 10)`, which merges the Rust-side command
  index with those external results; extension **commands** (like this project's `mode: "view"`
  "Shepherd Sessions") reach the search bar through that Rust index, not through `searchAll`, so
  they appear regardless of the toggle. `asyar-launcher/src/services/settings/settingsService.svelte.ts`
  confirms the default is `false`. This is a genuine prerequisite for the deferred root-search work
  (the `search()` call in `worker.ts`) — it is **not** a prerequisite for the panel command this
  slice ships. Previously filed under "Still unverified"; corrected after a source read, not a
  running launcher, so it stays SOURCE-READ rather than CONFIRMED.
- **`search()` results lose their `action`.** The SDK rebuilds each result across `postMessage`
  and drops the function even though the type marks it required. Use `actionId` +
  `actionPayload`, and register the handler **in the worker** — the launcher's Enter path falls
  back to `'worker'`.
- **Worker preference boot race.** `context.preferences.values.<key>` is a permission-free
  synchronous read off a frozen snapshot, but the worker's snapshot can arrive empty. The shipped
  `asyar-worldcup-extension`'s workaround is `await ctx.preferences.refresh()`, which is IPC and
  needs `preferences:read`. The facade has exactly `values`, `set`, `reset`, `refresh` — no index
  signature. (`context.preferences.greeting` in the scaffolding template is drift and does not
  work.)
- **The worker cannot navigate.** No `extensions` / `IExtensionManager` in the worker proxy bag;
  `navigateToView()` and `hideLauncher()` are view-only.
- **Iframe CSP** is `default-src asyar-extension: 'self'` — no external hosts, no CDN, and
  `window.fetch` / `XMLHttpRequest` are blocked. All network goes through `INetworkService`.

## Toolchain

**CONFIRMED.**

```sh
npm install
npx tsc --noEmit     # exit 0
npx vite build       # dist/view.html + dist/worker.html
npx asyar validate   # exit 0, "All checks passed"
```

- npm 11 blocks install scripts by default. `keytar@7.9.0` (an `asyar-sdk` dependency) and
  `esbuild` both report as blocked. **This does not matter**: `asyar validate`, `asyar build` and
  `vite build` all work, because esbuild ships prebuilt platform packages as optional deps and
  keytar is only needed for the CLI's publish auth. No `npm approve-scripts` step is required.
- `"types": ["svelte"]` in `tsconfig.json` is load-bearing — it supplies the ambient `*.svelte`
  module declaration, without which `tsc --noEmit` cannot resolve the component import.
- `resolveJsonModule` is required by `import manifest from '../manifest.json'` in both entries.
- The shipped extensions' `vite.config.ts` carries an `asyar-sdk/*` alias block that redirects to
  `../../asyar-sdk/src`. That is monorepo-only plumbing (they declare `"asyar-sdk": "workspace:*"`);
  consuming from npm, it computes an empty alias map, so it is deliberately absent here.

## Still unverified — needs a running launcher session with this extension attached

**UNVERIFIED.** Building and validating work without the launcher; importing and running do not.
Two operator steps unblock #5, #7 and #8:

1. Install and launch Asyar once so its app-data directory exists.
   - **Linux** (SOURCE-READ, upstream `install.sh`): `curl`s the AppImage to
     `~/.local/bin/asyar`; data lands in `~/.local/share/org.asyar.app/`. There is no
     package-manager route. (The tutorials' path, `~/.config/Asyar/extensions/`, is wrong.)
   - **macOS** (**CONFIRMED** on this machine): the app is `/Applications/Asyar.app`; its
     app-data directory is `~/Library/Application Support/org.asyar.app/`, confirmed present
     with `asyar_data.db`, `extensions/`, `dev_extensions.json`, `settings.dat`. This step is
     already done here — the installation method (DMG vs. otherwise) was not itself observed.
2. Attach this extension: **`asyar link --copy`**, not the bare `asyar link`. Done on this
   machine; the extension now sits as a real directory in the launcher's extensions folder.
   Restart Asyar afterwards — it scans that folder at startup, so anything linked while it is
   running stays invisible until the next launch (**CONFIRMED**: the launcher had started at
   21:13:27 and the link was created at 21:22:47; the extension did not appear until a restart).

### Adding a permission withholds *every* permission until the grant is re-reviewed

**CONFIRMED** by observation, explained by **SOURCE-READ** of `permissions.rs` and
`extensions/consent.rs`.

Granted permissions live in a consent record, and `register_extension_permissions` compares the
manifest's declared set against it. When the manifest declares **more** than the record covers, the
decision is `RegistrationDecision::WithholdNeedsConsent` — logged server-side as *"Withholding
permission registration for '<id>': declared permissions exceed recorded consent"* — and the
extension is registered with **no permissions at all**, not merely without the new one.

The failure therefore surfaces at whichever gated call runs first, with a misleading message. Adding
`clipboard:write` to this extension produced:

> `Permission denied: "preferences:read" is required but not declared in manifest.json`

`preferences:read` *was* declared, and had been granted. The wording comes from `pipeline.ts`'s
`permissionGate`, which prints that sentence whenever a permission is not allowed, whatever the
reason — the Rust side's real `reason` string is discarded when a `requiredPermission` is present.
So read this message as **"not granted"**, never as "not declared", and check the manifest before
believing it.

**Fix:** Settings → Extensions → the extension → **Review permissions** (a red *"Permissions need
review"* badge appears alongside it), then approve the new set. Expect to do this after every change
to `permissions[]`.

### `asyar link`'s default symlink mode cannot work on a release build

**CONFIRMED** by observation, explained by **SOURCE-READ** of `asyar-launcher/src-tauri/src/uri_schemes.rs`.

`asyar link` defaults to symlinking the project directory into the extensions folder
(`symlinkOrCopy` in `asyar-sdk/dist/cli/commands/link.js`); `--copy` copies `manifest.json` plus
`dist/` instead. The scheme handler resolves a request in this order — `extensions/<id>/dist/<file>`
first, then `extensions/<id>/<file>` — and then **canonicalizes** the hit and passes it through
`is_path_allowed()`. That function permits the app-data extensions directory, the Windows local-data
one, and any base path registered in `dev_extensions.json`. The rule that would permit an arbitrary
symlink target — commented in the source as "developer symlink targets like
`~/develop/extensions/my-ext/`" — sits behind `#[cfg(debug_assertions)]`, as does a catch-all
allow-everything; a release build falls through to `false`.

So on the shipped app, a symlinked extension returns **403** for `view.html` and `worker.html`.
Observed symptoms, both silent in the UI: the view command opens an empty window, and
`~/Library/Logs/org.asyar.app/asyar.log` records
`[workerRegistry] mount <id> token=N` followed ~3 s later by
`[workerRegistry] unmount <id> reason=timeout`. The timeout is emitted by the Rust ticker
(`extensions/extension_runtime/ticker.rs`) because the worker iframe never sent its
`asyar:extension:loaded` readiness message — it never loaded at all.

The launcher's log is the diagnostic of record here; nothing about this failure is visible in the
launcher window.

Open questions that only a running launcher can answer:

- Does the worker actually receive `preferences:set-all`, or is `refresh()` always needed?
- Does a cache-backed `search()` land inside the 200 ms cap?
- Is `asyarSdk: "^4.6.0"` accepted by the installed launcher's compat check? (Docs say `^2.7.0` /
  `^3.1.0`; shipped extensions say `^4.3.0`; npm latest is 4.6.0. Pinned provisionally.)
- Does the AppImage capture a global hotkey under Wayland/Hyprland?

**Largest standing risk:** no published third-party example of `searchable: true` with a worker
`search()` exists — every `searchable` manifest in the Asyar repo is a Tier 1 built-in on a
different code path. The `asyar:search:request` / `asyar:search:response` wire contract, the 200 ms
cap and the 5000 ms per-iframe timeout are undocumented implementation detail read out of source,
and can move without a docs change. #7 probes this with a throwaway command before the real search
is built on it.
