# SPEC — dsh-vision-bridge

**Status:** approved in principle by the user (2026-10-12); this document is the
durable form of that approval. Change it only with user approval; implementation
deviations go to `docs/DEVIATIONS.md`, never a silent rewrite.

**Target:** DSH `0.2.1-alpha.2` (`D:\deepseek-harness_2`). Every platform claim
below carries a file:line source read from that checkout; a claim without one is
a hypothesis and is labelled as such.

---

## 1. The problem, stated from the source

The routed conversation model may accept text only. When it does, images do not
reach it as images:

| Effect | Source |
|---|---|
| Images are **silently** projected to text for a text-only route | `packages/llm/llm/src/index.ts:1078-1082` |
| The projected text keeps only a **truncated 8-hex** attachment id | `packages/llm/llm/src/content.ts:76-79` |
| A browser image attachment is **refused** at the prompt door | `packages/api/session-controller/src/commands.ts:336-348` (`MODEL_DOES_NOT_SUPPORT_IMAGES`) |
| A subagent whose route is text-only is **refused** | `packages/subagent/subagent/src/manager.ts:1431-1448` |
| `read_image` refuses on a text-only route by design | `packages/fs/tool-fs/src/read-image.ts:120-132` |

Four independent gates, all correct, all fatal to "let my agent look at this
mockup". The consequence for UI work is concrete: the agent cannot see the app
it is styling, cannot compare a screenshot against the user's mockup, and cannot
read a logo or a palette out of a design.

**Non-goal:** removing or weakening any of those four gates. They protect the
routed model from content it cannot read. This plugin does not change what the
conversation model receives.

## 2. The outcome

A text-only agent gains real vision **through a second model that genuinely
declares image input**, without changing its own route:

- one image + one question → `describe_image` returns bounded **text**;
- multi-image, multi-step, comparative UI work → a **pinned vision sub-agent**
  that holds the images in its own context and returns text;
- the images themselves live in a **per-project folder** the user controls.

The conversation model only ever receives text. Nothing about the four gates
changes.

## 3. Decisions

| # | Decision | Rationale (why not the alternative) |
|---|---|---|
| **D1** | The **vision sub-agent is the primary** path for UI work; `describe_image` is the one-off convenience path. | Comparison (mockup vs screenshot), iteration, and "look at the whole screen" are structurally impossible for a single-image, single-question tool. A child agent holds many images in one context and can be asked follow-ups. User decision. |
| **D2** | Route selection is an **allowlist the user controls**; the agent may choose within it. | The platform already ships exactly this: `subagent-model-selection-settings` owns a volatile `{ enabled, allowedModels }` pair sampled per session (`packages/subagent/tool-subagent/src/model-selection-settings.ts:20-40`). **We reuse it and do not invent a second list** — one allowlist, one native settings form, one source of truth. |
| **D3** | Images live in a **per-project folder**, not in the prompt. | A plain file never enters prompt admission, so gate 1 cannot fire. The project root is the session's immutable creation `cwd` (`agent.session.header.cwd`), the same authority the autocompact suite uses. |
| **D4** | Two folder roles with **different trust**: `reference/` (user-authored truth) and `capture/` (agent-produced evidence). | A mockup the user drew and a screenshot the agent took are not the same kind of fact; conflating them invites "the design says X" when X was the agent's own guess. |
| **D5** | The user configures everything from the GUI; **we hand-roll only what the schema cannot express**. | A volatile schemastery `Config` gets a validated, revision-safe Settings form for free on 0.2.x (`docs/best-practices/creating-a-client-card-plugin.md` §7). Bespoke UI is reserved for the upload surface, which no schema can express. |
| **D6** | The plugin's own model call is a **nested `ctx.llm.stream` on the configured vision route**, not a change to the session route. | Proven precedent: `packages/compaction/compaction-basic/src/summarizer.ts:120-163` already makes a nested call to a configured, different route and assembles with `BlockAssembler`. |

### 3.1 The crux, stated plainly

