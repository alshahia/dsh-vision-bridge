# Plugin guide — what `dsh-vision-bridge` hands to the next plugin

This is this project's **own** note. The universal, cross-project material lives in
`D:\my_deepseek_harness\dsh-plugin-playbook` (copy, no remote) and, authoritatively,
in `D:\my_deepseek_harness\deepseek_plugins\docs\best-practices\`. This file exists so
the next plugin can be built from *this* one without re-deriving it: read §2 for the
patterns, §3 for the traps, §4 for the copy list, §6 for the checks.

Read first: `README.md` (what it does) → `docs/SPEC.md` (the design and the four
gates) → this file.

---

## 1. What this plugin is, in one paragraph

A **host plugin plus a client panel** for a harness whose agent route accepts no
images. The host half owns per-project inbox folders, an upload index over the
harness attachment store, a description cache, three tools (`vision_inbox`,
`describe_image`, and two mounted vision sub-agents), and three HTTP routes. The
client half is one hand-written `client.js` that mounts a pill in the composer dock and
a floating panel. Configuration is entirely the harness's native settings form — the
panel deliberately renders no config inputs.

## 2. Reusable patterns (with the code that proves each)

| Pattern | Where | Why it is reusable |
|---|---|---|
| **A hand-written client bundle with no build step** | `client.js`; contract pinned by `tests/client.spec.ts` (26 tests) | `window.__ModuleLoader__.load({ id: '<package name>', factory })`, the `typeof window === 'undefined'` guard inside an IIFE (a classic script cannot have a top-level `return`), only `react`/`react-dom` as externals. Copy the shape, keep the tests. |
| **A floating panel that does not move the composer** | `client.js` (`createPortal(panel, document.body)` + `position: fixed`) | An in-flow dock child becomes part of the composer bar's height; `position: fixed` alone is still trapped by composer ancestors' `backdrop-filter`/`transform`/`overflow`. The portal is the fix. Re-anchor with a `ResizeObserver` on the panel, the pill, **and the pill's row** — the row can resize with no window event. |
| **A frozen HTTP contract, tested structurally** | `docs/GUI.md` §"Route contract"; `tests/gui.spec.ts` (41 tests) | `client.js` and the host are two artifacts with no shared type. Freeze the JSON in a doc, then test it with hand-rolled `fakeReq`/`fakeRes` objects — no server, no jsdom. |
| **Route handlers that cannot hang or leak** | `src/gui.ts` (`send`, `requestSignal`, `readJsonBody`, `crossOriginReason`) | `webServer.register({kind, path, handler})` has **no** JSON helper and does not consume a return value; duplicate `(kind,path)` **throws**; a request stream closes when its body is fully read, so abort must ride `res.on('close')`; cap the body incrementally and answer `413`. |
| **A volatile `Config` = a native settings form for free** | `src/config.ts` (5 volatile groups), `README.md` §3 | Volatility is the whole feature: the harness renders and validates the form. The panel must **not** duplicate those inputs — that is the second-source-of-truth trap. |
| **Binary assets through the attachment store, text state through `ctx.fs`** | `src/uploads.ts`; `docs/DEVIATIONS.md` D-3 | `ctx.fs` has `writeText`/`editText` only — no binary write, no `mkdir`, no delete. Commit bytes with `ctx.attachments.saveImage()`, keep a small text index, and **re-derive** the path (`imageHostPath`) and bytes (`readImage`) on every read. |
| **An intent-guarded append** | `src/uploads.ts:writeUploadIndex`, `appendUpload` | `FsWriteIntent` is `createIfAbsent` \| `replaceIfVersion`; omitting it overwrites unconditionally, and `createIfAbsent` refuses an existing target (`FS_NOT_OBSERVED`). An unparseable index is **refused**, never overwritten, so a user's history survives. |
| **Mounting a stock sub-agent from inside a plugin** | `src/child.ts` (calls the exported `apply` of `@deepseek-ai/dsh-tool-subagent` twice) | A patch row's `agentOptions` is static machine-specific config, and `modelSelectionSettings` **throws** on a standing row. Mounting from the plugin keeps the route in the settings form. See D-1. |
| **Treating model output about an image as untrusted data** | `src/prompts.ts` (`wrapUntrusted`), `src/child.ts` (`toolFilter.allow: ['read','read_image']`) | Pixels can carry instructions. Every description is wrapped with a caveat; the child cannot write, run, or fetch. |

## 3. Traps this plugin proved

1. **A `file://` patch row does NOT drop the client bundle** — the funnel guide said it
   did. `locatePkgJson` handles path-like rows by walking up to the owning
   `package.json` (`packages/client/modules/src/index.ts:871-905`), and the target tests
   it (`packages/client/modules/tests/node-half.client.spec.ts:326-338`). The proven
   live install is still a **package** install (`install_bundle` with an absolute
   `file:` spec). Full record: `docs/incidents/2026-10-13-file-url-row-client-bundle-claim.md`.
