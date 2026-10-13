# PLAN — dsh-vision-bridge

Sequencing rule: **prove the cheap, falsifiable thing first.** A0 has zero client
code. If description quality, cost, or latency is wrong, A0 says so for the price
of one tool call — before any GUI exists.

Each task states its acceptance and the **evidence class** it must produce.
"Done" requires the evidence, not the code.

---

## A0 — Host core, no client code

### A0.1 Repo skeleton and resolution

- `package.json`, `tsconfig.json`, `vitest.config.ts`, `scripts/link-node-modules.mjs`
  (adapted `WANTED` / `WORKSPACE_PACKAGES` lists), `.gitignore`.
- Build the junction farm: `node scripts\link-node-modules.mjs`.

**Acceptance:** `scripts/.dsh-target.txt` names `D:\deepseek-harness_2`; the farm
links every `WANTED` package. **Evidence:** command output.

### A0.2 `src/config.ts`

Volatile `Config` + `LiveConfigReader` (clamp-and-warn-once, signature-based warn
memory, two-pass read so a change does not clear the memory it just filled).

**Acceptance:** half-typed values never throw; provider-without-model clamps and
warns exactly once per value generation; duplicate task ids drop with one warning;
a volatile-node test resolves (`.volatile()` survives projection).
**Evidence:** unit tests.

### A0.3 `src/workspace.ts` + `src/inbox.ts`

Project dir from `session.header.cwd` (absolute only). Inbox layout
`reference/` + `capture/`; `ctx.fs.contains` guard; `listDir`; magic-byte sniff
(PNG/JPEG/WebP/GIF); byte caps; optional `.gitignore` hygiene.

**Acceptance:** traversal (`..\..\secret.png`) and outside-inbox absolute paths are
refused; a `.png` whose bytes are not an image is refused; listing is stable and
name-ordered; a missing folder reads as empty, never throws.
**Evidence:** unit tests.

### A0.4 `src/prompts.ts` + `src/vision.ts`

One module owns the task presets, their `version`, and the untrusted-data
envelope. `vision.ts`: resolve path → `ctx.fs.readBytes` → `saveImage` →
`{ type:'image', attachment }` → `ctx.llm.stream({ provider, model, messages, maxTokens, signal })`
→ `BlockAssembler` → text.

**Acceptance:** the route gate refuses a provider/model that does not declare
`image` with an actionable message; the returned envelope names path, sha256,
task and route; a vision-route failure surfaces as a tool error, never a crash.
**Evidence:** unit tests with a stub `llm` service.

### A0.5 `src/cache.ts`

Key `sha256(sha256 + taskId + taskVersion + provider + model)`; JSON files under
`<inbox>/.cache/`; `maxEntries` pruning; `reuse` semantics (`auto`/`never`/`only`).

**Acceptance:** a prompt-version bump invalidates; `reuse:'never'` bypasses;
`reuse:'only'` fails cleanly on a miss; pruning respects `maxEntries`.
**Evidence:** unit tests.

### A0.6 `src/index.ts`

Registers `describe_image`; reads live config at every operation start; logs the
resolved route once; degrades honestly when `llm`/`attachments`/`fs` are absent.

**Acceptance:** registering without the attachment service refuses with a clear
message rather than half-working. **Evidence:** unit test.

### A0.7 Bundle patch

`cordis.patch.yml` with the plugin row; then the `vision_agent` /
`vision_agent_fresh` rows mounting stock `tool-subagent` with a pinned
`agentOptions` route, `toolFilter.deny` write tools, and `modelSelectionSettings`.

**Acceptance:** `--dump-config` exits 0 and lists the rows. **Evidence:**
composition check (workdir = checkout).

### A0.8 Verification

Target suite green + `tsc --noEmit` (no NEW errors vs the recorded pre-existing
baseline) + `--dump-config`.

---

## A1 — GUI

### A1.1 `src/gui.ts`
Three routes (§5.4), total and defensive: absent web server → log and carry on.

### A1.2 `client.js`
Hand-written bundle (`window.__ModuleLoader__.load`), **no build step**. Inbox
list + drag/drop upload. Slot chosen from the **live** slot tree via
`cordis_inspect_query`, not guessed.

**Acceptance:** structural tests only (registration shape, route paths). Rendering
is a **user checkpoint**.

### A1.3 Live install
Settings → Plugins install, one restart, then a user visual checkpoint. The
junction must be reachable and the patch row must use the **package name**.

---

## A2 — Documentation and feedback

- `README.md`, `docs/PLUGIN-GUIDE.md`, `docs/INCIDENT-INDEX.md`.
- Register this plugin in `D:\my_deepseek_harness\dsh-plugin-playbook` as a
  step-stone pointer (the playbook is a copy-and-point hub; each project keeps
  its own notes).
- Feed every new trap back into the playbook's `guides\` folder in the same task that
  proved it (the archived originals at `_archive\deepseek_plugins\docs\best-practices\`
  are frozen; the playbook is where the living copies are).

---

## Deferred (recorded, not silently dropped)

| Item | Why deferred |
|---|---|
| OCR at scale / PDF | Not the stated purpose (UI work). |
| Screenshot capture automation | The user chose "all sources"; wiring the existing browser/computer-use tools is a separate task, and they already emit `{type:'image'}`. |
| A second vision route for fallback | The platform allowlist already lets the agent choose; a fallback chain would duplicate policy. |
