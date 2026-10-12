/**
 * Description cache: reuse a description without paying for the pixels again.
 *
 * The key covers everything that can change the answer — the image bytes, the
 * task id, the task's prompt version, and the route. Editing a prompt without
 * bumping its `version` is therefore the one way to get a stale hit, which is
 * why `version` is part of the preset contract rather than an afterthought.
 *
 * Entries are plain JSON files under the inbox's `.cache/` folder, so they are
 * inspectable, deletable by the user, and never part of the session log.
 *
 * LIMITATION (recorded, not worked around): the filesystem service exposes no
 * delete (`packages/fs/fs/src/index.ts` has resolve/stat/read/listDir/writeText
 * but no remove). Eviction is therefore a refusal, not a delete: once the cache
 * holds `maxEntries` files, a new description is still returned to the caller
 * but is not stored. Reaching the cap needs a user to delete the folder, or a
 * future backend delete to make real eviction possible.
 *
 * @module dsh-vision-bridge/cache
 */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { InboxLayout } from './inbox.ts'

/** One stored description. */
export interface CachedDescription {
  /** Cache key this entry was stored under; also the file name stem. */
  key: string
  /** sha256 of the image the description was made from. */
  sha256: string
  task: string
  /** Prompt version, so an edited prompt cannot serve an older answer. */
  version: number
  provider: string
  model: string
  text: string
  /** ISO-8601 creation time. */
  createdAt: string
}

/** The identity of a description: everything that can change its content. */
export interface CacheIdentity {
  sha256: string
  task: string
  version: number
  provider: string
  model: string
}

/**
 * Derive the cache key for one description identity.
 * @param identity - image digest, task id, prompt version, and route.
 * @returns 64 lowercase hex characters, safe as a file name.
 */
export function cacheKey(identity: CacheIdentity): string {
  return createHash('sha256')
    .update([identity.sha256, identity.task, String(identity.version), identity.provider, identity.model].join('|'))
    .digest('hex')
}

/**
 * Combine the digests of every image in one call into one identity.
 *
 * A single image keeps its own digest, so a one-image entry stays byte-for-byte
 * interchangeable with entries written before multi-image calls existed. A
 * `compare` combines them, because the same reference against a different
 * candidate is a different question and must not hit the same entry.
 * @param sha256s - per-image digests, in call order.
 * @returns the identity digest, or '' for no images.
 */
export function imageIdentity(sha256s: readonly string[]): string {
  if (sha256s.length === 0) return ''
  if (sha256s.length === 1) return sha256s[0] ?? ''
  return createHash('sha256').update(sha256s.join('+')).digest('hex')
}

/** Resolve the entry path for a key inside the cache folder. */
async function entryTarget(ctx: Context, layout: InboxLayout, key: string, signal?: AbortSignal) {
  return ctx.fs.resolve(layout.root + '/.cache/' + key + '.json', { signal })
}

/**
 * Read one cached description.
 *
 * A missing, unreadable, or corrupt entry reads as a miss: a cache must never
 * be able to fail an operation that could otherwise succeed.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param key - the cache key.
 * @param signal - optional cancellation.
 * @returns the entry, or undefined on any kind of miss.
 */
export async function readCached(
  ctx: Context,
  layout: InboxLayout,
  key: string,
  signal?: AbortSignal,
): Promise<CachedDescription | undefined> {
  try {
    const target = await entryTarget(ctx, layout, key, signal)
    const text = await ctx.fs.readText(target, signal)
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Partial<CachedDescription>
    if (record.key !== key || typeof record.text !== 'string' || record.text.trim() === '') return undefined
    return {
      key,
      sha256: typeof record.sha256 === 'string' ? record.sha256 : '',
      task: typeof record.task === 'string' ? record.task : '',
      version: typeof record.version === 'number' ? record.version : 0,
      provider: typeof record.provider === 'string' ? record.provider : '',
      model: typeof record.model === 'string' ? record.model : '',
      text: record.text,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    }
  } catch {
    return undefined
  }
}

/** Count the entries currently stored. */
async function countEntries(ctx: Context, layout: InboxLayout, signal?: AbortSignal): Promise<number> {
  try {
    const info = await ctx.fs.stat(layout.cacheTarget, signal)
    if (info === undefined || info.type !== 'directory') return 0
    const entries = await ctx.fs.listDir(layout.cacheTarget, signal)
    return entries.filter(entry => entry.type === 'file' && entry.name.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** Outcome of a store attempt, so the caller can report the cap honestly. */
export type CacheWriteOutcome = 'written' | 'full'

/**
 * Store one description.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param entry - the description to store.
 * @param maxEntries - cap on stored entries; 0 disables storing.
 * @param signal - optional cancellation.
 * @returns `written`, or `full` when the cap has been reached.
 */
export async function writeCached(
  ctx: Context,
  layout: InboxLayout,
  entry: CachedDescription,
  maxEntries: number,
  signal?: AbortSignal,
): Promise<CacheWriteOutcome> {
  if (maxEntries <= 0) return 'full'
  try {
    // `entryTarget` is inside the try on purpose: resolving the path is part of
    // the cache write, and a cache that cannot resolve a path must degrade to a
    // miss, never fail the description the caller already has in hand.
    const target = await entryTarget(ctx, layout, entry.key, signal)
    if (await ctx.fs.stat(target, signal) !== undefined) {
      await ctx.fs.writeText(target, JSON.stringify(entry), undefined, signal)
      return 'written'
    }
    if (await countEntries(ctx, layout, signal) >= maxEntries) return 'full'
    await ctx.fs.writeText(target, JSON.stringify(entry), undefined, signal)
    return 'written'
  } catch {
    // A cache write failure must never fail the description the caller asked
    // for; the description is already in hand.
    return 'full'
  }
}
