# GUI — the web half of `dsh-vision-bridge`

The plugin's browser half. It adds one visible object to the harness Web UI and
never touches configuration.

## What it does

Below the composer card, a small **Vision inbox** pill shows how many images the
current project's inbox holds (`Images 3`, or just `Vision inbox` before the
first listing arrives). Clicking it opens a floating panel that:

1. **Status** — the inbox directory, the project directory, the configured vision
   route with whether it is usable (`routeReady` / `routeDetail`), the mounted
   vision sub-agents, and the configured tasks.
2. **Upload** — pick the image kind (`reference` = design/mockup, user-authored;
   `capture` = screenshot, app evidence), choose one or more PNG/JPEG/WebP/GIF
   files, and upload. Files are read with `FileReader.readAsDataURL`, the
   `data:<mime>;base64,` prefix is stripped, and each file is `POST`ed
   **sequentially**; after the batch the listing is re-fetched and read. Per-file
   success and failure lines are shown.
3. **Images** — grouped by zone, with name, human-readable size, a `folder` /
   `upload` source badge, the exact path as selectable text, and a **Copy path**
   button that confirms with a brief `Copied`. The agent needs the exact path, so
   the path is shown and copyable.
4. **Delete** — a **Remove…** button per image, deliberately honest: the plugin
   cannot delete (see limitations) and the refusal hint the host returns is shown
   verbatim.

The panel has explicit loading, empty, and error states; a failed fetch or a
missing route renders a message and a **Retry**, never a blank panel. When the
bridge is switched off in Settings, the listing still answers `200` with
`enabled: false`; the panel adds a **State: The bridge is disabled.** row, disables
the file input and the Upload button, and points at the settings form. Absent
listing data is *not* read as disabled, so nothing flashes off while loading.

Configuration is **not** in this panel. The harness's native settings form
renders this plugin's Config for free, and the footer points there:

> Configure the route, tasks, inbox and cache in Settings → Plugins → dsh-vision-bridge.

## Where it mounts

| Item | Value |
|---|---|
| Slot | `conversation.composer.dock` (`kind: list`, `scope: session`, `replaceRisk: none`) |
| Entry id / order | `dsh-vision-bridge` / `55` |
| Bundle id | `dsh-vision-bridge` (must equal the package name — the graph row id is what the registration is matched against) |
| Entry renders | one inline-flex row containing the pill (`<style>` element + `.dshvb-row` + `.dshvb-anchor` + button) |

The dock entry is the **only** in-flow element. The panel is
`ReactDOM.createPortal(panel, document.body)` with `position: fixed`, anchored
**above** the pill from `getBoundingClientRect()`, clamped to a 12 px viewport
margin, capped at `max-height: min(70vh, 520px)` with its own internal scroll. An
in-flow panel inside the dock row becomes part of the composer bar's height and
pushes the message box up the page; `position: fixed` inside the composer is
trapped too, because ancestors use `backdrop-filter`/`transform` and clip with
`overflow`. The portal is the fix, not a style preference.

Re-anchoring runs on window `resize` and capture-phase `scroll`, plus a
`ResizeObserver` on the panel, the pill, and the pill's row (the row can change
size without any window event). Dismissal is a `pointerdown` outside, a
capture-phase `click` outside, and `Escape` with focus returned to the pill.
Every listener/observer is removed by the effect's cleanup.

The bundle is plain JavaScript with **no build step**: `client.js` is served as
the package's `./client` export and evaluated raw as a classic script. Its only
module requests are the shell's frozen platform entries `react` and `react-dom`;
styles ride the component as a React `<style>` element, so unmounting removes
them.

## Route contract (frozen; the host implements exactly this)

All JSON, same-origin, relative `fetch`.

```
GET /dsh-vision-bridge/inbox?session=<sessionId>
  200 {
    enabled: boolean, projectDir: string, inbox: string,
    route: string,            // "provider/model", "" when unset
    routeReady: boolean, routeDetail: string,
    agents: string, tasks: string[],
    zones: { reference: string, capture: string },
    uploadsSupported: boolean,
    images: Array<{ zone: 'reference'|'capture', name, path, bytes, source: 'folder'|'upload' }>,
    canDelete: false, deleteHint: string
  }

POST /dsh-vision-bridge/upload
  { session?: string, zone: 'reference'|'capture', name: string, data: string /* base64, no "data:" prefix */ }
  → 200 { ok: true, zone, name, path, bytes, mediaType, sha256 }
  → 400 invalid body/zone/name/base64/not an image/extension mismatch/empty
  → 403 cross-origin, or the bridge is disabled (`enabled: false`)
  → 409 name exists   → 413 too large
  → 503 no attachment store mounted in this profile   → 405 non-POST

POST /dsh-vision-bridge/remove
  { session?: string, path: string }
  → 501 { ok: false, error, path, hint }   // ALWAYS
  → 400 invalid body   → 403 cross-origin   → 405 non-POST
```

