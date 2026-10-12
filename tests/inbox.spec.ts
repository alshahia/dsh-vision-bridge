import { describe, expect, it } from 'vitest'
import {
  INBOX_GITIGNORE, assertInsideInbox, ensureInboxIgnored, listInboxImages, mediaTypeForName,
  prepareImage, resolveInbox, sha256Hex, sniffImageMediaType,
} from '../src/inbox.ts'
import type { InboxLayout } from '../src/inbox.ts'
import { createFakeFs, jpegBytes, normalizePath, pngBytes } from './helpers/fake-fs.ts'

const PROJECT = 'D:/proj'
const ROOT = 'D:/proj/.dsh/vision'

const SEED = {
  'D:/proj/.dsh/vision/reference/mock.png': pngBytes(64),
  'D:/proj/.dsh/vision/reference/notes.txt': new TextEncoder().encode('not an image'),
  'D:/proj/.dsh/vision/capture/shot.jpg': jpegBytes(32),
  'D:/proj/.dsh/vision/capture/nested/deep.png': pngBytes(16),
  'D:/proj/.dsh/vision/reference/mismatch.png': jpegBytes(24),
  'D:/proj/.dsh/vision/reference/empty.png': new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
  'D:/elsewhere/outside.png': pngBytes(16),
}

async function layoutFor(files: Record<string, Uint8Array> = SEED, dirs?: readonly string[]): Promise<{
  ctx: ReturnType<typeof createFakeFs>['ctx']
  fake: ReturnType<typeof createFakeFs>
  layout: InboxLayout
}> {
  const fake = createFakeFs({ files, ...(dirs === undefined ? {} : { dirs }) })
  const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
  return { ctx: fake.ctx, fake, layout }
}

describe('sniffImageMediaType', () => {
  it('recognises each supported signature', () => {
    expect(sniffImageMediaType(pngBytes(8))).toBe('image/png')
    expect(sniffImageMediaType(jpegBytes(8))).toBe('image/jpeg')
    expect(sniffImageMediaType(new TextEncoder().encode('GIF87a....'))).toBe('image/gif')
    expect(sniffImageMediaType(new TextEncoder().encode('GIF89a....'))).toBe('image/gif')
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF????WEBPVP8 '))).toBe('image/webp')
  })

  it('rejects other bytes', () => {
    expect(sniffImageMediaType(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]))).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('%PDF-1.7'))).toBeUndefined()
  })

  it('rejects a RIFF file that is not WebP', () => {
    expect(sniffImageMediaType(new TextEncoder().encode('RIFF????WAVEfmt '))).toBeUndefined()
  })

  it('rejects truncated bytes without reading past the end', () => {
    expect(sniffImageMediaType(new Uint8Array([]))).toBeUndefined()
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50]))).toBeUndefined()
    expect(sniffImageMediaType(new TextEncoder().encode('GIF8'))).toBeUndefined()
  })
})

describe('mediaTypeForName', () => {
  it('maps each accepted extension, case-insensitively', () => {
    expect(mediaTypeForName('a.png')).toBe('image/png')
    expect(mediaTypeForName('a.PNG')).toBe('image/png')
    expect(mediaTypeForName('a.jpg')).toBe('image/jpeg')
    expect(mediaTypeForName('a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeForName('a.webp')).toBe('image/webp')
    expect(mediaTypeForName('a.gif')).toBe('image/gif')
  })

  it('declares nothing for other names', () => {
    expect(mediaTypeForName('a.bmp')).toBeUndefined()
    expect(mediaTypeForName('a.txt')).toBeUndefined()
    expect(mediaTypeForName('noextension')).toBeUndefined()
  })
})

describe('sha256Hex', () => {
  it('matches the known digest of the empty input', () => {
    expect(sha256Hex(new Uint8Array([])))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('changes when one byte changes', () => {
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])))
  })
})

describe('resolveInbox', () => {
  it('builds the two zones and the cache under the configured root', async () => {
    const { layout } = await layoutFor()
    expect(normalizePath(layout.root)).toBe(ROOT)
    expect(layout.referenceTarget.displayPath).toBe(ROOT + '/reference')
    expect(layout.captureTarget.displayPath).toBe(ROOT + '/capture')
    expect(layout.cacheTarget.displayPath).toBe(ROOT + '/.cache')
    expect(layout.projectDir).toBe(PROJECT)
  })

  it('honours an absolute root instead of nesting it under the project', async () => {
    const fake = createFakeFs()
    const layout = await resolveInbox(fake.ctx, PROJECT, 'D:/shared/vision')
    expect(normalizePath(layout.root)).toBe('D:/shared/vision')
  })
})

describe('assertInsideInbox', () => {
  it('accepts the root itself and anything beneath it', async () => {
    const { ctx, layout } = await layoutFor()
    expect(() => assertInsideInbox(ctx, layout, layout.rootTarget, 'root')).not.toThrow()
    expect(() => assertInsideInbox(ctx, layout, layout.referenceTarget, 'ref')).not.toThrow()
  })

  it('refuses a sibling directory that merely shares a name prefix', async () => {
    const { ctx, layout } = await layoutFor()
    const sibling = await ctx.fs.resolve('D:/proj/.dsh/vision-archive/x.png', {})
    expect(() => assertInsideInbox(ctx, layout, sibling, 'sibling')).toThrow(/outside the project image inbox/)
  })
})

