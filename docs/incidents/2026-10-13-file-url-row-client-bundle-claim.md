# A `file://` patch row does **not** drop the client bundle (claim corrected)

- **Date:** 2026-10-13
- **Area:** client-modules registry / patch-row `name` / plugin install
- **Status:** FIXED (the claim) — the guidance is corrected; the *live* confirmation
  is still owed by the install checkpoint (A1.3)
- **Severity:** documentation defect with real cost: it makes every future client-card
  plugin add a package install it may not need, and it hides the actual requirement.

## The claim that was wrong

Both copies of the funnel guide said:

> A client card's patch-row `name` must be the package name — a `file://` URL there
> silently drops the bundle.
> — `dsh-plugin-playbook/guides/shortest-path-to-a-plugin.md:49-50`,
> `deepseek_plugins/docs/best-practices/shortest-path-to-a-plugin.md:53-54`

and the client-card guide repeated it:

> The patch row's `name` must be the package name. A `file://` URL is legal for a
> source-only plugin but **silently drops the client bundle** (§5.1).
> — `deepseek_plugins/docs/best-practices/creating-a-client-card-plugin.md:290-291`

The claim originated in `2026-10-12-bundle-mount-composition-traps.md:57-60`, which
attributed it to the *client-inject-package-names* incident — an incident about
`dsh.client.inject` holding service keys instead of package names. That incident never
established anything about `file://` rows, so the claim was never evidence-backed; it
was a plausible guess that hardened into a rule.

## What the code actually does

`client-modules` resolves a row's owning manifest in `locatePkgJson`
(`packages/client/modules/src/index.ts:871-905`):

```ts
const pathLike = loaderName.startsWith('.') || loaderName.startsWith('file:') || isAbsolute(loaderName)
const expectedPackageName = pathLike ? undefined : exactPackageSpecifier(loaderName)
...
const moduleUrl = loaderName.startsWith('file:') ? loaderName
  : isAbsolute(loaderName) ? pathToFileURL(loaderName).href : new URL(loaderName, baseUrl).href
return this.nearestPackage(moduleUrl)          // no Node internals
...
return this.nearestPackage(moduleUrl, expectedPackageName)   // with Node internals
```

`nearestPackage` (`:908-928`) walks up from the module's directory to the nearest
`package.json` and takes its `name`. A `file://` row pointing at
`<plugin>/src/index.ts` therefore walks to `<plugin>/package.json` and yields the
plugin's own package name — exactly what a bare-name row yields. The registry then
reads `dsh.client` and `exports['./client']` from that manifest
(`:823-857`) and serves the bundle from the real path (`clientPath`, `:672-674`).

The target proves it in its own suite:

- `packages/client/modules/tests/node-half.client.spec.ts:326-338` —
  *"derives the browser module id from a file entry owning manifest"*: a row named by
  `pathToFileURL(hostPath).href` gives `service.clientPath(packageName) === clientPath`
  and a graph entry whose id **is** the package name.
- `:340-359` — the same for a relative and an absolute path with **no** Node internals.
- `:361-389` — the same for `v1`, `v2`, and `worker` resolvers.

So for a plugin whose `package.json` sits at the folder root above `src/`, a
`file://` row carries the client half.

## Honest caveats (why this is "corrected", not "re-proven live")

- The `:361-389` case stubs `resolveSync`, so it proves the path-like *handling*, not
  that a real `v1` `resolveSync` accepts a `file:` specifier. The `:326` case uses the
  no-internals fallback, where the URL is used directly. The live profile reports
  `internal.version === 'v1'` with a real `resolveSync`, so a real-boot confirmation
  is still worth having. Node's resolver normally returns a `file:` specifier
  unchanged, which is why the mechanism is expected to hold.
- The **proven** live pattern remains the sibling plugin's install
  (`dsh-plugin-playbook/incidents/2026-10-12-live-profile-install.md`): a bare-name row
  resolved through a profile junction, whose `clientModules.clientPath()` and
  `clientModules.graph()` were read inside the running harness. That is what
  `install_bundle` produces, and it is what this plugin's `cordis.patch.yml` uses.
- What a `file://` row **does** change is the *loader identity*: the row is
  `include:<path>` rather than `include:<package>`, and a package mounted twice — once
  by name, once by path — is the duplicate-source case the registry rejects
  (`node-half.client.spec.ts:391-409`). Mount it one way, not both.

## What changed

- `README.md` §2 no longer asserts the false mechanism; it states the two mechanisms,
  cites the code and the target's test, and keeps `install_bundle` as the recommended,
  proven path.
- `docs/PLUGIN-GUIDE.md` carries the corrected trap.
- The guide and the playbook copies are corrected at the source
  (`deepseek_plugins/docs/best-practices/*`), because the playbook is a copy and the
  sources stay authoritative.

## Why it is recorded

A wrong "must" in the funnel guide is worse than a missing one: it costs every future
plugin author an install step, and it buries the two requirements that actually matter
— the owning `package.json` must be reachable from the row's module path (so a plugin
whose sources sit *above* their manifest is genuinely broken), and `dsh.client` +
`exports['./client']` must be present.
