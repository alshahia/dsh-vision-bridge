# I-4 — the panel route answered 404: an optional service read that throws, swallowed

- **Date:** 2026-10-13 (Baghdad)
- **Component:** `dsh-vision-bridge` `src/gui.ts` (`installVisionGui`), `src/service.ts` (`safeGet`)
- **Status:** fixed in `8352710`; live confirmation still needs the owed harness start
- **Severity:** high — the whole GUI half of the plugin was dead (every panel request 404), and
  the same defect class silently disabled two host features
- **Related:** I-1 (`file://` rows), I-3 (install injection), the harness's own "postmortem 0001"

## Symptom

The plugin was applied and healthy on every observable surface — host `Config.listConfigs`
returned `include:dsh-vision-bridge` with `status: "schema"`, both tools were in the live
`Tool.listTools`, and the client panel occupant was registered in
`conversation.composer.dock` (`id: dsh-vision-bridge`, `order: 55`, `active: true`) — yet:

```
GET http://127.0.0.1:3080/dsh-vision-bridge/inbox   -> 404
GET http://127.0.0.1:3080/                          -> 401   (SPA fallback, auth-gated)
```

`401` for the SPA index and `404` for the plugin path is the discriminator: the web server
matched **no named route** and handed the request to the fallback
(`packages/host/webserver/src/index.ts:390-406`). So the routes were never registered, not
merely unreachable.

## Root cause

`webServer` is an optional dependency of this plugin (a headless composition must still mount
the tools), so it is **not** in the plugin's `inject` list — and on this host a service that is
not injected cannot be read as a property:

```
Error: cannot get property "webServer" without inject
```

`installVisionGui` read it as `safeGet<WebServerLike>(ctx, 'webServer')`, and `safeGet` wrapped
the property read in `try { … } catch { return undefined }`. The host threw, `safeGet` reported
"absent", and `installVisionGui` took its legitimate-looking early return:

> `dsh-vision-bridge: no web server in this composition; the inbox panel is off and the tools are unaffected`

It was not a missing service — the live `webServer` service exists and listens on 3080. The
probe swallowed a *host rule violation* and turned it into a silent capability absence.

The same shape hid two more features, because `agents` and `attachments` are also read through
`safeGet` and are also not injected:

| read | silent effect before the fix |
|---|---|
| `safeGet(ctx, 'agents')` in `projectDirForSession` | every session fell back to the launch directory — the **per-project** inbox was not per-project |
| `safeGet(scopeCtx, 'attachments')` in the image reader | an uploaded image was never found in the attachment store |

This is a known harness trap, not a local curiosity: `packages/fs/tool-fs-search/tests/load-path.spec.ts`
exists solely to guard it, naming it "postmortem 0001", and the `webServer` service contract
documents the two forms explicitly — optional access is `ctx.get("webServer")` **with an
undefined check**, the hard form is `inject: ['webServer']` plus `ctx.webServer`.

## Evidence

Throwaway probe row mounted in the live profile (`.live-test/route-probe.mjs`, a self-contained
ESM module, mounted by absolute `file:///` URL and removed again immediately). It measured both
forms inside one real apply and wrote `.live-test/probe-report.json`:

```json
{
  "at": "2026-10-13T05:28:33.104Z",
  "bareRead": "unmeasured",
  "registered": ["injected"],
  "injected": "child-scope-present",
  "bareReadThrew": "Error: cannot get property \"webServer\" without inject",
  "injectReturned": true
}
```

and the same run over HTTP:

```
/dsh-route-probe/bare      -> 404      (bare read threw, so nothing was registered)
/dsh-route-probe/injected  -> 200 {"via":"injected"}   (ctx.inject(['webServer'], …) works live)
/dsh-vision-bridge/inbox   -> 404      (the plugin's own stale module)
```

Corroboration for the idiom — shipped code reaches the web server exactly this way:
`packages/client/modules/src/index.ts:653` (`ctx.inject(['webServer'], registerWebCarrier)`),
`packages/client/connection/src/index.ts:137` and `packages/api/gateway/src/index.ts:240`.

Profile patch backed up before the probe (`BCD515FCAE9800D1CCF470A559CC1796D4CEF738106626A0C32F16C61E41D49B`)
and restored byte-identically afterwards (same hash); probe routes 404 again after the restore.

## Fix (`8352710`)

- `installVisionGui` consumes the service through `ctx.inject(['webServer'], scope => …)` and
  registers on the child scope — the form the shipped web carrier uses. The direct read remains
  only as the structural fallback for contexts without `inject` (unit tests, hand-built hosts).
  The JSDoc states the rule so the next reader cannot "simplify" it back.
- `safeGet` now prefers `ctx.get(name)` — the sanctioned optional lookup — and falls back to the
  property read, which keeps ambient handles (`logger`) and structural contexts working. This
  restores `agents` and `attachments` as a side effect.
- Tests: four injected-path cases in `tests/gui.spec.ts` (including "the base context must not
  register directly") and a new `tests/service.spec.ts` (8 cases). Suite 12 files / 295 tests
  PASS, `tsc --noEmit` clean.

## Caveats and what still needs a harness start

1. **The fix is not live yet.** The running harness holds the *old* module: the GUI
   disable→enable toggle re-applies the patch generation, but an unchanged row keeps its fiber
   and its cached module, so a source change needs a harness start. Measured: after editing the
   source and toggling off/on, `/dsh-vision-bridge/inbox` still answered 404 — while the probe
   proved in the same profile that the pattern it uses answers 200.
2. **The probe proves the mechanism, not this call site.** The fixed `installVisionGui` itself is
   unit-tested against the injected path; the end-to-end live confirmation is the owed restart.
3. **A `file:///` row is only for a self-contained module.** Mounting this plugin by
   `file:///…/src/index.ts` made the entry disappear from the live composition (no
   `Config.listConfigs` entry, tools gone), while the same form worked for the probe's
   import-free `.mjs`. A package with bare imports must be mounted by package name through the
   profile `node_modules` junction (I-1 again, from the other side).
4. **Same defect in `dsh-autocompact`.** `GET /dsh-autocompact/status` answered 404 in the same
   session, from the identical `safeGet(ctx, 'webServer')` + bare read in its `installGuiBridge`.
   Its GUI indicator has therefore never registered its routes in this profile; the fix is the
   same three lines and is recorded in the workspace backlog.
5. The panel route stays outside the GUI browser-auth gate (401 is only the SPA fallback); the
   same-origin check in the upload handler is the only guard, as documented.
