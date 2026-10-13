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
   live install here is a **junction + a bare-name patch row** (verified 2026-10-13);
   the plugin ships a bundle patch so `install_bundle` also works — but see trap 8
   before using it to develop. Full record:
   `docs/incidents/2026-10-13-file-url-row-client-bundle-claim.md`.
2. **A switch in `Config` is not a switch in the product.** `enabled` gated the tools
   and not the GUI: the panel looked live and the upload route committed. A user-facing
   flag needs a host check **and** a rendered state.
   Record: `docs/incidents/2026-10-13-enabled-switch-gap.md`.
3. **A `patchReload: live` profile applies a junction + row entirely on save** — row,
   tools, and (verified 2026-10-13) the client bundle in an already-open page: no
   restart, no refresh. A **re-apply** (toggle the plugin off/on in Settings → Plugins;
   verified live `schema` → `inactive` → `schema`) re-runs `apply()` but does **not**
   re-import a cached module — so a **source change** to host `src/*.ts` needs the next
   **harness start**. What a re-apply *does* buy is apply-time work on the same module
   (here: the route-dependent children mounting once a route is set). Measured
   2026-10-13 (I-4): after editing the source and toggling off/on, the panel route still
   answered 404 while an independent probe in the same profile proved the pattern it now
   uses answers 200. Record:
   `docs/incidents/2026-10-13-optional-service-read-404-panel.md`. Never verify a client
   half by fetching `/plugins/<id>/client.js` — that URL 404s for every package, including
   shipped ones (playbook `2026-10-12-live-profile-install.md`).
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
8. **`install_bundle` with a `file:` spec installs a snapshot, not a link.** pnpm
   *injects* a `file:` dependency: `node_modules/<name>` becomes a hard-linked copy
   (`<profile>/node_modules/.modules.yaml` → `injectedDeps`), so a later source edit
   never reaches the harness, and re-running the install answers `changed:false` /
   "Already up to date" without re-syncing. It looks like a successful install the
   whole time. Use a **junction + bare-name row** while developing;
   `install_bundle` for a frozen release (`remove_bundle` reverts cleanly). Record:
   `docs/incidents/2026-10-13-install-injection-snapshot.md`.
9. **An optional service is not readable as a bare property, and a `catch` must never
   turn a host rule violation into "service absent".** `webServer` is an optional
   dependency of this plugin — deliberately not in `inject`, so a headless composition
   still mounts the tools. On this host, reading a service that is not declared in
   `inject` **as a property** throws
   `Error: cannot get property "webServer" without inject`. `safeGet` wrapped that read in
   `try { … } catch { return undefined }`, so the throw became "no web server in this
   composition" and `installVisionGui` registered **nothing**: every panel request
   answered 404 while Config, both tools, and the client occupant all looked healthy. The
   same swallow hid `agents` (`projectDirForSession` → every session fell back to the
   launch dir, so the "per-project" inbox was not per-project) and `attachments` (an
   uploaded image was never found in the attachment store). The sanctioned forms are
   `ctx.get("webServer")` **with an undefined check** (optional) or
   `inject: ['webServer']` + `ctx.webServer` (hard); this plugin consumes it through
   `ctx.inject(['webServer'], scope => …)` and keeps the direct read only as the
   structural fallback for contexts without `inject`. The harness's own tests guard this
   trap and call it **"postmortem 0001"**
   (`packages/fs/tool-fs-search/tests/load-path.spec.ts:1-15`; also
   `packages/mcp/mcp-client/tests/load-path.spec.ts`,
   `packages/subagent/tool-subagent/tests/tool-subagent.spec.ts:565`,
   `packages/experimental/hooks-claude-code/tests/bridge.spec.ts:467`). Fixed in
   `8352710`; record: `docs/incidents/2026-10-13-optional-service-read-404-panel.md`.

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
# 1. Unit + contract suite (12 files / 295 tests)
& 'D:\deepseek-harness_2\node_modules\.bin\vitest.CMD' run

# 2. Types
& 'D:\deepseek-harness_2\node_modules\.bin\tsc.CMD' -p 'D:\my_deepseek_harness\dsh-vision-bridge\tsconfig.json' --noEmit

# 3. Composition — the row mounts and resolves (workdir = the checkout).
#    With the junction + row install the live profile is itself the subject;
#    use --patch '<patch>' instead to check a patch file in isolation.
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config

# 4. Module smoke test — every import evaluates, without booting a server.
#    Run from the plugin folder with the CHECKOUT's absolute tsx URL:
#    `--import tsx/esm` fails there with ERR_MODULE_NOT_FOUND (tsx is not in
#    the plugin's node_modules).
node --import 'file:///D:/deepseek-harness_2/node_modules/tsx/dist/esm/index.mjs' -e "import('file:///D:/my_deepseek_harness/dsh-vision-bridge/src/index.ts').then(m => console.log(m.name, typeof m.apply, m.inject))"
```

What each proves: (1) logic and the frozen contracts; (2) no type drift; (3) the
loader can compose the row; (4) the host module graph evaluates — the cheapest guard
against a boot-time import error before installing into a live profile.

**Activation is also provable read-only, from inside a live session**, via the Inspect
providers — do this instead of guessing from the delivery table:

| Claim | Query |
|---|---|
| The row applied and its `Config` schema projected | host `Config.listConfigs {name}` → `status: "schema"` |
| The tools are really registered | host `Tool.listTools` → the plugin's tool names |
| The client half is really loaded | client `Slots.listSubTree {root:'conversation.composer.dock'}` → the occupant id |
| The panel's routes are really **registered** | host HTTP `GET /dsh-vision-bridge/inbox` → **200**. A **404** while `GET /` answers **401** means *no named route matched* — the routes were never registered (I-4); the registered-occupant check above does **not** prove they exist |
| A live re-apply works | `plugin_manager set_plugin` `enabled:false` → `true` → `schema` → `inactive` → `schema`. It re-runs `apply()` on the **cached** module — it does **not** re-import it, so it cannot pick up a source change (I-4) |

Still not provable this way: how the panel **looks** (user checkpoint in
`docs/GUI.md`), that a route-dependent child mounts (needs a real route), and — from the
Inspect providers alone — that the panel's routes were **registered** (that is the HTTP
200-vs-404 check in the table above; a registered occupant is not a registered route,
I-4).

## 7. Feedback owed (same task, not "someday")

| Finding | Goes to |
|---|---|
| The `file://`-row claim is refuted | `deepseek_plugins/docs/best-practices/shortest-path-to-a-plugin.md` + `creating-a-client-card-plugin.md`, and the playbook's copies |
| A user-facing flag must be a host check **and** a rendered state | `creating-a-client-card-plugin.md` (panel states) |
| A fake that ignores its argument makes a passing test vacuous | `plugin-checklist.md` |
| The `enabled` gap and the corrected claim | `docs/incidents/` here, and the playbook's incident index |
| An optional service must be read with `ctx.get`/`ctx.inject` — a bare property read throws, and `catch { return undefined }` converts that host rule violation into a silent capability absence | `deepseek_plugins/docs/best-practices/creating-a-source-plugin.md` §3b + `shortest-path-to-a-plugin.md` (new trap), MEMORY §8, and the playbook's incident index |
| A re-apply re-runs `apply()` but does not re-import a cached module → a host `src/*.ts` change needs a harness start | both funnel guides + `creating-a-source-plugin.md`, MEMORY §7/§8, TASKS.md |
| A `file:///` row only works for a self-contained module; a package with bare imports must be mounted by package name through the profile junction | `shortest-path-to-a-plugin.md`, `creating-a-source-plugin.md` §4 |
