# dsh-vision-bridge

Let a **text-only** DSH model work with images.

The agent you are talking to may run on a route that accepts no image input at all.
The harness is honest about that: images are refused at four separate gates (prompt
admission, the `read_image` route check, sub-agent delivery, and MCP/ACP tool
results). This plugin does not bypass any of them. It **mirrors** them: it asks a
*second* route that does declare image input to describe the image in words, and
hands the agent text.

Two actors use it, and they are equal citizens:

- **You** upload a design, mockup, logo, or screenshot through a panel in the
  composer, into a **per-project** inbox.
- **The agent** lists that inbox, describes an image on demand, and — for UI work —
  hands the whole job to a vision **sub-agent** that owns the image conversation.

Primary use case: **UI work**. The agent wants to see how the app actually looks —
layout, spacing, style, logos, live state — and you want to show it a custom design
you made elsewhere.

---

## 1. What you get

| Surface | What it is |
|---|---|
| `vision_inbox` tool | Lists the project inbox: which images exist, in which zone, the configured route, whether that route can really read images, and which vision sub-agents are mounted. |
| `describe_image` tool | Describes one image (or compares several) and returns the description as text, with the image digest, the task used, and whether a stored description was reused. |
| `vision_agent` / `vision_agent_fresh` tools | Hand a vision job to a mounted sub-agent that owns the image end-to-end. `_fresh` forces a new session instead of reusing a stored one. |
| Composer panel | A floating **Vision inbox** panel: status, upload, and the image list with a Copy-path button per image. |

## 2. Install

The plugin is a local folder; there is no registry package. The **verified** install
in this profile is a profile junction plus a patch row that names the package — the
same shape as the sibling `dsh-autocompact` install, and the shape that keeps the
source **live**:

```powershell
# 1. junction — no pnpm run, no change to the profile's package.json
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-vision-bridge" `
  -Target 'D:\my_deepseek_harness\dsh-vision-bridge'
```

```yaml
# 2. append to %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml (back it up first)
- insert:
    - id: dsh-vision-bridge
      name: 'dsh-vision-bridge'