describe('prepareImage', () => {
  it('reads a valid image and reports its identity', async () => {
    const { ctx, layout } = await layoutFor()
    const image = await prepareImage(ctx, layout, 'reference/mock.png', ['image/png'], 1000)
    expect(image.mediaType).toBe('image/png')
    expect(image.name).toBe('mock.png')
    expect(image.bytes).toBe(64)
    expect(image.path).toBe(ROOT + '/reference/mock.png')
    expect(image.sha256).toBe(sha256Hex(pngBytes(64)))
  })

  it('accepts an absolute path inside the inbox', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, ROOT + '/capture/shot.jpg', ['image/jpeg'], 1000))
      .resolves.toMatchObject({ mediaType: 'image/jpeg' })
  })

  it('accepts a project-relative path that names the inbox explicitly', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, '.dsh/vision/reference/mock.png', ['image/png'], 1000))
      .resolves.toMatchObject({ name: 'mock.png' })
  })

  it('refuses a traversal out of the inbox', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, '../outside.png', ['image/png'], 1000))
      .rejects.toThrow(/outside the project image inbox/)
    await expect(prepareImage(ctx, layout, '../../../../elsewhere/outside.png', ['image/png'], 1000))
      .rejects.toThrow(/outside the project image inbox/)
  })

  it('refuses an absolute path outside the inbox', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'D:/elsewhere/outside.png', ['image/png'], 1000))
      .rejects.toThrow(/outside the project image inbox/)
  })

  it('refuses an empty path before any filesystem work', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, '   ', ['image/png'], 1000))
      .rejects.toThrow(/path must be a non-empty string/)
  })

  it('refuses a missing file', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/absent.png', ['image/png'], 1000))
      .rejects.toThrow(/no such file/)
  })

  it('refuses a directory', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference', ['image/png'], 1000))
      .rejects.toThrow(/not a regular file/)
  })

  it('refuses an extension that declares no image format', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/notes.txt', ['image/png'], 1000))
      .rejects.toThrow(/does not declare a supported image format/)
  })

  it('refuses bytes that disagree with the extension', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/mismatch.png', ['image/png'], 1000))
      .rejects.toThrow(/the extension declares image\/png but the bytes are image\/jpeg/)
  })

  it('refuses a file whose bytes are not an image at all', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/empty.png', ['image/png'], 1000))
      .rejects.toThrow(/not a supported PNG\/JPEG\/WebP\/GIF image/)
  })

  it('refuses a format the configuration does not accept', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/mock.png', ['image/jpeg'], 1000))
      .rejects.toThrow(/image\/png is not an accepted inbox format/)
  })

  it('refuses an oversized file before reading it', async () => {
    const { ctx, layout } = await layoutFor()
    await expect(prepareImage(ctx, layout, 'reference/mock.png', ['image/png'], 10))
      .rejects.toThrow(/64 bytes exceeds the 10-byte inbox limit/)
  })
})

describe('listInboxImages', () => {
  it('lists the reference zone before the capture zone and skips files whose extension declares no image format', async () => {
    const { ctx, layout } = await layoutFor()
    const images = await listInboxImages(ctx, layout, ['image/png', 'image/jpeg'])
    expect(images.map(image => image.zone + '/' + image.name)).toEqual([
      'reference/empty.png',
      'reference/mismatch.png',
      'reference/mock.png',
      'capture/shot.jpg',
    ])
    expect(images[0]?.bytes).toBe(8)
  })

  it('lists by extension only, so a corrupt or mislabelled file is still offered until it is read', async () => {
    const { ctx, layout } = await layoutFor()
    const names = (await listInboxImages(ctx, layout, ['image/png'])).map(image => image.name)
    expect(names).toContain('empty.png')
    expect(names).toContain('mismatch.png')
    expect(names).not.toContain('notes.txt')
    await expect(prepareImage(ctx, layout, 'reference/empty.png', ['image/png'], 1000))
      .rejects.toThrow(/not a supported PNG\/JPEG\/WebP\/GIF image/)
  })

  it('honours the accepted-format filter', async () => {
    const { ctx, layout } = await layoutFor()
    const images = await listInboxImages(ctx, layout, ['image/jpeg'])
    expect(images.map(image => image.name)).toEqual(['shot.jpg'])
  })

  it('reads a missing inbox as empty rather than as an error', async () => {
    const fake = createFakeFs()
    const layout = await resolveInbox(fake.ctx, PROJECT, '.dsh/vision')
    await expect(listInboxImages(fake.ctx, layout, ['image/png'])).resolves.toEqual([])
  })

  it('does not descend into subdirectories', async () => {
    const { ctx, layout } = await layoutFor()
    const images = await listInboxImages(ctx, layout, ['image/png'])
    expect(images.map(image => image.name)).not.toContain('deep.png')
  })
})

describe('ensureInboxIgnored', () => {
  it('writes an inbox-local .gitignore on the first call and leaves it alone afterwards', async () => {
    const { ctx, fake, layout } = await layoutFor()
    await expect(ensureInboxIgnored(ctx, layout)).resolves.toBe(true)
    expect(fake.writes).toEqual([ROOT + '/.gitignore'])
    expect(new TextDecoder().decode(fake.files.get(ROOT + '/.gitignore'))).toBe(INBOX_GITIGNORE)
    await expect(ensureInboxIgnored(ctx, layout)).resolves.toBe(true)
    expect(fake.writes).toHaveLength(1)
  })

  it('ignores the whole inbox subtree and keeps itself visible', async () => {
    expect(INBOX_GITIGNORE.trim().endsWith('*')).toBe(true)
    expect(INBOX_GITIGNORE).toContain('dsh-vision-bridge')
  })
})