`describe_image` deliberately does **not** call `assertImageCapableRoute`. That
gate exists so an image-reading tool never returns an image the *calling* route
cannot read (`read-image.ts:6-10`). Our tool returns **text only** to the caller;
the image is consumed by a *different*, explicitly image-capable route inside the
host. The mirror obligation replaces it: we assert the **vision route** declares
`image` input and refuse with a clear message when it does not, instead of
letting the provider fail later with `UNSUPPORTED_CONTENT`
(`packages/llm/llm-deepseek/src/images.ts:46`).

This is the one place where a reader should expect a gate and not find one. It is
a documented divergence, not an oversight.

## 4. Architecture

```
user ──upload──► <project>/.dsh/vision/reference/*.png     (D4: truth)
agent ─screenshot──► <project>/.dsh/vision/capture/*.png   (D4: evidence)
                          │
        ┌─────────────────┴──────────────────┐
        │                                    │
   describe_image (host tool)          vision_agent (pinned subagent)
   one image, one task                 many images, many steps
        │                                    │
        └────────► ctx.attachments.saveImage ─┘
                          │
                   image ContentBlock
                          │
        ctx.llm.stream({ provider, model, messages })   ← the vision route
                          │
                   BlockAssembler → text
                          │
        wrapped as UNTRUSTED DATA (§6) → caller's context
```

**Components**

| File | Job |
|---|---|
| `src/config.ts` | Volatile `Config` (one volatile node per group) + `LiveConfigReader` with clamp-and-warn-once. Reading never throws. |
| `src/workspace.ts` | Project directory resolution (`session.header.cwd`, absolute-only, documented fallback). |
| `src/inbox.ts` | Folder layout, `ctx.fs.contains` containment guard, listing, magic-byte sniff, size caps, `.gitignore` hygiene. |
| `src/prompts.ts` | Versioned task presets and the untrusted-data envelope. One module, so the tool and the child cannot drift. |
| `src/vision.ts` | The nested vision call: path → bytes → `saveImage` → image block → `ctx.llm.stream` → text. |
| `src/cache.ts` | Content-addressed description cache keyed by `(sha256, taskId, taskVersion, provider, model)`. |
| `src/index.ts` | Plugin entry: registers `describe_image`, reads live config at every operation. |
| `src/gui.ts` | Host HTTP routes for the client half (status / list / upload). |
| `client.js` | Hand-written client bundle (**no build step**, per the autocompact precedent): inbox list + upload. |

## 5. Contracts

### 5.1 `describe_image` parameters

| Param | Type | Required | Meaning |
|---|---|---|---|
| `path` | string | yes | Image path. **A path, not an attachment id** — `textOnlyImageText` truncates ids to 8 hex chars (`content.ts:77`), so a text-only caller can never hold a usable id. |
| `task` | enum | no | `ui-review` \| `compare` \| `extract-text` \| `describe` \| `brand`. Default `describe`. |
| `question` | string | no | Free-form question; mutually exclusive with the structured `ui-review` shape. |
| `reuse` | enum | no | `auto` (default, cache hit wins) \| `never` (always call) \| `only` (cache or fail). |

Returns text: a header (path, sha256, task, route, cached flag) plus the model's
description inside the untrusted-data envelope.

### 5.2 Config (all volatile; one node per group)

```ts
enabled: boolean = true
inbox:   { root: string = '.dsh/vision', gitIgnore: boolean = true,
           maxBytes: number, formats: string[] }
route:   { provider: string = '', model: string = '', maxTokens: number }
tasks:   [{ id, title, prompt, version }]     // volatile as a WHOLE array
cache:   { enabled: boolean = true, maxEntries: number }
```

**Containment rule** (`docs/incidents/2026-10-12-schemastery-volatile-containment.md`):
a volatile node cannot nest inside another volatile node or inside an array
element. `tasks` is therefore volatile as a whole, with ordinary objects inside —
the same shape as `models` in `dsh-autocompact/src/config.ts:152-160`.

**No cross-field validator exists** (schemastery has no `.check()`), so
"provider and model together", duplicate task ids, and unknown formats are
**clamp-and-warn-once at read time** in `LiveConfigReader`. A half-typed value in
the Settings form must never throw.