2. **A switch in `Config` is not a switch in the product.** `enabled` gated the tools
   and not the GUI: the panel looked live and the upload route committed. A user-facing
   flag needs a host check **and** a rendered state.
   Record: `docs/incidents/2026-10-13-enabled-switch-gap.md`.
3. **The client bundle is loaded per page, not per request.** `client.js` takes effect
   on the next page load; host `src/*.ts` needs the next harness **start**; a volatile
   config and a patch row are live. Never verify a client half by fetching
   `/plugins/<id>/client.js` — that URL 404s for every package, including shipped ones
   (playbook `2026-10-12-live-profile-install.md`).
4. **A structural test fake can pass for the wrong reason.** In `tests/gui.spec.ts` the
   fake `scopeFor` originally ignored its argument, so the "the session shapes the
   project directory" assertion could never fail. Resolve the layout **per call**
   inside the fake, as the plugin does.
5. **Assert against comment-stripped rows.** `tests/client.spec.ts` checks that
   `cordis.patch.yml` does not hardcode `agentOptions`; the patch's own *comment*
   explains the absence, so the raw text matched. Strip `#` lines before asserting.
6. **`isConcurrencySafe` soft-validates args.** A bare call returns `false` rather than
   throwing, so it cannot be used as an argument validator in a test.
7. **`defineTool`'s `parameters` DSL becomes JSON Schema.** A test that wants the
   *schema* must build it from `parameters.properties.x.type` / `parameters.required`,
   not from a JSON-Schema literal.

## 4. What to copy for the next plugin (order that works)

1. `README.md` §2's install path, then the skeleton in
   `deepseek_plugins/_template-plugin/` for the host half.
2. `src/config.ts` — the volatile-group shape (`z.object({...}).volatile()`; a volatile
   node may not live inside an array item, so `tasks` is volatile as a whole).
3. `src/service.ts` (`safeGet`/`requireService`) — never hard-inject a service you can
   survive without; a profile that lacks it must degrade, not fail to boot.
4. `src/gui.ts` — the route plumbing (`send`, `requestSignal`, `readJsonBody`,
   `crossOriginReason`, `methodNotAllowed`) is generic and small.
5. `client.js` + `tests/client.spec.ts` — the bundle contract and its assertions.
6. `tests/helpers/fake-fs.ts` — a fake with real intent enforcement
   (`createIfAbsent`/`replaceIfVersion`), so a wrong write intent fails a test.
7. `cordis.patch.yml` — a comment block that explains **why** rows are absent (here:
   the vision-agent rows), so the absence is not read as an oversight.

## 5. What not to copy

- The four-gate reasoning, the route-capability probe, and the untrusted-pixels policy
  are **this** plugin's problem. A plugin that does not put model output about user
  media into a text-only agent does not need them.
- The `reference/`/`capture/` zone vocabulary and the upload index are domain choices,
  not a framework.

## 6. Verification recipe

```powershell
# 1. Unit + contract suite (11 files / 283 tests)
& 'D:\deepseek-harness_2\node_modules\.bin\vitest.CMD' run

# 2. Types
& 'D:\deepseek-harness_2\node_modules\.bin\tsc.CMD' -p 'D:\my_deepseek_harness\dsh-vision-bridge\tsconfig.json' --noEmit

# 3. Composition — the row mounts and resolves (workdir = the checkout)
node --import tsx/esm apps/cli/src/bin.ts --profile web --patch '<patch>' --dump-config

# 4. Module smoke test — every import evaluates, without booting a server
node --import tsx/esm -e "import('file:///D:/my_deepseek_harness/dsh-vision-bridge/src/index.ts').then(m => console.log(m.name, typeof m.apply, m.inject))"
```

What each proves: (1) logic and the frozen contracts; (2) no type drift; (3) the
loader can compose the row; (4) the host module graph evaluates — the cheapest
guard against a boot-time import error before installing into a live profile.
**None** of them proves activation, and none proves the panel renders: those are the
user checkpoints in `docs/GUI.md`.

## 7. Feedback owed (same task, not "someday")

| Finding | Goes to |
|---|---|
| The `file://`-row claim is refuted | `deepseek_plugins/docs/best-practices/shortest-path-to-a-plugin.md` + `creating-a-client-card-plugin.md`, and the playbook's copies |
| A user-facing flag must be a host check **and** a rendered state | `creating-a-client-card-plugin.md` (panel states) |
| A fake that ignores its argument makes a passing test vacuous | `plugin-checklist.md` |
| The `enabled` gap and the corrected claim | `docs/incidents/` here, and the playbook's incident index |
