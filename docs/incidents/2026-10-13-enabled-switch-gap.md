# The `enabled` switch gated the tools but not the GUI

- **Date:** 2026-10-13
- **Area:** `src/gui.ts` (upload route), `client.js` (panel), volatile `Config`
- **Status:** FIXED — commit `3753bbd`, 11 files / 283 tests PASS, `tsc --noEmit` exit 0

## Symptom

`Config.enabled` is the plugin's master switch and it was only half kept. With
`enabled: false`:

- `describe_image` and `vision_inbox` refused with
  *"the vision bridge is disabled; enable it in Settings -> Plugins -> dsh-vision-bridge"*
  (`src/index.ts:152-155`, via the throwing `scopeFor`), and
- the composer panel looked **fully operational**: it showed the images, an enabled
  file input, and an enabled Upload button — and an upload **succeeded**.

The listing already carried `enabled` (`src/gui.ts:298`), and the client already
received it; nothing read it. So the switch was visible in the payload and invisible
in the product.

## Why it matters

The panel is the surface the user configures and uses the plugin from. A switch that
turns off the tools but leaves a working-looking upload control is worse than no
switch: the user concludes the setting does not work, and a stale page, a bookmark, or
a hand-made request can still commit an image into an inbox they believe is off.

## Fix

Two halves, both small:

1. **Host** (`src/gui.ts`, upload handler, before the body is decoded or anything is
   committed): resolve the scope, and when `config.enabled` is false answer

   ```
   403 { ok: false, error: 'the vision bridge is disabled, so it will not accept an upload',
              hint: 'enable it in Settings -> Plugins -> dsh-vision-bridge' }
   ```

   The check sits after scope resolution (which is what reads the config) and before
   name/base64/byte validation, so a disabled bridge does no work and leaves no trace.

2. **Client** (`client.js`, `Panel`): `data.enabled === false` adds a
   **State — The bridge is disabled.** row to the status list, renders the
   `disabled` + `disabledHint` note under Upload, and disables both the file input and
   the Upload button (`disabled: … || !bridgeEnabled`).

Two smaller honesty rules came with it:

- The listing still answers **200 with `enabled: false`** — the panel needs the images
  and the route state to render a *useful* disabled surface, not a 500.
- **Absent listing data is not "disabled"** (`var bridgeEnabled = !data || data.enabled !== false`),
  so nothing flashes off while the panel is loading or after a failed fetch.

## Evidence

- `tests/gui.spec.ts` — *refuses an upload with 403 while the bridge is disabled*:
  asserts the 403, the message, the `Settings` hint, that `store.savedInputs` stayed
  empty, and that `uploads.json` was never created.
- `tests/gui.spec.ts` — *still lists the inbox while disabled, and says so*: 200,
  `enabled: false`, both seed images present.
- `tests/client.spec.ts` — *shows the master switch instead of offering controls that
  cannot work*: pins the four source expressions.
- Full suite 11 files / **283 tests** PASS (`VITEST_EXIT=0`); `tsc --noEmit` exit 0.

## Caveats

- `403` now has two meanings on `upload` — cross-origin and disabled — distinguished
  only by the message and `hint`. The panel shows the message and does not branch on
  the status, so this is safe today; recorded as D-5 in `docs/DEVIATIONS.md` with the
  note that a second consumer should get a distinct code.
- The disabled state is not a **route** for the host tools: `vision_inbox` still
  refuses when disabled, by design (the tool's contract is "this is off", not "here is
  a listing").