**`applies: 'live'` obligation:** the plugin is not re-instantiated on a live
edit, so every operation re-reads the groups with `.get()` at its start.

### 5.3 Bundle patch

```yaml
- insert:
    - id: dsh-vision-bridge
      name: 'dsh-vision-bridge'      # package name, not a file:// URL (D5/client rule)
```

The `vision_agent` rows mount the **stock** `tool-subagent` — the sub-agent is a
*configuration*, not new plumbing (`packages/subagent/tool-subagent/src/index.ts:48-92`
already offers `agentOptions`, `persona`, `toolFilter`, `maxDepth`,
`modelSelectionSettings`). Each instance needs a distinct `toolName`.

### 5.4 Host routes

The **built** contract. (The first draft in this section listed `/status` and
`/list`; they were replaced by one `/inbox` listing — see `docs/DEVIATIONS.md`
D-4.)

| Route | Method | Job |
|---|---|---|
| `/dsh-vision-bridge/inbox` | GET | one listing: `enabled`, the resolved route and whether it declares `image`, the mounted children, the task ids, both zone directories, and every image from **both** sources with its `source` |
| `/dsh-vision-bridge/upload` | POST | validated commit of one uploaded image |
| `/dsh-vision-bridge/remove` | POST | **always 501** — an honest refusal, because this plugin cannot delete (D-3) |

A route handler carries no Agent, so `GET /inbox` takes `?session=<id>` and the
`POST` routes take `session` in the body; the host resolves that session's project
directory, falling back to the launch directory. `upload` requires `zone`, `name`,
and `data` (canonical base64, **no** `data:` prefix) and answers 400 (bad body /
zone / name / base64 / not-an-image / extension mismatch), 403 (cross-origin),
409 (name taken in that zone), 413 (too large), or 503 (no attachment store).
`remove` answers 501 with the path and a hint naming the file to delete by hand.
Every response is `cache-control: no-store`, and the error envelope is
`{ ok: false, error, hint? }`.

Registered through `ctx.webServer.register({ kind: 'exact', path, handler })`
inside `ctx.effect` — the proven 0.2.x shape (`dsh-autocompact/src/gui.ts:44-54,377-404`).
Config writes are **not** hand-rolled: the native settings form owns them. A
composition with no web server is reported in the log, not thrown: the tools work
headless.

## 6. Security

**Prompt injection through pixels is the top risk.** A UI loop turns image text
into tool calls that edit code. Containment:

1. Every description is wrapped as **untrusted data** with an explicit caveat
   line; the tool's own output is a prompt-injection surface into the caller.
2. The vision child is mounted with `toolFilter.deny` covering every write/exec
   tool, so a hijacked description cannot act. It has no write tools at all.
3. Uploads are validated by magic bytes, size caps, and a `ctx.fs.contains`
   containment guard — no traversal, no extension trust.
4. Image text is never treated as a fact about the codebase. Facts available as
   text (palette, spacing, fonts from CSS/tokens) must come from the text.

## 7. Risks and non-goals

| Risk | Standing mitigation |
|---|---|
| Injection via image text | §6.1–6.2 |
| Using vision for facts that are text | Stated in the tool description and the untrusted envelope |
| Screenshot colour fidelity is unreliable | Descriptions are labelled low-confidence for exact colours; `ui-review` asks for relative, not absolute, colour claims |
| Brand/logo identification hallucinates | `brand` task must state uncertainty; never asserted as fact |
| Cost per UI iteration | Per-call `maxTokens` cap; cache; a documented budget note |

**Non-goals:** changing the routed model; weakening any gate; OCR at scale;
video; generating images.

## 8. Acceptance

| Claim | Evidence class required |
|---|---|
| Config normalizes and never throws on half-typed input | unit test |
| Containment guard refuses traversal and outside-inbox paths | unit test |
| Magic-byte sniff rejects a renamed non-image | unit test |
| Cache key includes prompt version, so a prompt edit invalidates it | unit test |
| The tool refuses a route that does not declare `image` | unit test |
| Types are clean | `tsc --noEmit` |
| The bundle patch composes | `--dump-config` exit 0 |
| The GUI shows and uploads | **user checkpoint** (never agent-verified) |
