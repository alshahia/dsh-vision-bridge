import { describe, expect, it } from 'vitest'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_INBOX_ROOT, DEFAULT_MAX_BYTES, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOKENS,
  KNOWN_MEDIA_TYPES, LiveConfigReader, visionBridgeConfig,
} from '../src/config.ts'
import type { VisionVolatileConfig } from '../src/config.ts'
import { BUILTIN_TASKS } from '../src/prompts.ts'

type Live = Record<string, { get(): unknown }>

/** Resolve a persisted settings document the way the loader does. */
function resolveDocument(doc: Record<string, unknown>): Live {
  const [resolved] = z.resolve(doc, visionBridgeConfig, {}) as unknown as [Live, unknown]
  return resolved
}

function read(raw: unknown, warn: (message: string) => void = () => {}) {
  return new LiveConfigReader(warn).read(raw as VisionVolatileConfig)
}

describe('visionBridgeConfig', () => {
  it('resolves an empty document and exposes every section as a live reference', () => {
    // Volatility must be legal: Schema.resolve runs validateVolatileSchema first,
    // which throws when a volatile node sits in a blocked position (nested
    // volatile, array item, dict value). This test is that guard.
    const resolved = resolveDocument({})
    for (const key of ['enabled', 'inbox', 'route', 'tasks', 'cache']) {
      expect(typeof resolved[key]?.get, `${key} is live`).toBe('function')
    }
    expect(resolved.enabled!.get()).toBe(true)
    expect(resolved.inbox!.get()).toMatchObject({ root: DEFAULT_INBOX_ROOT, gitIgnore: true, maxBytes: DEFAULT_MAX_BYTES })
    expect(resolved.route!.get()).toMatchObject({ provider: '', model: '', maxTokens: DEFAULT_MAX_TOKENS })
    expect(resolved.cache!.get()).toMatchObject({ enabled: true, maxEntries: DEFAULT_MAX_ENTRIES })
    expect(resolved.tasks!.get()).toEqual([])
  })

  it('round-trips a partial user document and keeps untouched fields at their defaults', () => {
    const resolved = resolveDocument({ route: { provider: 'vp', model: 'vm' }, cache: { maxEntries: 5 } })
    expect(resolved.route!.get()).toMatchObject({ provider: 'vp', model: 'vm', maxTokens: DEFAULT_MAX_TOKENS })
    expect(resolved.cache!.get()).toMatchObject({ enabled: true, maxEntries: 5 })
  })

  it('resolves task presets as array items of a volatile array', () => {
    const resolved = resolveDocument({ tasks: [{ id: 'brand', prompt: 'look at the marks' }] })
    const tasks = resolved.tasks!.get() as Array<Record<string, unknown>>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ id: 'brand', prompt: 'look at the marks', version: 1 })
  })

  it('accepts every known image format as the default accepted set', () => {
    const resolved = resolveDocument({})
    expect(resolved.inbox!.get()).toMatchObject({ formats: [...KNOWN_MEDIA_TYPES] })
  })
})

describe('LiveConfigReader defaults', () => {
  it('resolves an undefined config to the documented defaults', () => {
    const resolved = read(undefined)
    expect(resolved.enabled).toBe(true)
    expect(resolved.inbox).toEqual({
      root: DEFAULT_INBOX_ROOT,
      gitIgnore: true,
      maxBytes: DEFAULT_MAX_BYTES,
      formats: [...KNOWN_MEDIA_TYPES],
    })
    expect(resolved.route).toEqual({ provider: '', model: '', maxTokens: DEFAULT_MAX_TOKENS })
    expect(resolved.cache).toEqual({ enabled: true, maxEntries: DEFAULT_MAX_ENTRIES })
  })

  it('falls back to the built-in tasks when none are configured', () => {
    expect(read({}).tasks.map(task => task.id)).toEqual(BUILTIN_TASKS.map(task => task.id))
    expect(read({ tasks: [] }).tasks.map(task => task.id)).toEqual(BUILTIN_TASKS.map(task => task.id))
  })

  it('reads a live reference exactly like a plain object', () => {
    const live = resolveDocument({ route: { provider: 'vp', model: 'vm' } })
    expect(read(live).route).toEqual({ provider: 'vp', model: 'vm', maxTokens: DEFAULT_MAX_TOKENS })
    expect(read({ route: { provider: 'vp', model: 'vm' } }).route).toEqual({
      provider: 'vp', model: 'vm', maxTokens: DEFAULT_MAX_TOKENS,
    })
  })

  it('reports enabled: false rather than treating it as unset', () => {
    expect(read({ enabled: false }).enabled).toBe(false)
  })
})