Errors are `{ ok: false, error: string, hint?: string }`; the UI renders `hint`
verbatim.

## Verifying it in the browser

What an agent session *can* verify was verified live on 2026-10-13: the bundle is
served and executed — `cordis_inspect_query` client `Slots.listSubTree` on
`conversation.composer.dock` lists the occupant `dsh-vision-bridge` (order 55,
`active: true`), in a page that was already open. **A registered occupant is not a
registered route**, though: the same session measured
`GET /dsh-vision-bridge/inbox` → **404** while the routes were missing (I-4). How the
panel **looks and behaves** is still a user checkpoint (`docs/SPEC.md` §8: "The GUI shows
and uploads — user checkpoint"). To check it:

1. Reload the harness Web UI at its usual URL (a hard refresh, so the new
   `client.js` is fetched). Watch the browser console: a registration failure
   logs `client-modules: bundle … loaded without registering "dsh-vision-bridge"
   via __ModuleLoader__.load`.
2. Below the composer, the `Vision inbox` / `Images N` pill should appear beside
   the shipped stats pills. Clicking it opens the panel **above** the pill; the
   message box and bottom bar must not move. Scroll the transcript and resize the
   window with the panel open — it must stay anchored and inside the viewport.
3. Read the host payload directly in a tab:
   `http://127.0.0.1:3080/dsh-vision-bridge/inbox` (add `?session=<id>` if
   needed). Compare its `images` array with the panel's list.
   **Diagnostic:** a **404 here means the routes are not registered** — not that the
   panel failed to render. The discriminator is the pair: `/dsh-vision-bridge/inbox` →
   404 while `GET /` → 401 is the auth-gated SPA fallback, i.e. the web server matched
   no named route. The routes appear only once the **fixed module is live** (the next
   harness start; a GUI toggle does not re-import a cached module — I-4). The
   registered-occupant check does **not** prove the routes exist.
4. Upload a PNG in each zone and confirm the file appears in the zone directory
   shown in the panel and in the next `inbox` response.
5. Press `Escape` and click outside: the panel closes, focus returns to the pill.
6. Turn `enabled` off in Settings → Plugins → dsh-vision-bridge, reload the panel:
   the **State** row must appear, the file input and Upload button must be
   disabled, and a `curl`-style `POST /dsh-vision-bridge/upload` must answer `403`
   without committing anything. Turn it back on.

There is no build step to run and no bundle artifact to rebuild. The package is
mounted through a **junction**, so editing `client.js` takes effect in the running
page (hard-refresh if it looks stale). Editing host `src/*.ts` needs the **next harness
start**: a GUI toggle off/on re-applies the row and re-runs `apply()`, but it does not
re-import the cached module, so the new source is not what runs (measured 2026-10-13,
I-4). Do **not** reinstall this plugin with `install_bundle`: a `file:` spec
installs a pnpm-injected snapshot copy that later edits never reach
(`docs/incidents/2026-10-13-install-injection-snapshot.md`).

## Honest limitations

- **English-only strings.** All user-visible copy lives in one frozen `STRINGS`
  object at the top of the factory, so localization is a later mechanical change;
  v1 ships hardcoded English and does **not** use the client locale service.
- **Delete is a refusal, not a feature.** The mounted filesystem service has no
  delete/unlink primitive and the attachment store is immutable, so
  `POST /dsh-vision-bridge/remove` always answers `501` with a hint. The UI shows
  the `Remove…` affordance anyway — hiding it would be a lie — and displays the
  returned `hint` verbatim so the user knows to remove the file themselves. The
  listing's `deleteHint` is shown before the click as well.
- **The panel is a view/upload surface only.** The route, tasks, inbox root and
  cache settings are rendered by the harness's native settings form (Settings →
  Plugins → dsh-vision-bridge). Duplicating those inputs here would create a
  second source of truth.
- **Only `react` and `react-dom` are requested.** Everything else is plain
  browser API; the panel deliberately does not depend on
  `@deepseek-ai/dsh-client-ui-primitives`, so the trigger-anchored placement and
  outside-dismissal hooks are reimplemented locally (modelled on
  `useAnchoredPosition` / `useDismissOnOutsidePointer`).
- **Rendered appearance was not verified by the agent.** No browser control was
  available in the authoring session; the contract, syntax, and manifest are
  checked, the visuals are not.
- **Contract drift to reconcile:** `docs/SPEC.md` §5.4 still lists the earlier
  `/status` and `/list` routes; the frozen client contract implemented here is
  `/inbox`, `/upload`, `/remove`. The spec is user-approved and was not rewritten
  by the client work. Both interface changes made after the spec are recorded in
  `docs/DEVIATIONS.md` (D-4: one listing instead of two routes; D-5: the disabled
  bridge is a `403` on upload and a rendered state in the panel).
- **`403` has two meanings on `upload`** — cross-origin and disabled — told apart
  by the message and `hint`, not by the status. The panel shows the message; a
  future second consumer should branch on something better (D-5).
