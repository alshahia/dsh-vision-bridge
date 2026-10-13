# Incident index — `dsh-vision-bridge`

Every real issue this plugin produced or inherited, where its record lives, and what a
future agent should take from it. Standalone records live in `docs/incidents/`; the
universal cross-project copies live in `D:\my_deepseek_harness\dsh-plugin-playbook`
(copy, no remote) with the workspace docs under
`deepseek_plugins\docs\best-practices\` staying authoritative.

Read this when something here misbehaves, and before "fixing" code back to what a
guide says.

---

## 1. Incidents this plugin produced

| ID | Record | Date | What happened | Why it matters | Status |
|---|---|---|---|---|---|
| **I-1** | [`docs/incidents/2026-10-13-file-url-row-client-bundle-claim.md`](incidents/2026-10-13-file-url-row-client-bundle-claim.md) | 2026-10-13 | The funnel guide (both copies) claimed a `file://` patch row **silently drops the client bundle**. `locatePkgJson` handles path-like rows by walking up to the owning `package.json`, and the target tests exactly that — the claim was never evidence-backed. | It would have cost every future client-card plugin a package install it may not need, and it hid the two requirements that matter: a reachable owning manifest, and `dsh.client` + `exports['./client']`. | **FIXED** (docs corrected; the live confirmation is A1.3) |
| **I-2** | [`docs/incidents/2026-10-13-enabled-switch-gap.md`](incidents/2026-10-13-enabled-switch-gap.md) | 2026-10-13 | `Config.enabled` gated the tools but not the GUI: the panel rendered a working upload UI, and the upload route committed an image into a switched-off inbox. | A user-facing switch must hold at the **host** (403 before any work) *and* be **rendered** by the panel, or the user concludes the setting does nothing. | **FIXED** — commit `3753bbd`, 283 tests PASS |

## 2. Issues recorded in this repo without a standalone file

| Where | Issue | Take |
|---|---|---|
| `docs/PLUGIN-GUIDE.md` §3.4 | The `tests/gui.spec.ts` fake `scopeFor` ignored its argument, so the "the session shapes the project directory" assertion could never fail. | A structural fake must resolve per call, like the code it stands in for. Fixed by resolving the layout inside the fake. |
| `docs/PLUGIN-GUIDE.md` §3.5 | `tests/client.spec.ts` asserted the patch does not hardcode `agentOptions`, and matched the patch's own **comment** explaining the absence. | Strip `#` lines before asserting on a patch. |
| `docs/DEVIATIONS.md` D-3 | The first `src/gui.ts` write was tangled (a 5-argument call to a 4-argument function, unimported helpers, undeclared deps). | Injecting the index/folder access behind deps and rewriting the module cleanly also removed the Cordis coupling — the second draft is smaller than the first. |
| `docs/DEVIATIONS.md` D-5 | `403` on `upload` has two meanings (cross-origin, disabled). | Safe today because the panel shows the message; a second consumer needs a distinct code. |

## 3. Inherited incidents that shaped this build

Read these before changing the corresponding half; they are the reason the code looks
the way it does.

| Incident (playbook) | What it fixed here |
|---|---|
| [`2026-10-12-live-profile-install.md`](../../dsh-plugin-playbook/incidents/2026-10-12-live-profile-install.md) | The install pattern (`install_bundle` → package name + junction), the **restart semantics** table (`client.js` = next page load, host `src/*.ts` = next harness start, patch row + volatile config = live), and the trap that `/plugins/<id>/client.js` **404s for every package** — never use it as an install check. Also the recorded, unresolved **route-auth gap**: plugin routes are not behind the GUI's browser-auth gate, which is why this plugin's routes carry a same-origin check and the limitation is documented rather than claimed solved. |
| [`2026-10-12-client-inject-package-names.md`](../../dsh-plugin-playbook/incidents/2026-10-12-client-inject-package-names.md) | `dsh.client.inject` takes client **bundle package names**, never Cordis service keys; ordering comes from `slots.inject`. |
| [`2026-10-12-panel-floats-above-composer.md`](../../dsh-plugin-playbook/incidents/2026-10-12-panel-floats-above-composer.md) | Why the panel is a portal to `document.body` with `position: fixed` instead of a dock-row child: an in-flow child stretches the composer bar, and fixed-inside-the-composer is trapped by ancestor `backdrop-filter`/`transform`/`overflow`. |
| [`2026-10-12-native-settings-surface-already-serves-us.md`](../../dsh-plugin-playbook/incidents/2026-10-12-native-settings-surface-already-serves-us.md) | A volatile `Config` gets a validated native settings form for free — the reason the panel renders no config inputs. |
| [`2026-10-12-schemastery-volatile-containment.md`](../../dsh-plugin-playbook/incidents/2026-10-12-schemastery-volatile-containment.md) | A volatile node may not live inside an array item; `tasks` is volatile as a whole. |
| [`2026-10-12-loader-volatile-update-not-typed.md`](../../dsh-plugin-playbook/incidents/2026-10-12-loader-volatile-update-not-typed.md), [`2026-10-12-warn-once-probe-pass.md`](../../dsh-plugin-playbook/incidents/2026-10-12-warn-once-probe-pass.md) | The shape of `src/config.ts`'s `LiveConfigReader`: read the live group per operation, accept a plain value in tests, and warn once rather than per call. |
| [`2026-10-12-runtime-resolution-alias-only.md`](../../dsh-plugin-playbook/incidents/2026-10-12-runtime-resolution-alias-only.md) | Why every `@deepseek-ai/*` import resolves to `src/` (never a `lib/` build) and why sibling plugins import each other by relative path. |
| [`2026-09-16-editor-tab-still-mounting-inject-cache.md`](../../dsh-plugin-playbook/incidents/workspace-suite/2026-09-16-editor-tab-still-mounting-inject-cache.md) | The client graph caches a negative verdict: a package that failed to register once does not retry until restart. Explains "the pill is missing after a refresh" diagnostics. |
| [`2026-10-12-settings-seam-redesign-retires-m3-card.md`](../../dsh-plugin-playbook/incidents/workspace-suite/2026-10-12-settings-seam-redesign-retires-m3-card.md) | The target-drift failure (`@deepseek-ai/dsh-settings-file` removed in 0.2.1-alpha.2) that started the work this plugin continues, and why `web-compact-config` is retired rather than repaired. |

## 4. Open items carried by this plugin

| Item | State |
|---|---|
| Live install into the `web` profile (`install_bundle`, absolute `file:` spec) | **NEEDS_USER_DECISION** — installing adds a row to the live profile; the host half activates on the next harness start, which is a user action (this session runs inside that harness). |
| The panel rendered in a real browser | **User checkpoint** — `docs/GUI.md` §"Verifying it in the browser", 6 steps. |
| The `file://`-row live confirmation | Owed by the install checkpoint; if a `file://` row is ever used, mount the package **one way only** (by name *or* by path), because two active Loader sources for one package are rejected (`node-half.client.spec.ts:391-409`). |