describe('LiveConfigReader clamp-and-warn-once', () => {
  it('drops a half-configured route and says so once', () => {
    const notices: string[] = []
    const resolved = read({ route: { provider: 'vp' } }, message => notices.push(message))
    expect(resolved.route).toEqual({ provider: '', model: '', maxTokens: DEFAULT_MAX_TOKENS })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('provider and model must be set together')
  })

  it('drops a model without a provider too', () => {
    const notices: string[] = []
    expect(read({ route: { model: 'vm' } }, message => notices.push(message)).route.provider).toBe('')
    expect(notices[0]).toContain('provider and model must be set together')
  })

  it('reports each distinct problem once per read, not once per pass', () => {
    const notices: string[] = []
    read({ route: { provider: 'vp' }, inbox: { formats: ['image/bmp'] } }, message => notices.push(message))
    expect(notices.filter(line => line.includes('provider and model'))).toHaveLength(1)
    expect(notices.filter(line => line.includes('not a supported image format'))).toHaveLength(1)
  })

  it('keeps the notice memory across reads of the same values and re-arms on a change', () => {
    const notices: string[] = []
    const reader = new LiveConfigReader(message => notices.push(message))
    reader.read({ route: { provider: 'vp' } } as VisionVolatileConfig)
    reader.read({ route: { provider: 'vp' } } as VisionVolatileConfig)
    expect(notices).toHaveLength(1)
    // A different resolved state clears the memory, so the same problem is
    // reported again rather than being suppressed forever.
    reader.read({ enabled: false, route: { provider: 'vp' } } as VisionVolatileConfig)
    expect(notices).toHaveLength(2)
    // Returning to the first state is a new generation again.
    reader.read({ route: { provider: 'vp' } } as VisionVolatileConfig)
    expect(notices).toHaveLength(3)
  })
})

describe('LiveConfigReader normalization', () => {
  it('drops an unknown format and keeps the rest', () => {
    const notices: string[] = []
    const resolved = read({ inbox: { formats: ['image/png', 'image/bmp'] } }, message => notices.push(message))
    expect(resolved.inbox.formats).toEqual(['image/png'])
    expect(notices[0]).toContain('"image/bmp" is not a supported image format')
  })

  it('falls back to every known format when none of the configured ones is accepted', () => {
    const resolved = read({ inbox: { formats: ['image/bmp'] } })
    expect(resolved.inbox.formats).toEqual([...KNOWN_MEDIA_TYPES])
  })

  it('de-duplicates accepted formats without reporting a notice', () => {
    const notices: string[] = []
    const resolved = read({ inbox: { formats: ['image/png', 'image/png'] } }, message => notices.push(message))
    expect(resolved.inbox.formats).toEqual(['image/png'])
    expect(notices).toEqual([])
  })

  it('uses configured tasks instead of the built-ins', () => {
    const resolved = read({ tasks: [{ id: 'brand', title: 'Brand', prompt: 'the marks', version: 3 }] })
    expect(resolved.tasks).toEqual([{ id: 'brand', title: 'Brand', prompt: 'the marks', version: 3 }])
  })

  it('defaults a task title to its id and its version to 1', () => {
    expect(read({ tasks: [{ id: 'brand', prompt: 'the marks' }] }).tasks[0]).toEqual({
      id: 'brand', title: 'brand', prompt: 'the marks', version: 1,
    })
  })

  it('drops an incomplete task and falls back to the built-ins when nothing usable remains', () => {
    const notices: string[] = []
    const resolved = read({ tasks: [{ id: '', prompt: '' }] }, message => notices.push(message))
    expect(resolved.tasks.map(task => task.id)).toEqual(BUILTIN_TASKS.map(task => task.id))
    expect(notices[0]).toContain('a task needs both an id and a prompt')
  })

  it('keeps the first of two tasks sharing an id', () => {
    const notices: string[] = []
    const resolved = read({
      tasks: [
        { id: 'brand', prompt: 'first' },
        { id: 'brand', prompt: 'second' },
      ],
    }, message => notices.push(message))
    expect(resolved.tasks).toHaveLength(1)
    expect(resolved.tasks[0]?.prompt).toBe('first')
    expect(notices[0]).toContain('duplicate task id "brand"')
  })

  it('keeps a usable task list even when one entry in it is broken', () => {
    const resolved = read({ tasks: [{ id: 'brand', prompt: 'the marks' }, { id: '', prompt: '' }] })
    expect(resolved.tasks.map(task => task.id)).toEqual(['brand'])
  })

  it('trims whitespace-only text back to its default', () => {
    const resolved = read({ inbox: { root: '   ' }, route: { provider: '  ', model: 'vm' } })
    expect(resolved.inbox.root).toBe(DEFAULT_INBOX_ROOT)
    expect(resolved.route.provider).toBe('')
  })
})
