# Deviations from the approved spec and plan

The spec (`docs/SPEC.md`) and plan (`docs/PLAN.md`) are approved documents: they
are implemented, not silently rewritten. Where the built system had to differ,
the difference is recorded here with its reason and evidence. Read this before
"fixing" the code back to what the plan says.

---

## D-1 — The vision sub-agent is mounted from the plugin, not from `cordis.patch.yml`

**Planned** (`docs/PLAN.md:75-76`): "extend `cordis.patch.yml` with the plugin
row; then the `vision_agent` / `vision_agent_fresh` rows mounting stock
`tool-subagent` with a pinned [route]". `docs/SPEC.md:155` describes the same
mechanism as "rows".

**Built**: `src/child.ts` calls the **exported** `apply` from
`@deepseek-ai/dsh-tool-subagent` twice — `provider: 'fork'` as `vision_agent`,
`provider: 'spawn'` as `vision_agent_fresh` — from inside a nested
`ctx.inject(['subagents', 'systemPrompt', 'sessionProjections'], …)` in
`src/index.ts`. `agentOptions.provider`/`model` come from the plugin's own
volatile `route` group, so the route is the one in the Settings form.

**Why the plan's mechanism does not work**

1. **A patch row's `agentOptions` is static config.** Shipping
   `agentOptions: { provider: 'pi-ai', model: 'gemini-2.5-flash' }` in a bundle
   patch hardcodes one machine's vision route into a package meant to work on
   any profile — the same class of mistake as a hardcoded absolute path
   (`CLAUDE.md` §6). Leaving `agentOptions` out is not a fix either: the child
   then inherits the caller's text-only route, `read_image` refuses it at
   execute time, and the child is useless exactly when it is needed.
2. **The D2 allowlist is unreachable from a top-level insert.**
   `modelSelectionSettings: true` is the only row-level way to let the caller
   pick a route, and on a standing (top-level) row it **throws**:
   `'tool-subagent: standing `modelSelectionSettings` requires a scoped preset
   Context'` (`packages/subagent/tool-subagent/src/index.ts:434-437`). It also
   requires the `subagentModelSelection` service to be mounted (`:394-398`). So
   a top-level insert would fail the boot rather than offer the choice.
3. Mounting from the plugin keeps D1 (vision child primary), D2 (user-owned
   route), and D3 (per-project) in one place, in one config surface, instead of
   splitting the route between a Settings form and a machine-local YAML file.

**Cost, recorded honestly**

- `agentOptions` is read **once, at registration**. A later change to `route`
  reaches `describe_image` immediately (its config is re-read per call) but the
  two children keep the route they were mounted with until the plugin is
  reloaded. Documented as a limitation in `README.md`.
- The children exist only where a sub-agent runtime is mounted. A profile
  without `subagents`/`systemPrompt`/`sessionProjections` gets `describe_image`
  and no children, and `vision_inbox` says so rather than leaving the absence
  invisible.

**Evidence**

- `tests/child.spec.ts` (17 tests) runs the **real** stock `apply` against a fake
  Context, so what is asserted is the configuration handed over, not a stand-in.
- Full suite: 8 files / 160 tests PASS. `tsc --noEmit` exit 0.
- `--dump-config` with this patch: exit 0, plugin row composed.

---

## D-2 — `toolFilter` is not validated at mount, so the allow-list is proven elsewhere

**Finding**: `mount` does **not** call `tools.restrict()`. It only checks that a
`toolFilter` names `allow` or `deny`
(`packages/subagent/tool-subagent/src/index.ts:168-170`); the filter travels in
the child's activation request (`:330`) and the **provider** restricts the child
in its creation window. So a mount cannot fail because a name in the allow-list
is unknown, and a typo in that list would surface only when a child is created.

**Consequence for this plugin**: `VISION_CHILD_TOOLS = ['read', 'read_image']`
is asserted against the **live Host's** `Tool.listTools` (46 tools, including
both) rather than against the mount. `read_image` is registered globally
whenever the attachment store is mounted
(`packages/fs/tool-fs/src/index.ts:54-68`), not per route, which is what makes
naming it safe.

**Why this is recorded**: it is the kind of trap that reads as a passing test.
A future plugin author could reasonably believe the mount validates the filter.