```

**Verified live 2026-10-13** in this profile (`patchReload: live`): after the junction
and the row were added, `include:dsh-vision-bridge` reported `status: "schema"`, both
tools appeared in the live Host tool list, and the client half registered itself as an
occupant of `conversation.composer.dock` (id `dsh-vision-bridge`, order 55) in the
already-open page — no harness restart and no page refresh were needed. A GUI
disable → enable toggle re-applies the row live (`schema` → `inactive` → `schema`).
What that re-apply does **not** do is re-import the module: it re-runs `apply()` on the
**cached** module, so a change to this plugin's host `src/*.ts` reaches the running
harness only at the **next harness start** (measured 2026-10-13, I-4). Consequence for
the panel: its routes are served only once the fixed module is live — until then every
request under `/dsh-vision-bridge/` answers 404 even though the plugin looks applied.

### Do not develop against `install_bundle`

`plugin_manager install_bundle` with an absolute `file:` spec **does** work (exit 0,
the row composes, `list_bundles` shows it `installed: true`), but pnpm installs a
`file:` dependency by **injection**: `node_modules\dsh-vision-bridge` becomes a
hard-linked *snapshot copy* (the profile's `.modules.yaml` records it under
`injectedDeps`), not a link. A later source edit therefore never reaches the harness,
and running `install_bundle` again answers `changed:false` / pnpm "Already up to
date" without re-syncing the copy — you would be editing files the harness is not
running. Use `install_bundle` for a **frozen** release only; `remove_bundle` undoes it
cleanly (verified: profile `package.json` and `node_modules` return to their prior
state). The plugin still ships `cordis.patch.yml` as its bundle patch so that route
remains available. See `docs/INCIDENT-INDEX.md` → I-3.

Delivery semantics (junction + row):

| Change | When it takes effect |
|---|---|
| The plugin row and its links | Immediately on save (`patchReload: live`) |
| `Config` (Settings → Plugins → dsh-vision-bridge) | Immediately — the groups are volatile |
| `client.js` (the panel) | Immediately in a running page; hard-refresh if the panel looks stale |
| Host `src/*.ts` | On the next **harness start**. A GUI toggle off/on re-applies the row, but a re-apply re-runs `apply()` on the **cached** module — it does **not** re-import it (measured 2026-10-13, I-4), so the panel's routes stay unregistered until the fixed module is live |
| The two `vision_agent*` tools | Only when the row applies: they mount at apply time, and only if a route is configured. Set the route, then toggle the plugin off/on (or restart) to mount them. `describe_image` reads the route per call, so it works the moment the route is set. |

## 3. Configure — all of it from the GUI

Everything is configured in the harness's **native** Settings form (Settings →
Plugins → dsh-vision-bridge). The plugin's `Config` is volatile, so the harness
renders a validated form for it for free; the composer panel deliberately does
**not** duplicate these inputs.

| Group | Key | Default | Meaning |
|---|---|---|---|
| `enabled` | — | `true` | Master switch. When off, the panel still renders but reports a disabled state, and the tools refuse. |
| `inbox` | `root` | `.dsh/vision` | Inbox root, relative to the **project** directory. |
| `inbox` | `gitIgnore` | `true` | Whether the inbox is kept out of git. |
| `inbox` | `maxBytes` | `8388608` (8 MiB) | Largest single image the bridge will read or accept. |
| `inbox` | `formats` | `image/png, image/jpeg, image/webp, image/gif` | Media types accepted. |
| `route` | `provider` | `''` (unset) | Provider of the **vision** route. |
| `route` | `model` | `''` (unset) | Model of the vision route. |
| `route` | `maxTokens` | `2048` | Output budget per description. |
| `tasks` | `id` / `title` / `prompt` / `version` | `[]` | Your own description tasks, added to the five built-ins. |
| `cache` | `enabled` | `true` | Reuse a stored description when image, task, and route all match. |
| `cache` | `maxEntries` | `200` | Cache ceiling. |

The built-in tasks are `describe`, `ui-review`, `compare`, `extract-text`, and
`brand`; `vision_inbox` lists the effective set.

The **route** is the crux. Set `route.provider` and `route.model` to a route that
declares image input; on this machine the catalog offers e.g.
`deepseek-v4-flash-vision-exp`. `vision_inbox` and the panel both report
`routeReady` and the reason, so you can tell "unset" from "set but cannot read
images" without guessing. Reading the route is what keeps the mirror honest — the
bridge never claims a route can see when it cannot.

## 4. Use

**You, in the GUI.** Open the composer dock, pick the image kind
(**Design / mockup** = `reference/`, **Screenshot** = `capture/`), choose PNG/JPEG/
WebP/GIF files, and upload. Then hit **Copy path** on the image you mean and paste
it into your message. Uploads are validated (magic bytes, size cap, name rules,
containment) before anything is stored.

**The agent.** `vision_inbox` first when it does not know what you uploaded, then
`describe_image` with the reported path, or `vision_agent` when the job is
exploratory UI work that benefits from a dedicated session. A relative path
resolves against the project directory; `zone/name` also works.

Zones are real folders inside the inbox (`reference/`, `capture/`) so you can also
drop files in by hand. GUI uploads additionally land in the harness attachment
store (content-addressed and validated) with an index beside them, because the
plugin's filesystem service can write text only — never binary.

## 5. Security posture

The top risk is **prompt injection through pixels**: an image can contain text
that reads like an instruction. Therefore:

- Every description is wrapped as **untrusted data**, with an explicit caveat, and
  is never treated as a fact about the codebase. Colours, spacing, and fonts come
  from the CSS and tokens, not from the model's reading of a picture.
- The vision sub-agent is mounted with a tool allowlist of exactly
  `read` and `read_image` — it cannot write, run, or fetch.
- Uploads are validated before storage and contained inside the project inbox.
- Uploaded images are addressed by **re-derived** path and bytes, never by a path
  recorded in the index, so a hand-edited index cannot turn the bridge into a
  reader of arbitrary local files.
- The plugin's HTTP routes are **not** behind the GUI browser-auth gate. They
  carry a same-origin check (a request with an `Origin` whose host differs from
  `Host` is refused with 403; a missing `Origin` is allowed) and the endpoints are
  local-only. This is a documented gap, not a solved problem.

## 6. Known limitations

1. **No delete.** The plugin's filesystem service cannot remove a file, so the
   panel's Remove button is honestly disabled with a hint; delete from the inbox
   folder yourself. The `/remove` endpoint always answers `501`.
2. **Cache eviction is impossible today** for the same reason. When the cache is
   full, `describe_image` reports a note instead of silently evicting.
3. **Uploads need an attachment store** that exposes a host path. Without one, the
   panel says uploads are unavailable (`503`) and hand-placed folder images still
   work.
4. **The route is read once at mount** for the sub-agents. A later `route` change
   reaches `describe_image` immediately, but the two `vision_agent*` children keep
   the route they were mounted with until the plugin reloads.
5. **The browser rendering is unverified.** The client bundle parses, is
   contract-tested (26 tests), and its live registration was confirmed 2026-10-13
   (slot occupant `dsh-vision-bridge`, order 55, `active: true`), but no automated
   browser check of how the panel *looks* has been run — it is a user checkpoint.
6. **The vision children mount only at apply time.** With the route unset they are
   absent by design (D-1); after setting it, toggle the plugin off/on in
   Settings → Plugins (or restart) to mount them.
7. **A vision route is required.** With `route` unset, `describe_image` fails with
   a clear message rather than falling back to a route that cannot see.
8. **Plugin routes are not behind the GUI session gate** (see §5).
9. **The panel's routes exist only once the fixed module is live.** The module is
   imported once per process, so the `8352710` fix reaches the running harness only at
   the **next harness start**; until then `GET /dsh-vision-bridge/inbox` answers **404**
   while `GET /` answers **401** (the auth-gated SPA fallback) — the routes were never
   *registered*, which is not a rendering failure. The panel once looked healthy on every
   observable surface (Config `status: "schema"`, both tools mounted, the client occupant
   registered) while every route 404'd, because an optional service read as a bare
   property **throws** (`cannot get property "webServer" without inject`) and a
   `catch { return undefined }` turned that host rule into "service absent". An optional
   service is read with `ctx.get(name)` plus an undefined check, or consumed through
   `ctx.inject([...], …)` — never as a bare property, never behind a swallow.
   See `docs/INCIDENT-INDEX.md` → I-4.

## 7. Verify

```powershell
# Unit + contract tests (12 files / 295 tests) — workdir = this plugin folder
& 'D:\deepseek-harness_2\node_modules\.bin\vitest.CMD' run

# Type check
& 'D:\deepseek-harness_2\node_modules\.bin\tsc.CMD' -p 'D:\my_deepseek_harness\dsh-vision-bridge\tsconfig.json' --noEmit

# Composition: the row mounts and resolves (workdir = the checkout)
node --import tsx/esm apps/cli/src/bin.ts --profile web --patch '<patch>' --dump-config
```

## 8. Documentation map

| Document | Job |
|---|---|
| `docs/PLAN.md` | The build plan and its steps |
| `docs/SPEC.md` | The approved design: the four gates, decisions D1–D6, the frozen HTTP contract, the acceptance matrix |
| `docs/VISION-AGENT.md` | Why the vision work is a sub-agent and not only a tool; the handoff medium; the four-call table |
| `docs/GUI.md` | The client half: mount point, path contract, browser steps, honest limits |
| `docs/DEVIATIONS.md` | Where the build deviates from the plan, and why |
| `docs/PLUGIN-GUIDE.md` | The reusable guide: what to copy for the next plugin, and the traps this one proved |
| `docs/INCIDENT-INDEX.md` | Index of the incidents this plugin produced |

## 9. License

See `LICENSE`.
