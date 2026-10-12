/**
 * The upload index, the upload validators, and reading an upload back.
 *
 * The fake filesystem enforces the two write intents the real backend enforces
 * (`createIfAbsent` rejects an existing target, `replaceIfVersion` rejects a
 * stale revision), because the point of `appendUpload` is which intent it passes:
 * a test that ignored the intent would pass while a concurrent upload silently
 * dropped an entry.
 *
 * @module dsh-vision-bridge/tests/uploads.spec
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { resolveInbox, sha256Hex } from '../src/inbox.ts'
import type { InboxLayout } from '../src/inbox.ts'
import {
  MAX_UPLOAD_NAME, UPLOADS_FILE, UPLOADS_VERSION, appendUpload, checkUploadBytes, checkUploadName,
  decodeBase64, findUpload, listUploads, prepareUpload, readUploadIndex, uploadPath,
} from '../src/uploads.ts'
import type { AttachmentStoreLike, InboxUpload, UploadIndex } from '../src/uploads.ts'
import { createFakeFs, jpegBytes, pngBytes } from './helpers/fake-fs.ts'
import type { FakeFs } from './helpers/fake-fs.ts'

const PROJECT = 'D:/proj'
const ROOT_REL = '.dsh/vision'
const ROOT = 'D:/proj/.dsh/vision'
const INDEX_PATH = ROOT + '/' + UPLOADS_FILE

const ALL_FORMATS: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

async function layoutFor(files: Record<string, Uint8Array> = {}): Promise<{
  fake: FakeFs
  ctx: Context
  layout: InboxLayout
}> {
  const fake = createFakeFs({ files })
  const layout = await resolveInbox(fake.ctx, PROJECT, ROOT_REL)
  return { fake, ctx: fake.ctx, layout }
}

/** A well-formed stored reference, built the way the store would return one. */
function refFor(id: string, options: {
  mediaType?: ImageMediaType
  bytes?: number
  width?: number
  height?: number
  name?: string
} = {}): ImageAttachmentRef {
  return {
    attachmentId: id,
    mediaType: options.mediaType ?? 'image/png',
    bytes: options.bytes ?? 64,
    width: options.width ?? 800,
    height: options.height ?? 600,
    ...(options.name === undefined ? {} : { name: options.name }),
  } as unknown as ImageAttachmentRef
}

function uploadFor(zone: 'reference' | 'capture', name: string, ref: ImageAttachmentRef): InboxUpload {
  return { zone, name, ref, uploadedAt: '2026-10-12T12:00:00.000Z' }
}

interface StoreHarness {
  store: AttachmentStoreLike
  calls: string[]
  saved: Map<string, Uint8Array>
}

/**
 * A structural attachment store.
 * @param options.hostPath - 'derived' (default) returns a path, 'missing' returns
 *   undefined, 'throw' throws.
 * @param options.normalize - transform applied on read, to model a store that
 *   resizes or re-encodes what it stored.
 * @param options.refuseRead - return a message to make a read fail.
 */
