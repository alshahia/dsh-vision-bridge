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
- Full suite at the time of writing: 8 files / 160 tests PASS. `tsc --noEmit`
  exit 0.
- `--dump-config` with this patch: exit 0, plugin row composed.
- Re-verified after the GUI half landed: 11 files / **283 tests** PASS,
  `tsc --noEmit` exit 0, `--dump-config` exit 0.

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

---

## D-3 — An uploaded image is committed to the attachment store, not written into a zone folder

**Planned** (`docs/PLAN.md`, A1): the upload route writes the received bytes into
`reference/` or `capture/`.

**Built**: the route commits the decoded bytes with
`ctx.attachments.saveImage({ data, mediaType, name })` and records the returned
reference in a small index, `<inbox>/uploads.json`. Nothing in this plugin writes
image bytes anywhere.

**Why the plan's mechanism is impossible**

The mounted filesystem service has **no binary write and no delete**. Its write
surface is `writeText` (UTF-8) and `editText` (text replacement); there is no
`writeBytes`, no `mkdir`, and no `remove`/`unlink`
(`packages/fs/fs/src/types.ts`, the `Fs` service). Passing image bytes through
`writeText` would corrupt them, and a folder cannot be created for a first-ever
upload. `writeFileAtomic` does create missing parents
(`packages/fs/fs-local/src/fsio.ts:598`), but it is not reachable through the
service.

**What replaced it, and why it is the better owner anyway**

The harness's own `AttachmentStore` is the one component that can durably commit
bytes. It validates the fully decoded raster, applies the deployment's
normalization policy, and returns a **content-addressed** reference. The index
stores only that reference:

- **A path is never trusted from disk.** Every read re-derives the host path via
  `attachments.imageHostPath(ref)` and gets the bytes via
  `attachments.readImage(ref)`. A hand-edited `uploads.json` therefore cannot
  point this plugin at an arbitrary local image and become a way around
  `read_image`'s route gate. `uploads.json` is read as untrusted input and every
  field is validated (`src/uploads.ts:asRef`).
- **An append is revision-guarded.** `createIfAbsent` when the index is absent,
  `replaceIfVersion` when it exists, so a concurrent upload cannot silently drop
  an entry (`src/uploads.ts:writeUploadIndex`). An index that exists but cannot be
  parsed is **refused**, not overwritten, so a user's upload history is never
  discarded to accept one more image.
- **The two sources stay distinguishable.** `reference/` and `capture/` remain
  real folders for images placed there by hand; `vision_inbox` and the panel
  label each image `folder` or `upload`, because a folder image is the user's own
  file while an upload is an immutable store object.

**Costs, recorded honestly**

- A store may normalize: resize, re-encode, strip metadata. So an upload's
  `sha256` is the digest of the bytes the vision route will actually be given, not
  of the file the user picked (`tests/uploads.spec.ts` proves this).
- A deployment whose attachment store exposes no host path cannot route an upload
  at all. `upload` answers 503 and says the image was committed but is
  unreachable, rather than reporting a success the vision route could not use.
- There is no delete. `remove` answers **501** with the path and a hint. This is
  deliberate: a route that claimed to delete and did not would be the one place in
  this plugin that lies about what happened.

**Evidence**: `tests/uploads.spec.ts` (56 tests) and the upload half of
`tests/gui.spec.ts` (41 tests) drive the real `inbox.ts`/`uploads.ts` against a
fake filesystem and a structural store; the intent-enforcing fake proves which
write intent `appendUpload` passes.

---

## D-4 — The host route contract is `/inbox` + `/upload` + `/remove`, not `/status` + `/list` + `/upload`

**Planned** (`docs/SPEC.md` §5.4, first draft): a `/status` route (enabled, route
capability, counts, cache size) and a separate `/list` route (the images).

**Built**: one `GET /dsh-vision-bridge/inbox` returns everything the panel
renders, plus the three frozen routes above.

**Why**: the panel is one surface. Two routes meant two round trips, two failure
modes, and a window in which the header could disagree with the list it headed —
for a panel whose whole job is to state the truth about what is in the inbox. One
listing cannot contradict itself. The `remove` route is new: the panel needs a
place to show the refusal, and answering on a route that names the operation is
more honest than a button that silently does nothing.

**Recorded because**: it is a user-visible interface change made after the spec
was written, and the client half was already coded against the frozen contract, so
the spec had to be brought forward rather than the code bent back.

---

## D-5 — The `enabled` switch also gates the upload route (403), and the panel renders it

**Planned** (`docs/SPEC.md` §5.4, frozen contract): the upload route's refusal
codes are 400 (bad body/zone/name/base64/not-an-image), 403 (cross-origin), 409
(name taken), 413 (too large), 503 (no attachment store), 405 (wrong method).
`enabled` was described as gating the **tools**.

**Built**: `upload` also answers **403** — same envelope, different message — when
`config.enabled` is false, *before* the body is decoded or anything is committed;
and the panel reports the state and turns its controls off.

**Why**: the switch is a user-visible promise ("this plugin is off"), and it was
only half kept. The panel rendered a fully working upload UI while the tools
refused, and a stale page, a bookmark, or a hand-made request could still commit
an image into an inbox the user had switched off. Two smaller honesty rules came
with it: the listing still returns **200 with `enabled: false`** (the panel needs
the images to render a useful disabled state, not a 500), and absent listing data
is *not* treated as disabled, so nothing flashes off while the panel is loading.

**Cost, recorded honestly**: 403 now has two meanings on this route — cross-origin
and disabled — distinguished only by the message and the `hint`. A caller that
branches on the status alone cannot tell them apart; the client does not, it shows
the message. A future version should give the disabled case its own code if a
second consumer ever appears.

**Evidence**: `tests/gui.spec.ts` — *refuses an upload with 403 while the bridge is
disabled* (asserts nothing reached the store and the index file was never created)
and *still lists the inbox while disabled, and says so*; `tests/client.spec.ts` —
*shows the master switch instead of offering controls that cannot work*. Full suite
11 files / 283 tests PASS, `tsc --noEmit` exit 0 (commit `3753bbd`).

