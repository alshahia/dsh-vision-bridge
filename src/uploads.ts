/**
 * The upload index: how GUI-uploaded images become addressable inbox entries.
 *
 * Why an index and not a folder of files: the mounted filesystem service has no
 * binary write. `writeText` is UTF-8, `editText` replaces text, and there is no
 * `writeBytes` or `mkdir` at all — so this plugin cannot put image bytes into
 * `reference/` or `capture/` itself. The harness's own attachment store is the
 * one component that can durably commit bytes, and it is the right owner: it
 * validates the fully decoded raster, applies the deployment's normalization
 * policy, and returns a content-addressed reference that is never a bearer path.
 *
 * So an upload is committed to the attachment store and the inbox keeps a small
 * JSON index that makes it listable and addressable beside the folder images.
 * The two sources stay distinguishable, because they are not equally durable: a
 * folder image is the user's own file, while an upload is an immutable object in
 * the harness store.
 *
 * The index stores only the reference. A filesystem path is never trusted from
 * disk: it is re-derived from the reference by the store itself, which validates
 * the identifier and confines the result to its own root. Hand-editing the index
 * therefore cannot point the bridge at an arbitrary file, which is what keeps
 * this module from becoming a way around `read_image`'s route gate.
 *
 * @module dsh-vision-bridge/uploads
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ImageAttachmentRef,
  ImageMediaType,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { assertInsideInbox, mediaTypeForName, sha256Hex, sniffImageMediaType } from './inbox.ts'
import type { InboxLayout } from './inbox.ts'
import type { InboxZone, PreparedImage } from './types.ts'

/** Index file name, inside the inbox root. */
export const UPLOADS_FILE = 'uploads.json'

/** Index schema revision; a different value is refused rather than reinterpreted. */
export const UPLOADS_VERSION = 1

/** Longest accepted upload name, before the extension. */
export const MAX_UPLOAD_NAME = 120

/**
 * Characters refused in an upload name.
 *
 * The name is not used as a filesystem path — the store is content-addressed —
 * but it IS the user-facing label and part of the `zone/name` address, so a
 * name that cannot round-trip through a path or a shell is refused early rather
 * than becoming a confusing address later.
 */
const ILLEGAL_NAME_CHARS = /[/\\:*?"<>|\u0000-\u001f]/

/**
 * The part of the attachment service this module needs.
 *
 * Structural, not the concrete class, so every path here is fakeable in a unit
 * test without a booted harness — the same reason `service.ts` reads services
 * structurally.
 */
export interface AttachmentStoreLike {
  /** Deployment image policy, when the store exposes it. */
  readonly imageLimits?: {
    readonly mediaTypes?: readonly ImageMediaType[]
    readonly maxMessageImageBytes?: number
  }
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
  /** Host path of a stored image, or undefined when this deployment has none. */
  imageHostPath(ref: ImageAttachmentRef): string | undefined
}

/** One uploaded image recorded in the index. */
export interface InboxUpload {
  zone: InboxZone
  /** The user's chosen name; the store also keeps its own sanitized copy. */
  name: string
  /** The durable harness reference. Everything else is derived from it. */
  ref: ImageAttachmentRef
  uploadedAt: string
}

/** The index as stored. */
export interface UploadIndex {
  version: number
  uploads: InboxUpload[]
}

/** The index plus an honest note when it could not be read. */
export interface UploadIndexRead {
  index: UploadIndex
  /** Set when the file exists but is unusable; the GUI shows it verbatim. */
  problem?: string
}

/** One uploaded image as the GUI and the tools address it. */
export interface UploadedImage {
  zone: InboxZone
  name: string
  /** Host path the store derived from the reference; empty when unavailable. */
  path: string
  bytes: number
  mediaType: ImageMediaType
  width: number
  height: number
  uploadedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/**
 * Accept a stored reference only when every field this module relies on is
 * present and well formed. The index is a file on disk and may have been edited
 * by hand, so it is read as untrusted input rather than cast.
 * @param value - candidate parsed from the index.
 * @returns the reference, or undefined when it is not usable.
 */
function asRef(value: unknown): ImageAttachmentRef | undefined {
  if (!isRecord(value)) return undefined
  const { attachmentId, mediaType, bytes, width, height, name } = value
  if (typeof attachmentId !== 'string' || attachmentId === '') return undefined
  if (typeof mediaType !== 'string' || !MEDIA_TYPES.includes(mediaType as ImageMediaType)) return undefined
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return undefined
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return undefined
  const ref = { attachmentId, mediaType, bytes, width, height } as ImageAttachmentRef
  if (typeof name === 'string' && name !== '') return { ...ref, name }
  return ref
}

/**
 * Parse one index document.
 * @param text - the file's content.
 * @returns the index, or a problem string when the document is unusable.
 */
function parseIndex(text: string): UploadIndex | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error: unknown) {
    return 'the upload index is not valid JSON ('
      + (error instanceof Error ? error.message : String(error)) + ')'
  }
  if (!isRecord(parsed)) return 'the upload index is not a JSON object'
  if (parsed.version !== UPLOADS_VERSION) {
    return 'the upload index declares version ' + String(parsed.version) + ', but this build writes '
      + 'version ' + String(UPLOADS_VERSION) + '; refusing to reinterpret it'
  }
  if (!Array.isArray(parsed.uploads)) return 'the upload index has no "uploads" array'
  const uploads: InboxUpload[] = []
  for (const entry of parsed.uploads) {
    if (!isRecord(entry)) continue
    const zone = entry.zone === 'capture' ? 'capture' : entry.zone === 'reference' ? 'reference' : undefined
    if (zone === undefined) continue
    if (typeof entry.name !== 'string' || entry.name === '') continue
    const ref = asRef(entry.ref)
    if (ref === undefined) continue
    uploads.push({
      zone,
      name: entry.name,
      ref,
      uploadedAt: typeof entry.uploadedAt === 'string' ? entry.uploadedAt : '',
    })
  }
  return { version: UPLOADS_VERSION, uploads }
}

