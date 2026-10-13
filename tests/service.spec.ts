/**
 * `safeGet` / `requireService` against the two host read shapes.
 *
 * The regression this file exists for (incident I-4): a bare `ctx.webServer`
 * property read throws `cannot get property "webServer" without inject` on the
 * real host, and the old `safeGet` swallowed that throw and answered
 * "undefined" — so the panel registered no routes and every request 404'd, and
 * the same silent absence hid `agents` (per-project inbox) and `attachments`
 * (uploaded images). `ctx.get(name)` is the sanctioned optional lookup.
 *
 * @module dsh-vision-bridge/tests/service
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { requireService, safeGet } from '../src/service.ts'

/** A context whose services are readable only through the sanctioned lookup. */
function serviceContext(services: Record<string, unknown>, ambient: Record<string, unknown> = {}): Context {
  return {
    get: (name: string) => services[name],
    ...ambient,
    get webServer(): never {
      throw new Error('cannot get property "webServer" without inject')
    },
  } as unknown as Context
}

describe('safeGet', () => {
  it('reads a service through ctx.get even when the property read throws', () => {
    const server = { register: () => () => {} }
    const ctx = serviceContext({ webServer: server })
    expect(safeGet<typeof server>(ctx, 'webServer')).toBe(server)
  })

  it('reports an absent service as undefined rather than throwing', () => {
    const ctx = serviceContext({})
    expect(safeGet(ctx, 'attachments')).toBeUndefined()
    expect(safeGet(ctx, 'agents')).toBeUndefined()
  })

  it('treats a null service as absent', () => {
    const ctx = serviceContext({ attachments: null })
    expect(safeGet(ctx, 'attachments')).toBeUndefined()
  })

  it('still reads ambient handles that are not services', () => {
    const warn = (): void => {}
    const ctx = serviceContext({}, { logger: { warn } })
    expect(safeGet<{ warn: () => void }>(ctx, 'logger')?.warn).toBe(warn)
  })

  it('falls back to the property read on a context without ctx.get', () => {
    const service = { marker: true }
    const ctx = { fs: service } as unknown as Context
    expect(safeGet<typeof service>(ctx, 'fs')).toBe(service)
  })

  it('returns undefined when both reads throw', () => {
    const ctx = {
      get: () => { throw new Error('context is disposed') },
      get fs(): never { throw new Error('context is disposed') },
    } as unknown as Context
    expect(safeGet(ctx, 'fs')).toBeUndefined()
  })
})

describe('requireService', () => {
  it('names the service and the purpose when it is absent', () => {
    const ctx = serviceContext({})
    expect(() => requireService(ctx, 'attachments', 'read an uploaded image'))
      .toThrow('needs the "attachments" service to read an uploaded image, and it is not mounted in this profile')
  })

  it('returns the service when it is mounted', () => {
    const store = { marker: true }
    const ctx = serviceContext({ attachments: store })
    expect(requireService<typeof store>(ctx, 'attachments', 'read an uploaded image')).toBe(store)
  })
})