function makeStore(options: {
  hostPath?: 'derived' | 'missing' | 'throw'
  normalize?: (data: Uint8Array) => Uint8Array
  refuseRead?: (ref: ImageAttachmentRef) => string | undefined
} = {}): StoreHarness {
  const saved = new Map<string, Uint8Array>()
  const calls: string[] = []
  const mode = options.hostPath ?? 'derived'
  const store: AttachmentStoreLike = {
    imageLimits: { mediaTypes: ALL_FORMATS, maxMessageImageBytes: 1024 },
    async saveImage(input) {
      calls.push('saveImage')
      const id = 'att-' + String(saved.size + 1)
      saved.set(id, input.data.slice())
      return refFor(id, {
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
    },
    async readImage(ref) {
      calls.push('readImage')
      const refusal = options.refuseRead?.(ref)
      if (refusal !== undefined) throw new Error(refusal)
      const stored = saved.get(ref.attachmentId)
      if (stored === undefined) throw new Error('no such attachment ' + ref.attachmentId)
      const data = options.normalize === undefined ? stored.slice() : options.normalize(stored)
      return { ref, data }
    },
    imageHostPath(ref) {
      calls.push('imageHostPath')
      if (mode === 'throw') throw new Error('this store refuses to expose host paths')
      if (mode === 'missing') return undefined
      return 'D:/store/' + ref.attachmentId + '.png'
    },
  }
  return { store, calls, saved }
}

interface Recorder {
  ctx: Context
  intents: Array<{ path: string, intent: FsWriteIntent | undefined }>
}

/** A fake filesystem that records and enforces the write intent it is given. */
function recordingFs(fake: FakeFs, options: { conflict?: boolean } = {}): Recorder {
  const real = (fake.ctx as unknown as { fs: Record<string, (...args: never[]) => unknown> }).fs
  const anyReal = real as unknown as {
    stat(target: unknown, signal?: AbortSignal): Promise<{ version: string, type: string } | undefined>
  }
  const intents: Recorder['intents'] = []
  let counter = 0
  const fs = {
    ...real,
    async writeText(target: { displayPath: string }, content: string, intent?: FsWriteIntent) {
      if (options.conflict === true && intent?.kind === 'replaceIfVersion') {
        // Plays the role of the real backend's guard: another writer moved the
        // file on between this operation's read and its write.
        throw new Error('FS_VERSION_MISMATCH: ' + target.displayPath + ' changed since it was observed')
      }
      const info = await anyReal.stat(target)
      if (intent?.kind === 'createIfAbsent' && info !== undefined) {
        throw new Error('FS_NOT_OBSERVED: ' + target.displayPath + ' already exists')
      }
      if (intent?.kind === 'replaceIfVersion' && info?.version !== intent.version) {
        throw new Error('FS_VERSION_MISMATCH: ' + target.displayPath)
      }
      counter += 1
      intents.push({ path: target.displayPath, intent })
      fake.files.set(target.displayPath, new TextEncoder().encode(content))
      return { version: 'w' + String(counter) }
    },
  }
  return { ctx: { fs } as unknown as Context, intents }
}

/** A stored index document, as JSON text. */
function indexText(index: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(index, null, 2) + '\n')
}

describe('decodeBase64', () => {
  it('round-trips canonical base64', () => {
    const bytes = pngBytes(64)
    const text = Buffer.from(bytes).toString('base64')
    const decoded = decodeBase64(text)
    expect(decoded).toBeDefined()
    expect(Array.from(decoded!)).toEqual(Array.from(bytes))
  })

  it('ignores whitespace, which a wrapped body may contain', () => {
    const text = Buffer.from(pngBytes(32)).toString('base64')
    const wrapped = text.slice(0, 8) + '\n' + text.slice(8) + '  '
    expect(decodeBase64(wrapped)).toEqual(decodeBase64(text))
  })

  it('refuses empty input', () => {
    expect(decodeBase64('')).toBeUndefined()
    expect(decodeBase64('   \n ')).toBeUndefined()
  })

  it('refuses a data: URL, which the contract forbids', () => {
    expect(decodeBase64('data:image/png;base64,iVBORw0KGgo=')).toBeUndefined()
  })

  it('refuses a length that is not a whole number of base64 groups', () => {
    expect(decodeBase64('aGVsbG8')).toBeUndefined()
    expect(decodeBase64('A')).toBeUndefined()
  })

  it('refuses characters outside the base64 alphabet', () => {
    expect(decodeBase64('!!!!')).toBeUndefined()
    expect(decodeBase64('AB!=')).toBeUndefined()
    expect(decodeBase64('A===')).toBeUndefined()
  })

  it('refuses input whose trailing bits are not canonical', () => {
    // Buffer.from('AB==', 'base64') yields one byte, but re-encoding that byte
    // produces 'AA=='. Accepting 'AB==' would mean two different strings name the
    // same image, so the round-trip comparison refuses it.
    expect(decodeBase64('AB==')).toBeUndefined()
    expect(decodeBase64('ABC=')).toBeUndefined()
  })

  it('accepts canonical single-byte encodings', () => {
    expect(Array.from(decodeBase64('AA==')!)).toEqual([0])
    expect(Array.from(decodeBase64('AQ==')!)).toEqual([1])
  })
})

describe('checkUploadName', () => {
  it('accepts a supported name and derives its media type', () => {
    expect(checkUploadName('shot.png', ALL_FORMATS)).toEqual({
      ok: true, name: 'shot.png', mediaType: 'image/png',
    })
    expect(checkUploadName('shot.JPG', ALL_FORMATS)).toMatchObject({ ok: true, mediaType: 'image/jpeg' })
    expect(checkUploadName('shot.jpeg', ALL_FORMATS)).toMatchObject({ ok: true, mediaType: 'image/jpeg' })
    expect(checkUploadName('shot.webp', ALL_FORMATS)).toMatchObject({ ok: true, mediaType: 'image/webp' })
    expect(checkUploadName('shot.gif', ALL_FORMATS)).toMatchObject({ ok: true, mediaType: 'image/gif' })
  })

  it('trims surrounding whitespace', () => {
    expect(checkUploadName('  shot.png  ', ALL_FORMATS)).toEqual({
      ok: true, name: 'shot.png', mediaType: 'image/png',
    })
  })

  it('refuses an empty or whitespace-only name', () => {
    expect(checkUploadName('', ALL_FORMATS)).toMatchObject({ ok: false })
    expect(checkUploadName('   ', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses a name longer than the cap', () => {
    const long = 'a'.repeat(MAX_UPLOAD_NAME + 1) + '.png'
    expect(checkUploadName(long, ALL_FORMATS)).toMatchObject({ ok: false })
    const atCap = 'a'.repeat(MAX_UPLOAD_NAME - 4) + '.png'
    expect(checkUploadName(atCap, ALL_FORMATS)).toMatchObject({ ok: true })
  })

  it('refuses the two path-ish names that are never file names', () => {
    expect(checkUploadName('.', ALL_FORMATS)).toMatchObject({ ok: false })
    expect(checkUploadName('..', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses a hidden file', () => {
    expect(checkUploadName('.secret.png', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses a path separator, so a name can never address a directory', () => {
    expect(checkUploadName('a/b.png', ALL_FORMATS)).toMatchObject({ ok: false })
    expect(checkUploadName('a\\b.png', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses characters that cannot round-trip through a path or a shell', () => {
    for (const name of ['a:b.png', 'a*b.png', 'a?b.png', 'a"b.png', 'a<b.png', 'a>b.png', 'a|b.png']) {
      expect(checkUploadName(name, ALL_FORMATS), name).toMatchObject({ ok: false })
    }
    expect(checkUploadName('a\u0000b.png', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses a name with no supported extension', () => {
    expect(checkUploadName('notes.txt', ALL_FORMATS)).toMatchObject({ ok: false })
    expect(checkUploadName('archive.bmp', ALL_FORMATS)).toMatchObject({ ok: false })
    expect(checkUploadName('noextension', ALL_FORMATS)).toMatchObject({ ok: false })
  })

  it('refuses a format the inbox does not accept', () => {
    const pngOnly: readonly ImageMediaType[] = ['image/png']
    expect(checkUploadName('shot.png', pngOnly)).toMatchObject({ ok: true })
    const refused = checkUploadName('shot.gif', pngOnly)
    expect(refused).toMatchObject({ ok: false })
    expect(refused.ok === false && refused.error).toContain('image/gif')
  })
})

describe('checkUploadBytes', () => {
  it('accepts bytes that match the declared format', () => {
    expect(checkUploadBytes(pngBytes(64), 'image/png', 1024)).toBeUndefined()
    expect(checkUploadBytes(jpegBytes(64), 'image/jpeg', 1024)).toBeUndefined()
  })

  it('refuses an empty file', () => {
    expect(checkUploadBytes(new Uint8Array([]), 'image/png', 1024)).toContain('empty')
  })

  it('refuses bytes over the cap', () => {
    const message = checkUploadBytes(pngBytes(2048), 'image/png', 1024)
    expect(message).toContain('exceeds')
    expect(message).toContain('1024')
  })

  it('accepts bytes exactly at the cap', () => {
    expect(checkUploadBytes(pngBytes(1024), 'image/png', 1024)).toBeUndefined()
  })

  it('refuses bytes that are not an image', () => {
    expect(checkUploadBytes(new TextEncoder().encode('%PDF-1.7 padding'), 'image/png', 1024))
      .toContain('not a supported')
  })

  it('refuses bytes that disagree with the declared extension', () => {
    const message = checkUploadBytes(jpegBytes(64), 'image/png', 1024)
    expect(message).toContain('image/png')
    expect(message).toContain('image/jpeg')
  })
})

describe('readUploadIndex', () => {
  it('treats a missing index as an empty one, not an error', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(readUploadIndex(ctx, layout)).resolves.toEqual({
      index: { version: UPLOADS_VERSION, uploads: [] },
    })
  })

  it('reads a well-formed index', async () => {
    const entry = uploadFor('reference', 'mock.png', refFor('att-1'))
    const { ctx, layout } = await layoutFor({ [INDEX_PATH]: indexText({ version: 1, uploads: [entry] }) })
    const read = await readUploadIndex(ctx, layout)
    expect(read.problem).toBeUndefined()
    expect(read.index.uploads).toHaveLength(1)
    expect(read.index.uploads[0]).toMatchObject({ zone: 'reference', name: 'mock.png' })
    expect(read.index.uploads[0]!.ref.attachmentId).toBe('att-1')
  })

  it('reports invalid JSON instead of throwing', async () => {
    const { ctx, layout } = await layoutFor({ [INDEX_PATH]: new TextEncoder().encode('{ not json') })
    const read = await readUploadIndex(ctx, layout)
    expect(read.problem).toContain('not valid JSON')
    expect(read.index.uploads).toEqual([])
  })

  it('refuses an index written by a different schema revision', async () => {
    const { ctx, layout } = await layoutFor({ [INDEX_PATH]: indexText({ version: 99, uploads: [] }) })
    const read = await readUploadIndex(ctx, layout)
    expect(read.problem).toContain('version 99')
    expect(read.problem).toContain('refusing to reinterpret')
  })

  it('reports a document that is not an object', async () => {
    const { ctx, layout } = await layoutFor({ [INDEX_PATH]: new TextEncoder().encode('[1,2,3]') })
    await expect(readUploadIndex(ctx, layout)).resolves.toMatchObject({
      problem: expect.stringContaining('not a JSON object'),
    })
  })

  it('reports a missing uploads array', async () => {
    const { ctx, layout } = await layoutFor({ [INDEX_PATH]: indexText({ version: 1 }) })
    await expect(readUploadIndex(ctx, layout)).resolves.toMatchObject({
      problem: expect.stringContaining('no "uploads" array'),
    })
  })

  it('skips entries that are unusable and keeps the rest', async () => {
    const { ctx, layout } = await layoutFor({
      [INDEX_PATH]: indexText({
        version: 1,
        uploads: [
          uploadFor('reference', 'good.png', refFor('att-1')),
          { zone: 'elsewhere', name: 'x.png', ref: refFor('att-2') },
          { zone: 'capture', name: '', ref: refFor('att-3') },
          { zone: 'capture', name: 'noref.png' },
          { zone: 'capture', name: 'badref.png', ref: { attachmentId: 'att-4' } },
          { zone: 'capture', name: 'negative.png', ref: { ...refFor('att-5'), bytes: -1 } },
          { zone: 'capture', name: 'zero.png', ref: { ...refFor('att-6'), width: 0 } },
          'not an object',
          uploadFor('capture', 'good2.jpg', refFor('att-7', { mediaType: 'image/jpeg' })),
        ],
      }),
    })
    const read = await readUploadIndex(ctx, layout)
    expect(read.problem).toBeUndefined()
    expect(read.index.uploads.map(entry => entry.name)).toEqual(['good.png', 'good2.jpg'])
  })

  it('keeps a reference name when the store recorded one', async () => {
    const { ctx, layout } = await layoutFor({
      [INDEX_PATH]: indexText({
        version: 1,
        uploads: [uploadFor('capture', 'shot.png', refFor('att-1', { name: 'sanitized.png' }))],
      }),
    })
    const read = await readUploadIndex(ctx, layout)
    expect(read.index.uploads[0]!.ref.name).toBe('sanitized.png')
  })

  it('ignores a directory that happens to be named uploads.json', async () => {
    const fake = createFakeFs({ files: { [INDEX_PATH + '/inner.txt']: new TextEncoder().encode('x') } })
    const layout = await resolveInbox(fake.ctx, PROJECT, ROOT_REL)
    await expect(readUploadIndex(fake.ctx, layout)).resolves.toEqual({
      index: { version: UPLOADS_VERSION, uploads: [] },
    })
  })
})

describe('appendUpload', () => {
  it('creates the index with createIfAbsent when there is none', async () => {
    const { fake, layout } = await layoutFor()
    const rec = recordingFs(fake)
    await appendUpload(rec.ctx, layout, uploadFor('reference', 'mock.png', refFor('att-1')))
    expect(rec.intents).toEqual([{ path: INDEX_PATH, intent: { kind: 'createIfAbsent' } }])
    const stored = JSON.parse(new TextDecoder().decode(fake.files.get(INDEX_PATH)!))
    expect(stored.version).toBe(UPLOADS_VERSION)
    expect(stored.uploads).toHaveLength(1)
    expect(stored.uploads[0].name).toBe('mock.png')
  })

  it('appends to an existing index with replaceIfVersion', async () => {
    const first = uploadFor('reference', 'a.png', refFor('att-1'))
    const { fake, layout } = await layoutFor({ [INDEX_PATH]: indexText({ version: 1, uploads: [first] }) })
    const rec = recordingFs(fake)
    await appendUpload(rec.ctx, layout, uploadFor('capture', 'b.png', refFor('att-2')))
    expect(rec.intents).toEqual([{ path: INDEX_PATH, intent: { kind: 'replaceIfVersion', version: 'v1' } }])
    const stored = JSON.parse(new TextDecoder().decode(fake.files.get(INDEX_PATH)!))
    expect(stored.uploads.map((entry: { name: string }) => entry.name)).toEqual(['a.png', 'b.png'])
  })

  it('returns the index it wrote', async () => {
    const { fake, layout } = await layoutFor()
    const rec = recordingFs(fake)
    const next = await appendUpload(rec.ctx, layout, uploadFor('capture', 'b.png', refFor('att-2')))
    expect(next.uploads).toHaveLength(1)
    expect(next.version).toBe(UPLOADS_VERSION)
  })

  it('refuses to touch an unreadable index so existing entries are not lost', async () => {
    const { fake, layout } = await layoutFor({ [INDEX_PATH]: new TextEncoder().encode('{ broken') })
    const rec = recordingFs(fake)
    await expect(appendUpload(rec.ctx, layout, uploadFor('capture', 'b.png', refFor('att-2'))))
      .rejects.toThrow(/existing entries are not lost/u)
    expect(rec.intents).toEqual([])
    // The unreadable document is left exactly as it was.
    expect(new TextDecoder().decode(fake.files.get(INDEX_PATH)!)).toBe('{ broken')
  })

  it('surfaces a write the backend refuses as a stale revision', async () => {
    const { fake, layout } = await layoutFor({ [INDEX_PATH]: indexText({ version: 1, uploads: [] }) })
    // A concurrent writer moved the index on between this append's read and its
    // write. The append must fail loudly rather than clobber that writer, and the
    // other writer's document must survive untouched.
    const rec = recordingFs(fake, { conflict: true })
    await expect(appendUpload(rec.ctx, layout, uploadFor('capture', 'b.png', refFor('att-2'))))
      .rejects.toThrow(/FS_VERSION_MISMATCH/u)
    const stored = JSON.parse(new TextDecoder().decode(fake.files.get(INDEX_PATH)!))
    expect(stored.uploads).toEqual([])
  })
})

describe('uploadPath', () => {
  it('returns the path the store derives', () => {
    const { store } = makeStore()
    expect(uploadPath(store, uploadFor('reference', 'a.png', refFor('att-1')))).toBe('D:/store/att-1.png')
  })

  it('returns undefined when this deployment exposes no path', () => {
    const { store } = makeStore({ hostPath: 'missing' })
    expect(uploadPath(store, uploadFor('reference', 'a.png', refFor('att-1')))).toBeUndefined()
  })

  it('returns undefined when the store throws', () => {
    const { store } = makeStore({ hostPath: 'throw' })
    expect(uploadPath(store, uploadFor('reference', 'a.png', refFor('att-1')))).toBeUndefined()
  })
})

describe('findUpload', () => {
  const index: UploadIndex = {
    version: UPLOADS_VERSION,
    uploads: [
      uploadFor('reference', 'Mock Up.png', refFor('att-1')),
      uploadFor('capture', 'shot.png', refFor('att-2')),
    ],
  }

  it('finds an upload by the derived host path', () => {
    const { store } = makeStore()
    expect(findUpload(store, index, 'D:/store/att-2.png')?.name).toBe('shot.png')
  })

  it('finds an upload by zone/name, case-insensitively', () => {
    const { store } = makeStore()
    expect(findUpload(store, index, 'reference/Mock Up.png')?.ref.attachmentId).toBe('att-1')
    expect(findUpload(store, index, 'REFERENCE/mock up.PNG')?.ref.attachmentId).toBe('att-1')
    expect(findUpload(store, index, '  capture/shot.png  ')?.ref.attachmentId).toBe('att-2')
  })

  it('returns undefined for an empty request or a miss', () => {
    const { store } = makeStore()
    expect(findUpload(store, index, '')).toBeUndefined()
    expect(findUpload(store, index, '   ')).toBeUndefined()
    expect(findUpload(store, index, 'reference/nope.png')).toBeUndefined()
    expect(findUpload(store, index, 'D:/elsewhere/outside.png')).toBeUndefined()
  })

  it('still finds an upload by zone/name when no host path exists', () => {
    const { store } = makeStore({ hostPath: 'missing' })
    expect(findUpload(store, index, 'capture/shot.png')?.name).toBe('shot.png')
    expect(findUpload(store, index, 'D:/store/att-2.png')).toBeUndefined()
  })

  it('never matches a path that merely shares a prefix', () => {
    const { store } = makeStore()
    expect(findUpload(store, index, 'D:/store/att-2.png.backup')).toBeUndefined()
  })
})

describe('listUploads', () => {
  it('maps the stored reference onto a listing entry', () => {
    const { store } = makeStore()
    const listed = listUploads(store, {
      version: UPLOADS_VERSION,
      uploads: [uploadFor('capture', 'shot.jpg', refFor('att-9', {
        mediaType: 'image/jpeg', bytes: 1234, width: 640, height: 480,
      }))],
    })
    expect(listed).toEqual([{
      zone: 'capture',
      name: 'shot.jpg',
      path: 'D:/store/att-9.png',
      bytes: 1234,
      mediaType: 'image/jpeg',
      width: 640,
      height: 480,
      uploadedAt: '2026-10-12T12:00:00.000Z',
    }])
  })

  it('still lists an entry whose path cannot be derived, with an empty path', () => {
    const { store } = makeStore({ hostPath: 'missing' })
    const listed = listUploads(store, {
      version: UPLOADS_VERSION,
      uploads: [uploadFor('reference', 'a.png', refFor('att-1', { bytes: 8 }))],
    })
    expect(listed).toHaveLength(1)
    expect(listed[0]!.path).toBe('')
    expect(listed[0]!.bytes).toBe(8)
  })

  it('lists nothing for an empty index', () => {
    const { store } = makeStore()
    expect(listUploads(store, { version: UPLOADS_VERSION, uploads: [] })).toEqual([])
  })
})

describe('prepareUpload', () => {
  it('reads the bytes back through the store and hashes exactly those bytes', async () => {
    const { store } = makeStore()
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png', name: 'a.png' })
    const prepared = await prepareUpload(store, uploadFor('reference', 'a.png', ref), 1024)
    expect(prepared.path).toBe('D:/store/' + ref.attachmentId + '.png')
    expect(prepared.name).toBe('a.png')
    expect(prepared.mediaType).toBe('image/png')
    expect(prepared.bytes).toBe(64)
    expect(prepared.sha256).toBe(sha256Hex(pngBytes(64)))
  })

  it('re-sniffs the stored bytes rather than trusting the declared type', async () => {
    const { store } = makeStore()
    const ref = await store.saveImage({ data: jpegBytes(32), mediaType: 'image/jpeg' })
    const prepared = await prepareUpload(store, uploadFor('capture', 'b.jpg', ref), 1024)
    expect(prepared.mediaType).toBe('image/jpeg')
  })

  it('hashes what the store returned, not what was uploaded', async () => {
    // A store is allowed to normalise: re-encode, resize, strip metadata. The
    // digest must describe the bytes a vision route will actually be given.
    const { store } = makeStore({ normalize: data => data.slice(0, 24) })
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png' })
    const prepared = await prepareUpload(store, uploadFor('reference', 'a.png', ref), 1024)
    expect(prepared.bytes).toBe(24)
    expect(prepared.sha256).toBe(sha256Hex(pngBytes(64).slice(0, 24)))
    expect(prepared.sha256).not.toBe(sha256Hex(pngBytes(64)))
  })

  it('refuses when this deployment exposes no path', async () => {
    const { store } = makeStore({ hostPath: 'missing' })
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png' })
    await expect(prepareUpload(store, uploadFor('reference', 'a.png', ref), 1024))
      .rejects.toThrow(/does not expose a filesystem path/u)
  })

  it('refuses before reading when the reference exceeds the cap', async () => {
    const { store, calls } = makeStore()
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png' })
    const before = calls.length
    await expect(prepareUpload(store, uploadFor('reference', 'a.png', ref), 32))
      .rejects.toThrow(/exceeds the 32-byte inbox limit/u)
    expect(calls.slice(before)).not.toContain('readImage')
  })

  it('refuses bytes the store returned that are not an image', async () => {
    const { store } = makeStore({ normalize: () => new TextEncoder().encode('not an image at all') })
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png' })
    await expect(prepareUpload(store, uploadFor('reference', 'a.png', ref), 1024))
      .rejects.toThrow(/not a supported PNG\/JPEG\/WebP\/GIF/u)
  })

  it('propagates a store read failure', async () => {
    const { store } = makeStore({ refuseRead: () => 'the attachment is gone' })
    const ref = await store.saveImage({ data: pngBytes(64), mediaType: 'image/png' })
    await expect(prepareUpload(store, uploadFor('reference', 'a.png', ref), 1024))
      .rejects.toThrow(/the attachment is gone/u)
  })
})