/**
 * Read the upload index.
 *
 * A missing file is an empty index, never an error: a project that has never had
 * an upload is the normal starting state. A file that exists but cannot be used
 * yields an empty index plus a problem string, because a broken index must not
 * make the inbox look broken.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param signal - optional cancellation.
 * @returns the index and an optional problem.
 */
export async function readUploadIndex(
  ctx: Context,
  layout: InboxLayout,
  signal?: AbortSignal,
): Promise<UploadIndexRead> {
  const target = await ctx.fs.resolve(join(layout.root, UPLOADS_FILE), { signal })
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined || info.type !== 'file') return { index: { version: UPLOADS_VERSION, uploads: [] } }
  let text: string
  try {
    text = await ctx.fs.readText(target, signal)
  } catch (error: unknown) {
    return {
      index: { version: UPLOADS_VERSION, uploads: [] },
      problem: 'the upload index could not be read: '
        + (error instanceof Error ? error.message : String(error)),
    }
  }
  const parsed = parseIndex(text)
  if (typeof parsed === 'string') return { index: { version: UPLOADS_VERSION, uploads: [] }, problem: parsed }
  return { index: parsed }
}

/**
 * Write the index back through a revision-guarded write.
 *
 * The guard is the point: a concurrent upload would otherwise silently drop one
 * of the two entries, and the loser would be an image the user believes they
 * added. A version mismatch surfaces as a refusal the route can report.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param index - the complete index to store.
 * @param signal - optional cancellation.
 */
async function writeUploadIndex(
  ctx: Context,
  layout: InboxLayout,
  index: UploadIndex,
  signal?: AbortSignal,
): Promise<void> {
  const target = await ctx.fs.resolve(join(layout.root, UPLOADS_FILE), { signal })
  assertInsideInbox(ctx, layout, target, UPLOADS_FILE)
  const info = await ctx.fs.stat(target, signal)
  const intent: FsWriteIntent = info === undefined
    ? { kind: 'createIfAbsent' }
    : { kind: 'replaceIfVersion', version: info.version }
  await ctx.fs.writeText(target, JSON.stringify(index, null, 2) + '\n', intent, signal)
}

