/**
 * The client bundle's contract, asserted from source.
 *
 * Source-shape only, and deliberately so: this repo's vitest runs with
 * `environment: 'node'` and links no react/jsdom, so nothing here can render.
 * What a regression would actually break is the registration and the request
 * contract, and those are literal strings the shell and the host routes depend
 * on. Rendering, placement, and dismissal are verified in the browser instead.
 *
 * @module dsh-vision-bridge/tests/client.spec
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const client = readFileSync(new URL('client.js', root), 'utf8')
const icon = readFileSync(new URL('icon.svg', root), 'utf8')
const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
const locale = JSON.parse(readFileSync(new URL('locale/en.json', root), 'utf8')) as {
  meta: { title?: string, description?: string }
}
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  name: string
  exports: Record<string, string>
  files: string[]
  dsh: {
    bundle: { patch: string }
    client: { platform: string, immediately: boolean, inject: string[] }
  }
}

describe('client bundle contract', () => {
  it('parses as JavaScript', () => {
    expect(() => new Function(client)).not.toThrow()
  })

  it('registers through the module loader under the package name', () => {
    // The shell's diagnostic is `bundle ... loaded without registering "<id>"`,
    // matched on this literal call and this id.
    expect(client).toContain('window.__ModuleLoader__.load(')
    expect(client).toContain("id: 'dsh-vision-bridge'")
    expect(pkg.name).toBe('dsh-vision-bridge')
    expect(client).toContain('factory: function (require)')
  })

  it('guards for a non-browser host inside an IIFE, never at the top level', () => {
    // A client bundle loads as a classic `<script src>`, where a top-level
    // `return` is a SyntaxError — so the guard must live inside a function.
    expect(client).toContain('(function () {')
    expect(client).toContain("if (typeof window === 'undefined') return")
    expect(client).not.toMatch(/^return /mu)
  })

  it('requests only shell platform modules as externals', () => {
    // The shell freezes a module table at boot and resolves every bundle's
    // require against exactly that set. `react` supplies elements and hooks;
    // `react-dom` supplies the portal that keeps the panel out of the composer's
    // layout. Any other name would mean a build step is required.
    const requested = [...client.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
    expect(requested).toEqual(['react', 'react-dom'])
  })

  it('renders into the composer dock through the slots service', () => {
    expect(client).toContain("inject: ['slots']")
    expect(client).toContain("ctx.slots.inject('conversation.composer.dock'")
    expect(client).toContain("ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-vision-bridge'")
  })

  it('speaks exactly the frozen host routes', () => {
    expect(client).toContain("'/dsh-vision-bridge/inbox'")
    expect(client).toContain("'/dsh-vision-bridge/upload'")
    expect(client).toContain("'/dsh-vision-bridge/remove'")
    // No leftover route from an earlier contract.
    expect(client).not.toContain('/dsh-vision-bridge/status')
    expect(client).not.toContain('/dsh-vision-bridge/list')
  })

  it('fetches the listing without caching and asks for JSON', () => {
    expect(client).toContain("cache: 'no-store'")
    expect(client).toContain("accept: 'application/json'")
  })

  it('fails safe on every asynchronous path', () => {
    // A throwing component would blank the slot entry, so each promise chain
    // needs a rejection handler and each browser API that can throw is guarded.
    expect(client.match(/\.catch\(/gu)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(client).toContain('try {')
    expect(client).toContain('reader.onerror')
    expect(client).toContain("if (!request) {")
  })

  it('reads the picked file as bare base64, stripping the data: prefix once', () => {
    // The upload route refuses a `data:` prefix, so the strip must happen here.
    expect(client).toContain('reader.readAsDataURL(file)')
    expect(client).toContain("result.replace(/^data:[^;]+;base64,/, '')")
    expect(client).toContain("accept: 'image/png,image/jpeg,image/webp,image/gif'")
  })

  it('floats the panel out of the dock row instead of pushing the composer', () => {
    expect(client).toContain('createPortal')
    expect(client).toContain('createPortal(panel, document.body)')
  })

  it('caps the floating panel and scrolls it internally', () => {
    expect(client).toContain('max-height:min(70vh,520px);overflow:auto;overscroll-behavior:contain;')
  })

  it('places the panel above the pill and keeps it inside the viewport', () => {
    expect(client).toContain('var PANEL_GAP = 8')
    expect(client).toContain('var PANEL_MARGIN = 12')
    expect(client).toContain('var top = rect.top - PANEL_GAP - height')
    expect(client).toContain('window.innerWidth - width - PANEL_MARGIN')
  })

  it('re-tracks placement when the row, anchor, or panel changes size', () => {
    // A sibling pill reflowing moves this pill without a window resize or a
    // scroll, so the row itself needs observing.
    expect(client).toContain('ResizeObserver')
    expect(client).toContain('observer.observe(element)')
    expect(client).toContain('watch(rowRef.current)')
  })

  it('closes on Escape and describes itself as a dialog', () => {
    expect(client).toContain("if (event.key !== 'Escape') return")
    expect(client).toContain("'aria-haspopup': 'dialog'")
    expect(client).toContain("role: 'dialog'")
    expect(client).toContain("'aria-expanded': open ? 'true' : 'false'")
  })

  it('surfaces the delete refusal instead of pretending a delete worked', () => {
    // The host route answers 501 always; the panel must show why, and must not
    // render a control that claims otherwise.
    expect(client).toContain('deleteHint')
    expect(client).toContain('data.canDelete === true ? null :')
    expect(client).toContain("'aria-describedby': 'dshvb-delete-hint'")
  })

  it('shows the master switch instead of offering controls that cannot work', () => {
    // A disabled bridge is a state the user set in the GUI, so the panel must
    // say so and turn its controls off — not present a working-looking upload.
    expect(client).toContain('data.enabled === false')
    expect(client).toContain('var bridgeEnabled = !data || data.enabled !== false')
    expect(client).toContain('disabled: uploading || !uploadsSupported || !bridgeEnabled')
    expect(client).toContain('disabled: !bridgeEnabled')
    expect(client).toContain("disabled: 'The bridge is disabled.'")
    expect(client).toContain('disabledHint')
  })

  it('labels the two zones by their trust, not by their folder name', () => {
    expect(client).toContain("zoneReference: 'Design / mockup (user-authored)'")
    expect(client).toContain("zoneCapture: 'Screenshot (app evidence)'")
    expect(client).toContain("{ id: 'reference', label: STRINGS.zoneReference }")
    expect(client).toContain("{ id: 'capture', label: STRINGS.zoneCapture }")
  })

  it('announces loading, empty, and error states to assistive technology', () => {
    expect(client).toContain("'aria-live': 'polite'")
    expect(client).toContain("role: 'status'")
  })
})

describe('package wiring', () => {
  it('points every client export at a shipped file', () => {
    expect(pkg.exports['./client']).toBe('./client.js')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
    expect(pkg.exports['./icon']).toBe('./icon.svg')
    for (const entry of ['client.js', 'locale/*.json', 'icon.svg', 'cordis.patch.yml']) {
      expect(pkg.files, entry).toContain(entry)
    }
  })

  it('exports ./package.json the way shipped client packages do', () => {
    // locatePkgJson can fall back to createRequire(baseUrl).resolve('<name>/package.json'),
    // and an exports map without that subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED
    // there — a negative client verdict cached until restart.
    expect(pkg.exports['./package.json']).toBe('./package.json')
  })

  it('injects client bundle package names, not service keys', () => {
    expect(pkg.dsh.client).toEqual({
      platform: 'web',
      immediately: true,
      inject: ['@deepseek-ai/dsh-client-ui-conversation'],
    })
    for (const entry of pkg.dsh.client.inject) expect(entry.startsWith('@deepseek-ai/')).toBe(true)
  })

  it('ships the bundle patch the loader composes', () => {
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
  })
})

describe('display metadata', () => {
  it('localises a title and a description', () => {
    expect(typeof locale.meta.title).toBe('string')
    expect(locale.meta.title!.length).toBeGreaterThan(0)
    expect(typeof locale.meta.description).toBe('string')
    expect(locale.meta.description!.length).toBeGreaterThan(0)
  })

  it('ships an original vector icon inside the size limit', () => {
    const bytes = Buffer.byteLength(icon, 'utf8')
    expect(bytes).toBeLessThanOrEqual(256 * 1024)
    expect(icon).toContain('<svg')
    expect(icon).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(icon).toContain('<title>')
    // No script, no raster payload, no external reference.
    expect(icon).not.toContain('<script')
    expect(icon).not.toContain('<image')
    expect(icon).not.toMatch(/href\s*=/u)
  })
})

describe('cordis patch', () => {
  it('inserts this plugin exactly once, by package name', () => {
    expect(patch.match(/id: dsh-vision-bridge/gu)?.length).toBe(1)
    expect(patch).toContain("name: 'dsh-vision-bridge'")
  })

  it('does not hardcode a vision route into the composition', () => {
    // The sub-agent is mounted from the plugin's own live config (DEVIATIONS D-1):
    // a patch row would pin one machine's provider and model. Asserted against the
    // composed rows only — the file's comment block discusses all three by name to
    // explain why they are absent.
    const rows = patch.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
    expect(rows).not.toContain('vision_agent')
    expect(rows).not.toContain('agentOptions')
    expect(rows).not.toContain('file://')
    expect(rows).toContain('- insert:')
  })
})
