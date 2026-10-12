import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  cacheKey, imageIdentity, readCached, writeCached,
} from '../src/cache.ts'
import type { CachedDescription } from '../src/cache.ts'
import { resolveInbox } from '../src/inbox.ts'
import { createFakeFs } from './helpers/fake-fs.ts'

const PROJECT = 'D:/proj'
const ROOT = 'D:/proj/.dsh/vision'

const IDENTITY = {
  sha256: 'a'.repeat(64),
  task: 'ui-review',
  version: 1,
  provider: 'vp',
  model: 'vm',
}

async function layoutFor() {
  const fake = createFakeFs({ dirs: [ROOT + '/.cache'] })
  const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
  return { ctx: fake.ctx, fake, layout }
}

function entryFor(key: string, text = 'A dark sidebar.'): CachedDescription {
  return {
    key,
    sha256: IDENTITY.sha256,
    task: IDENTITY.task,
    version: IDENTITY.version,
    provider: IDENTITY.provider,
    model: IDENTITY.model,
    text,
    createdAt: '2026-10-12T00:00:00.000Z',
  }
}

describe('cacheKey', () => {
  it('is a deterministic 64-character hex digest', () => {
    const key = cacheKey(IDENTITY)
    expect(key).toMatch(/^[0-9a-f]{64}$/u)
    expect(cacheKey(IDENTITY)).toBe(key)
  })

  it('changes when any component of the identity changes', () => {
    const base = cacheKey(IDENTITY)
    expect(cacheKey({ ...IDENTITY, sha256: 'b'.repeat(64) })).not.toBe(base)
    expect(cacheKey({ ...IDENTITY, task: 'compare' })).not.toBe(base)
    expect(cacheKey({ ...IDENTITY, version: 2 })).not.toBe(base)
    expect(cacheKey({ ...IDENTITY, provider: 'other' })).not.toBe(base)
    expect(cacheKey({ ...IDENTITY, model: 'other' })).not.toBe(base)
  })

  it('separates a field boundary so adjacent values cannot collide', () => {
    expect(cacheKey({ ...IDENTITY, task: 'a', version: 12 }))
      .not.toBe(cacheKey({ ...IDENTITY, task: 'a1', version: 2 }))
  })
})

describe('imageIdentity', () => {
  it('returns nothing for no images', () => {
    expect(imageIdentity([])).toBe('')
  })

  it('keeps a single image digest unchanged', () => {
    expect(imageIdentity(['abc'])).toBe('abc')
  })

  it('combines several digests and stays order-sensitive', () => {
    const forward = imageIdentity(['a', 'b'])
    expect(forward).toMatch(/^[0-9a-f]{64}$/u)
    expect(imageIdentity(['b', 'a'])).not.toBe(forward)
  })
})

describe('readCached and writeCached', () => {
  it('round-trips a description', async () => {
    const { ctx, layout } = await layoutFor()
    const key = cacheKey(IDENTITY)
    await expect(writeCached(ctx, layout, entryFor(key), 10)).resolves.toBe('written')
    const stored = await readCached(ctx, layout, key)
    expect(stored).toMatchObject({ key, text: 'A dark sidebar.', task: 'ui-review', version: 1 })
  })

  it('stores the entry as JSON under the inbox cache folder', async () => {
    const { ctx, fake, layout } = await layoutFor()
    const key = cacheKey(IDENTITY)
    await writeCached(ctx, layout, entryFor(key), 10)
    expect(fake.writes).toEqual([ROOT + '/.cache/' + key + '.json'])
    expect(JSON.parse(new TextDecoder().decode(fake.files.get(ROOT + '/.cache/' + key + '.json'))))
      .toMatchObject({ key, text: 'A dark sidebar.' })
  })

  it('reports a miss for an absent entry', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(readCached(ctx, layout, cacheKey(IDENTITY))).resolves.toBeUndefined()
  })

  it('reports a miss rather than throwing on corrupt JSON', async () => {
    const key = cacheKey(IDENTITY)
    const fake = createFakeFs({ files: { [ROOT + '/.cache/' + key + '.json']: new TextEncoder().encode('{oops') } })
    const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
    await expect(readCached(fake.ctx, layout, key)).resolves.toBeUndefined()
  })

  it('reports a miss when the stored key does not match the requested one', async () => {
    const key = cacheKey(IDENTITY)
    const fake = createFakeFs({
      files: {
        [ROOT + '/.cache/' + key + '.json']: new TextEncoder().encode(JSON.stringify({ key: 'other', text: 'x' })),
      },
    })
    const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
    await expect(readCached(fake.ctx, layout, key)).resolves.toBeUndefined()
  })

  it('reports a miss when the stored description is empty', async () => {
    const key = cacheKey(IDENTITY)
    const fake = createFakeFs({
      files: {
        [ROOT + '/.cache/' + key + '.json']: new TextEncoder().encode(JSON.stringify({ key, text: '   ' })),
      },
    })
    const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
    await expect(readCached(fake.ctx, layout, key)).resolves.toBeUndefined()
  })

  it('overwrites an existing entry without counting it against the cap', async () => {
    const { ctx, layout } = await layoutFor()
    const key = cacheKey(IDENTITY)
    await expect(writeCached(ctx, layout, entryFor(key, 'first'), 1)).resolves.toBe('written')
    await expect(writeCached(ctx, layout, entryFor(key, 'second'), 1)).resolves.toBe('written')
    await expect(readCached(ctx, layout, key)).resolves.toMatchObject({ text: 'second' })
  })

  it('refuses to grow past maxEntries and writes nothing', async () => {
    const { ctx, fake, layout } = await layoutFor()
    await writeCached(ctx, layout, entryFor(cacheKey(IDENTITY)), 1)
    const writesBefore = fake.writes.length
    const other = cacheKey({ ...IDENTITY, task: 'compare' })
    await expect(writeCached(ctx, layout, entryFor(other), 1)).resolves.toBe('full')
    expect(fake.writes).toHaveLength(writesBefore)
    await expect(readCached(ctx, layout, other)).resolves.toBeUndefined()
  })

  it('treats a cap of zero as caching disabled', async () => {
    const { ctx, fake, layout } = await layoutFor()
    await expect(writeCached(ctx, layout, entryFor(cacheKey(IDENTITY)), 0)).resolves.toBe('full')
    expect(fake.writes).toEqual([])
  })

  it('never fails the caller when the cache write throws', async () => {
    const { layout } = await layoutFor()
    const broken = {
      fs: { async resolve(): Promise<never> { throw new Error('read-only filesystem') } },
    } as unknown as Context
    await expect(writeCached(broken, layout, entryFor(cacheKey(IDENTITY)), 5)).resolves.toBe('full')
  })
})
