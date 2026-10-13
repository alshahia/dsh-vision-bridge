# 2026-10-13 — `install_bundle` with a `file:` spec installs a snapshot copy

**Status:** resolved (install converted to a junction + patch row). **Severity:** high
for development, low at runtime — the plugin worked; the *next edit* would silently
not have.

## Symptom

Installing `dsh-vision-bridge` with the sanctioned plugin manager looked completely
successful:

```
plugin_manager action: install_bundle
              target: file:D:\my_deepseek_harness\dsh-vision-bridge
→ {"stage":"enable","changed":true,"application":"applied","version":"0.1.0"}
  pnpm: + dsh-vision-bridge dsh-vision-bridge@file:D:/my_deepseek_harness/dsh-vision-bridge
```

The profile's `package.json` gained the dependency and the bundle list gained
`dsh-vision-bridge`; `list_bundles` showed it `availability:"profile", installed:true`
with the row `dsh-vision-bridge`. Everything pointed at a live install.

## Root cause

pnpm installs a `file:` dependency by **injection**, not by link. The profile's
`node_modules\.modules.yaml` recorded:

```json
"nodeLinker": "hoisted",
"injectedDeps": { "D:/my_deepseek_harness/dsh-vision-bridge": ["node_modules\\dsh-vision-bridge"] }
```

`node_modules\dsh-vision-bridge` was a **real directory** (`LinkType` empty — not a
junction, unlike the sibling `dsh-autocompact` entry), a hard-linked snapshot of the
plugin files taken at install time. The harness resolves the package through that
copy, not through `D:\my_deepseek_harness\dsh-vision-bridge`.

Consequence: **a later source edit does not reach the harness**, and a repeated
`install_bundle` does not fix it — pnpm considers the dependency up to date.

## Evidence

1. After the first install, the profile copy and the source had identical
   `src/index.ts` (24080 bytes, same mtime) — consistent with a hard-linked copy.
2. A probe file created in the plugin *after* the install (`.inject-probe.txt` = `A`)
   was absent from the profile copy: `Test-Path <profile>\node_modules\dsh-vision-bridge\.inject-probe.txt` → `False`.
3. A second `install_bundle` of the same spec returned
   `{"changed":false,"application":"restart-required"}` and pnpm `Already up to date`,
   and the probe was still absent — i.e. no re-sync.
4. `remove_bundle` reverted cleanly: `{"changed":true,"application":"applied"}`,
   pnpm `dependencies: - dsh-vision-bridge`; the profile's `package.json` returned to
   its prior shape (no `dependencies` key, 9 bundles) and `node_modules` back to a
   single entry (`dsh-autocompact`, Junction).

## What changed

The install is now the **proven junction + patch row** shape:

```powershell
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-vision-bridge" `
  -Target 'D:\my_deepseek_harness\dsh-vision-bridge'
```

```yaml
# appended to %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml (backup:
# cordis.patch.yml.bak-20261013-080756)
- insert:
    - id: dsh-vision-bridge
      name: 'dsh-vision-bridge'
```

The junction keeps the source live; the bare-name row is the form the shipped
packages use and the form that lets client-modules find the owning `package.json`.

## A second, welcome correction: the host half is live on patch reload

The delivery table previously said "host `src/*.ts` → next harness start". That is
wrong for this profile (`patchReload: live`). Immediately after the junction and row
were written, with **no restart**:

| Check | Command | Result |
|---|---|---|
| Row applied | `cordis_inspect_query` host `Config.listConfigs {name:'dsh-vision-bridge'}` | `include:dsh-vision-bridge`, `patchId: dsh-vision-bridge`, `status: "schema"` |
| Tools live | `cordis_inspect_query` host `Tool.listTools` | `vision_inbox` and `describe_image` both present |
| Tool works | `vision_inbox {zone:'all'}` | `Project: D:\my_deepseek_harness\deepseek_plugins`, `Enabled: yes`, `Route: (unset)`, 5 built-in tasks, no images |
| Client half live | `cordis_inspect_query` client `Slots.listSubTree {root:'conversation.composer.dock'}` | occupant `id: dsh-vision-bridge`, `order: 55`, `active: true` — in the page that was already open |
| GUI toggle re-applies | `plugin_manager set_plugin include:dsh-vision-bridge enabled:false` then `true` | Config `schema` → `inactive` → `schema`, and `vision_inbox` worked again after re-enable |

Composition was checked read-only first, from the checkout
(`D:\deepseek-harness_2`, workdir = checkout):

```
node --import tsx/esm apps/cli/src/bin.ts --profile web --dump-config
→ DUMP_EXIT=0, row `- id: dsh-vision-bridge` / `name: dsh-vision-bridge`
```

(the only other output was the two pre-existing harmless
`patch: entry "compaction-handoff"/"compact-config-command" not found` lines).

## Caveats — do not over-claim

- Verified on **this** profile only, which sets `patchReload: live`. A `startup`
  profile would still need a restart for the host half.
- I did **not** isolate whether an in-place (same-inode) write to an injected copy
  propagates while an atomically replaced file does not. The safe rule is simpler and
  is the one written into the README: do not develop against an injected copy.
- `--dump-config` echoes the row; it does not import the module. The import was proven
  by the live Config/Tool/Slot queries above, not by the dump.
- The live client registration proves `client.js` was fetched and executed; it does
  **not** prove the panel renders correctly. That remains a user visual checkpoint.
- The GUI toggle proved that a **re-apply** happens live; it did not prove that the
  two `vision_agent*` children mount after a route is set (that needs a real vision
  route and is the next user-side check).
