# Shepherd Sessions — Asyar extension

An [Asyar](https://asyar.org) launcher extension that answers one question in a keystroke:
**which of my [Shepherd](https://github.com/erwins-enkel/shepherd) sessions need me right now?**
Selecting a session opens the Shepherd HUD on it.

Read-only. It observes Shepherd and navigates to it; it never steers an agent. That boundary is
structural, not just a matter of discipline: `notifications:send` is deliberately never requested,
and the manifest declares no permission that could write back to a session.

## What it shows

| Section | Contents |
|---|---|
| **Needs you** | Sessions whose hold is critical (tier 1) or high (tier 2), most urgent first, longest wait first within a tier |
| **Active** | Sessions in flight, plus routine tier-3 holds such as `ready-merge` |
| **Done** | Finished sessions, collapsed |

A session is filed by its **hold** before its **status**. An agent that has finished its turn is
very often finished *because* it needs an answer — against the operator's live instance, 9 of the
12 sessions waiting on him had status `done` — so a `done` session with a blocking hold appears
under **Needs you**, not under **Done**. Trust the Needs you section, not the Done label, when
deciding what to look at first.

## Requirements

- Asyar installed, with the extension loaded (below).
- A reachable Shepherd core. **It must not be on `localhost`:** Asyar's SSRF gate rejects
  `localhost`, loopback, RFC1918 and link-local addresses *before* DNS resolution, so a core
  reachable only at `http://127.0.0.1:7330` cannot be used at all. Serve it over Tailscale and use
  the `*.ts.net` FQDN.
- Shepherd new enough to mint access tokens (the **Settings → Access** panel).

## Getting a token

The extension is a machine client, so it authenticates with a bearer token — the browser's session
cookie is `HttpOnly` and unavailable to it.

In Shepherd, open **Settings → Access**, create a token (name it after this client, e.g.
*"Asyar extension"*), and copy it. The value is shown **once**; Shepherd stores only a hash. If you
lose it, revoke the token and mint a new one.

A minted token currently has the same reach you do, including the web terminal — per-token scopes
are tracked upstream as [shepherd#2083](https://github.com/erwins-enkel/shepherd/issues/2083). When
those land, mint a read-scoped token and paste it in; nothing here has to change.

`SHEPHERD_TOKEN` in the core's environment also works, if your deployment provisions one.

## Install

```sh
npm install
npm run build
npx asyar link
```

Then enable the extension in Asyar and open its preferences:

| Preference | Value |
|---|---|
| **Shepherd API base URL** | Your core's URL, e.g. `https://host.example.ts.net:1234` — required, with no default |
| **API token** | The token from above |
| **Reason language** | `Auto` follows your system language; `English` / `Deutsch` override it |

The base URL preference has no default value on purpose: an earlier draft defaulted it to the same
string shown as the field's placeholder, which meant a fresh install silently resolved to a
non-empty (but useless) URL and showed "Can't reach Shepherd at …" instead of prompting you to set
one. Until you fill it in, the panel shows a plain "set your base URL" message instead.

Preferences take effect the next time the panel opens — the launcher reloads the extension when
they change.

## Development

```sh
npm run check     # tsc --noEmit
npm test          # vitest run
npm run build     # vite build
npm run validate  # asyar validate
```

The pure layer (`src/shepherd/types.ts`, `tiers.ts`, `copy.ts`, `view-model.ts`) has no SDK or DOM
dependency and is unit-tested in plain Node — 55 tests across four `*.test.ts` files as of this
writing. `src/shepherd/client.ts` is the only module that knows Shepherd is an HTTP service.

The hold copy in `copy.ts` is lifted verbatim from Shepherd's own `src/hold.ts` so that a reason
read here is the same sentence as in the HUD. The tier table in `tiers.ts` is *not* upstream —
Shepherd's `SIGNAL_TIER` is keyed by a different vocabulary — which is why an unrecognised hold code
degrades to tier 1 with generic copy rather than disappearing.

**Opening a session — two routes, both still shipped.** Asyar exposes no typed opener service.
`src/opener.ts` tries an undocumented message-broker call (`opener:open`, under the
`shell:open-url` permission) and falls back to the SDK's typed browser service (`browser.openUrl`,
under `browser:tabs.write`) if that doesn't answer within 3 seconds. Both permissions are still
declared in `manifest.json` because only a live launcher run can show which route actually opens
the browser; once that's known, the losing route and its permission should be deleted so the
manifest asks for no more access than the extension uses.

## Not in this version

Root search (typing `TASK-42` straight into the Asyar root), the background poll and its cache, and
any way to reply to or steer a session. These three are one unit of work: root search can't answer
live because the launcher caps a whole extension-search round at 200 ms, so it needs the poll's
cache, which needs the poll. Notifications are deliberately absent: Shepherd's web push already
covers "tell me when something changes", and `notifications:send` is never requested.

## Design notes

- `docs/PRD.md` — the product requirements
- `docs/superpowers/specs/2026-08-16-sessions-panel-design.md` — this slice's design
- `docs/asyar-sdk-notes.md` — verified facts about the Asyar SDK, with evidence