/**
 * Add one upload to the index.
 *
 * Refuses to touch an index that exists but cannot be parsed: overwriting it
 * would destroy entries this build cannot read, and silently discarding a user's
 * upload history to accept one more image is the wrong trade.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param upload - the entry to append.
 * @param signal - optional cancellation.
 * @returns the index after the append.
 */
export async function appendUpload(
  ctx: Context,
  layout: InboxLayout,
  upload: InboxUpload,
  signal?: AbortSignal,
): Promise<UploadIndex> {
  const read = await readUploadIndex(ctx, layout, signal)
  if (read.problem !== undefined) {
    throw new Error(read.problem + '; fix or remove ' + join(layout.root, UPLOADS_FILE)
      + ' before uploading again, so existing entries are not lost')
  }
  const next: UploadIndex = { version: UPLOADS_VERSION, uploads: [...read.index.uploads, upload] }
  await writeUploadIndex(ctx, layout, next, signal)
  return next
}

/**
 * The host path an upload is addressed by, or undefined when this deployment
 * cannot expose one.
 * @param attachments - the attachment store.
 * @param upload - the index entry.
 * @returns an absolute path, or undefined.
 */
export function uploadPath(attachments: AttachmentStoreLike, upload: InboxUpload): string | undefined {
  try {
    const path = attachments.imageHostPath(upload.ref)
    return typeof path === 'string' && path !== '' ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * Every address an upload answers to.
 *
 * The derived host path is the primary address — it is absolute, unique, and
 * directly usable by `read_image`. `zone/name` is accepted as well because that
 * is what a person reads off the panel and types.
 * @param upload - the index entry.
 * @param path - its derived host path, when available.
 * @returns the accepted address strings, lowercased for comparison.
 */
function addressesOf(upload: InboxUpload, path: string | undefined): string[] {
  const addresses = [upload.zone + '/' + upload.name]
  if (path !== undefined) addresses.push(path)
  return addresses.map(address => address.toLowerCase())
}

/**
 * Find the upload a caller's path names.
 * @param attachments - the attachment store.
 * @param index - the upload index.
 * @param requestedPath - the caller's path or `zone/name`.
 * @returns the matching entry, or undefined.
 */
export function findUpload(
  attachments: AttachmentStoreLike,
  index: UploadIndex,
  requestedPath: string,
): InboxUpload | undefined {
  const wanted = requestedPath.trim().toLowerCase()
  if (wanted === '') return undefined
  for (const upload of index.uploads) {
    if (addressesOf(upload, uploadPath(attachments, upload)).includes(wanted)) return upload
  }
  return undefined
}

/**
 * List the uploads as addressable entries.
 * @param attachments - the attachment store.
 * @param index - the upload index.
 * @returns one entry per usable upload; an entry whose path cannot be derived is
 *   still listed, with an empty path, so the count never lies about what exists.
 */
export function listUploads(attachments: AttachmentStoreLike, index: UploadIndex): UploadedImage[] {
  return index.uploads.map((upload) => {
    const path = uploadPath(attachments, upload)
    return {
      zone: upload.zone,
      name: upload.name,
      path: path ?? '',
      bytes: upload.ref.bytes,
      mediaType: upload.ref.mediaType,
      width: upload.ref.width,
      height: upload.ref.height,
      uploadedAt: upload.uploadedAt,
    }
  })
}

/**
 * Read one uploaded image back through the store.
 *
 * Bytes come from the store, never from a path, so there is no path to
 * traverse: the store resolves its own reference and verifies the digest.
 * @param attachments - the attachment store.
 * @param upload - the index entry to read.
 * @param maxBytes - byte cap applied before the read.
 * @param signal - optional cancellation.
 * @returns the prepared image.
 */
export async function prepareUpload(
  attachments: AttachmentStoreLike,
  upload: InboxUpload,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PreparedImage> {
  const path = uploadPath(attachments, upload)
  if (path === undefined) {
    throw new Error('cannot read the uploaded image "' + upload.zone + '/' + upload.name
      + '": this deployment\'s attachment store does not expose a filesystem path for a stored image, '
      + 'so a vision route cannot be pointed at it')
  }
  if (upload.ref.bytes > maxBytes) {
    throw new Error('cannot read "' + path + '": ' + String(upload.ref.bytes)
      + ' bytes exceeds the ' + String(maxBytes) + '-byte inbox limit; downscale the image or raise '
      + 'inbox.maxBytes')
  }
  const stored = await attachments.readImage(upload.ref, signal)
  const sniffed = sniffImageMediaType(stored.data)
  if (sniffed === undefined) {
    throw new Error('cannot read "' + path + '": the stored bytes are not a supported PNG/JPEG/WebP/GIF '
      + 'image; the attachment store returned content this build cannot identify')
  }
  return {
    path,
    name: upload.name,
    mediaType: sniffed,
    data: stored.data,
    sha256: sha256Hex(stored.data),
    bytes: stored.data.byteLength,
  }
}

/** The outcome of checking an upload's name. */
export type UploadNameCheck = { ok: true, name: string, mediaType: ImageMediaType } | { ok: false, error: string }

/**
 * Check an upload name and derive the media type it declares.
 * @param raw - the name the browser supplied.
 * @param formats - accepted media types.
 * @returns the accepted name and declared media type, or a refusal.
 */
export function checkUploadName(raw: string, formats: readonly ImageMediaType[]): UploadNameCheck {
  const name = raw.trim()
  if (name === '') return { ok: false, error: 'the upload has no file name' }
  if (name.length > MAX_UPLOAD_NAME) {
    return { ok: false, error: 'the file name is longer than ' + String(MAX_UPLOAD_NAME) + ' characters' }
  }
  if (name === '.' || name === '..') return { ok: false, error: 'the file name "' + name + '" is not a file name' }
  if (name.startsWith('.')) {
    return { ok: false, error: 'the file name "' + name + '" starts with a dot; hidden files are not accepted' }
  }
  if (ILLEGAL_NAME_CHARS.test(name)) {
    return { ok: false, error: 'the file name "' + name + '" contains a character that is not allowed in a '
      + 'name: / \\ : * ? " < > | and control characters are refused' }
  }
  const mediaType = mediaTypeForName(name)
  if (mediaType === undefined) {
    return { ok: false, error: 'the file name "' + name + '" does not declare a supported image format; '
      + 'the inbox accepts PNG/JPEG/WebP/GIF' }
  }
  if (!formats.includes(mediaType)) {
    return { ok: false, error: mediaType + ' is not an accepted inbox format; raise inbox.formats to accept it' }
  }
  return { ok: true, name, mediaType }
}

/**
 * Check that the bytes are the image the name claims.
 * @param data - the decoded upload bytes.
 * @param declared - the media type the name declared.
 * @param maxBytes - byte cap.
 * @returns a refusal message, or undefined when the bytes are acceptable.
 */
export function checkUploadBytes(
  data: Uint8Array,
  declared: ImageMediaType,
  maxBytes: number,
): string | undefined {
  if (data.byteLength === 0) return 'the uploaded file is empty'
  if (data.byteLength > maxBytes) {
    return String(data.byteLength) + ' bytes exceeds the ' + String(maxBytes)
      + '-byte inbox limit; downscale the image or raise inbox.maxBytes'
  }
  const sniffed = sniffImageMediaType(data)
  if (sniffed === undefined) {
    return 'the uploaded bytes are not a supported PNG/JPEG/WebP/GIF image; the file may be truncated, '
      + 'corrupt, or renamed'
  }
  if (sniffed !== declared) {
    return 'the file name declares ' + declared + ' but the bytes are ' + sniffed
      + '; rename the file to match its actual format'
  }
  return undefined
}

/**
 * Decode canonical base64.
 *
 * Deliberately strict: `Buffer.from(text, 'base64')` silently ignores characters
 * it does not recognise, which would turn a truncated or HTML-error upload into a
 * short byte string instead of a refusal. Canonical input is checked by
 * re-encoding and comparing.
 * @param text - base64 text, without a `data:` prefix.
 * @returns the bytes, or undefined when the input is not canonical base64.
 */
export function decodeBase64(text: string): Uint8Array | undefined {
  const compact = text.replace(/\s+/g, '')
  if (compact === '') return undefined
  if (compact.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined
  const data = Buffer.from(compact, 'base64')
  if (data.toString('base64') !== compact) return undefined
  return new Uint8Array(data)
}
