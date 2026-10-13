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

The plugin is a local folder; there is no registry package. Install it into the
running profile with the plugin manager's `install_bundle`, whose spec must be an
**absolute** local path:

```
plugin_manager  action: install_bundle
                target: file:D:\my_deepseek_harness\dsh-vision-bridge
```

Why install the package rather than add a `cordis.patch.yml` row: both work for the
host half, and both are *supposed* to work for the client half — the client registry
locates a row's owning `package.json` either through the resolved bare name or, for a
path-like row, by walking up from the module
(`packages/client/modules/src/index.ts:871-905`), and the target tests exactly that
for a `file:` URL row (`packages/client/modules/tests/node-half.client.spec.ts:326-338`).
Installing is the **proven** path: the sibling `dsh-autocompact` install in this
profile mounted a bare-name row through a profile junction and its client bundle was
verified in the live boot graph (`clientModules.clientPath` returned the bundle).
The `file://`-row route is unverified live here, and the plugin's own
`cordis.patch.yml` (used by `install_bundle`) carries the bare package name for that
reason. See `docs/INCIDENT-INDEX.md` → I-1 for the corrected claim.

Delivery semantics after installing:

| Change | When it takes effect |
|---|---|
| The plugin row and its links | Immediately (live profile) |
| `Config` (Settings → Plugins → dsh-vision-bridge) | Immediately — the groups are volatile |
| `client.js` (the panel) | Next page load — hard-refresh the Web UI |
| Host `src/*.ts` | Next harness start |

The panel is the only half that needs a refresh; the tools are usable as soon as
the row is live.

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
5. **The browser rendering is unverified.** The client bundle parses, registers its
   slot, and is contract-tested (25 tests), but no automated browser check of the
   panel has been run — it is a user checkpoint.
6. **The panel needs a page refresh** to appear after install; the host half does
   not.
7. **A vision route is required.** With `route` unset, `describe_image` fails with
   a clear message rather than falling back to a route that cannot see.
8. **Plugin routes are not behind the GUI session gate** (see §5).

## 7. Verify

```powershell
# Unit + contract tests (11 files / 280 tests)
& 'D:\deepseek-harness_2\node_modules\.bin\vitest.CMD' run

# Type check
& 'D:\deepseek_harness_2\node_modules\.bin\tsc.CMD' -p 'D:\my_deepseek_harness\dsh-vision-bridge\tsconfig.json' --noEmit

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
