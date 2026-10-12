/**
 * The per-project image inbox: layout, containment, validation, and listing.
 *
 * Why a folder and not an attachment: a plain file never enters prompt
 * admission, so the host's "model does not support image input" refusal
 * (`packages/api/session-controller/src/commands.ts:336-348`) can never fire on
 * the way in. The image becomes an attachment only inside the vision call, on a
 * route that genuinely declares image input.
 *
 * Two zones carry different trust, and nothing here blurs them:
 * - `reference/` — user-authored truth (mockups, brand sheets, design specs);
 * - `capture/`   — agent-produced evidence (screenshots of the running app).
 *
 * Every path is resolved through the mounted filesystem backend and then
 * checked with `ctx.fs.contains`, so a traversal (`..\..\secret.png`) or an
 * absolute path elsewhere is refused before any byte is read. Extensions are
 * never trusted: the magic bytes decide the media type, and a file whose bytes
 * disagree with its name is refused rather than reinterpreted.
 *
 * @module dsh-vision-bridge/inbox
 */
import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { InboxZone, PreparedImage } from './types.ts'

/** Extensions accepted for listing and upload; the bytes stay authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const

/**
 * The inbox `.gitignore`, written inside the inbox folder itself.
 *
 * Deliberately NOT an edit to the project's own `.gitignore`: mutating a file
 * the user owns, to ignore a folder the plugin created, is a surprising side
 * effect and a merge hazard. A `.gitignore` inside the folder ignores the whole
 * subtree and is self-documenting.
 */
export const INBOX_GITIGNORE = '# Written by dsh-vision-bridge: keep the project image inbox out of git.\n'
  + '# Set inbox.gitIgnore=false in Settings -> Plugins -> dsh-vision-bridge to stop writing this file.\n'
  + '*\n'

/** One inbox folder set, resolved through the mounted filesystem backend. */
export interface InboxLayout {
  /** Absolute project directory that owns this inbox. */
  projectDir: string
  /** Absolute inbox root. */
  root: string
  rootTarget: FsTarget
  referenceTarget: FsTarget
  captureTarget: FsTarget
  cacheTarget: FsTarget
}

/** One image found in the inbox. */
export interface InboxImage {
  zone: InboxZone
  name: string
  /** Model/UI-facing path, as the backend reports it. */
  path: string
  bytes: number
}

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false
  return expected.every((byte, index) => data[offset + index] === byte)
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false
  }
  return true
}

/**
 * Identify the media type declared by a supported image file signature.
 *
 * A local copy of the same four signatures `read_image` uses
 * (`packages/fs/tool-fs/src/read-image.ts:54-60`); the module is not exported
 * from that package, and a cross-plugin value import is forbidden.
 * @param data - file bytes read through the current filesystem backend.
 * @returns the detected media type, or undefined for other bytes.
 */
export function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return 'image/png'
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return 'image/jpeg'
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'image/gif'
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'image/webp'
  return undefined
}

/**
 * Map a file name to the media type its extension claims.
 * @param name - file name or path.
 * @returns the declared media type, or undefined when the extension claims none.
 */
export function mediaTypeForName(name: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(name).toLowerCase()]
}

/**
 * Lowercase hex sha256 of exactly these bytes.
 * @param data - the bytes to digest.
 * @returns 64 hex characters.
 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Resolve the inbox folder set for one project.
 *
 * `root` is normally relative to the project directory; an absolute value is
 * honoured as-is so a user can keep one inbox outside the repository.
 * @param ctx - context providing the filesystem service.
 * @param projectDir - absolute project directory owning the inbox.
 * @param root - configured inbox root.
 * @param signal - optional cancellation.
 * @returns the resolved layout.
 */
export async function resolveInbox(
  ctx: Context,
  projectDir: string,
  root: string,
  signal?: AbortSignal,
): Promise<InboxLayout> {
  const rootPath = isAbsolute(root) ? root : join(projectDir, root)
  return {
    projectDir,
    root: rootPath,
    rootTarget: await ctx.fs.resolve(rootPath, { signal }),
    referenceTarget: await ctx.fs.resolve(join(rootPath, 'reference'), { signal }),
    captureTarget: await ctx.fs.resolve(join(rootPath, 'capture'), { signal }),
    cacheTarget: await ctx.fs.resolve(join(rootPath, '.cache'), { signal }),
  }
}

/**
 * Refuse a target that is not inside the inbox root.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param target - the resolved target to check.
 * @param displayPath - the caller's original path, for the refusal message.
 */
export function assertInsideInbox(
  ctx: Context,
  layout: InboxLayout,
  target: FsTarget,
  displayPath: string,
): void {
  if (!ctx.fs.contains(layout.rootTarget, target)) {
    throw new Error('refusing "' + displayPath + '": it is outside the project image inbox ('
      + layout.root + ')')
  }
}

/**
 * Read and validate one image from the inbox.
 *
 * Validation order matters: containment, then existence, then the declared
 * format, then the byte cap, and only then the read. A refusal therefore never
 * pulls a file into memory, and a `.png` full of something else is refused
 * rather than handed to the attachment service to fail confusingly later.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param requestedPath - the caller's path; relative resolves against the project directory.
 * @param formats - accepted media types.
 * @param maxBytes - pre-read byte cap.
 * @param signal - optional cancellation.
 * @returns the prepared image, ready for an attachment write.
 */
export async function prepareImage(
  ctx: Context,
  layout: InboxLayout,
  requestedPath: string,
  formats: readonly ImageMediaType[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PreparedImage> {
  const raw = requestedPath.trim()
  if (raw === '') throw new Error('path must be a non-empty string')

  // A relative path is tried against the inbox root first (so `reference/x.png`
  // works, matching what listing shows) and then against the project directory
  // (so `.dsh/vision/reference/x.png` works too). Both candidates pass the same
  // containment check, so accepting two bases widens convenience, not trust.
  //
  // Existence decides between two contained candidates: the first base can name
  // a path that is legitimately inside the inbox yet absent (an inbox-relative
  // reading of `.dsh/vision/reference/x.png`), and reporting "no such file" for
  // it would hide the second base's real file.
  const candidates: FsTarget[] = []
  for (const cwd of [layout.root, layout.projectDir]) {
    const candidate = await ctx.fs.resolve(raw, { cwd, signal })
    if (ctx.fs.contains(layout.rootTarget, candidate)) candidates.push(candidate)
  }
  if (candidates.length === 0) {
    throw new Error('refusing "' + raw + '": it is outside the project image inbox ('
      + layout.root + '); pass a path inside it, relative to the inbox root or to '
      + layout.projectDir)
  }
  let target = candidates[0]!
  for (const candidate of candidates) {
    if ((await ctx.fs.stat(candidate, signal))?.type === 'file') {
      target = candidate
      break
    }
  }

  const info = await ctx.fs.stat(target, signal)
  if (info === undefined) throw new Error('cannot read "' + target.displayPath + '": no such file')
  if (info.type !== 'file') throw new Error('cannot read "' + target.displayPath + '": not a regular file')

  const declared = mediaTypeForName(target.displayPath)
  if (declared === undefined) {
    throw new Error('cannot read "' + target.displayPath + '": the extension does not declare a '
      + 'supported image format; the inbox accepts PNG/JPEG/WebP/GIF')
  }
  if (!formats.includes(declared)) {
    throw new Error('cannot read "' + target.displayPath + '": ' + declared
      + ' is not an accepted inbox format; raise inbox.formats to accept it')
  }
  if (info.size !== undefined && info.size > maxBytes) {
    throw new Error('cannot read "' + target.displayPath + '": ' + String(info.size)
      + ' bytes exceeds the ' + String(maxBytes) + '-byte inbox limit; downscale the image or raise '
      + 'inbox.maxBytes')
  }

  const data = await ctx.fs.readBytes(target, signal, maxBytes)
  const sniffed = sniffImageMediaType(data)
  if (sniffed === undefined) {
    throw new Error('cannot read "' + target.displayPath + '": the file content is not a supported '
      + 'PNG/JPEG/WebP/GIF image; the file may be truncated, corrupt, or renamed')
  }
  if (sniffed !== declared) {
    throw new Error('cannot read "' + target.displayPath + '": the extension declares ' + declared
      + ' but the bytes are ' + sniffed + '; rename the file to match its actual format')
  }
  if (!formats.includes(sniffed)) {
    throw new Error('cannot read "' + target.displayPath + '": ' + sniffed
      + ' is not an accepted inbox format')
  }

  return {
    path: ctx.fs.processPath(target),
    name: basename(target.displayPath),
    mediaType: sniffed,
    data,
    sha256: sha256Hex(data),
    bytes: data.byteLength,
  }
}

/** List one zone. A missing folder reads as empty; it is never an error. */
async function listZone(
  ctx: Context,
  zone: InboxZone,
  target: FsTarget,
  formats: readonly ImageMediaType[],
  signal?: AbortSignal,
): Promise<InboxImage[]> {
  const info = await ctx.fs.stat(target, signal)
  if (info === undefined || info.type !== 'directory') return []
  const entries = await ctx.fs.listDir(target, signal)
  const images: InboxImage[] = []
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const mediaType = mediaTypeForName(entry.name)
    if (mediaType === undefined || !formats.includes(mediaType)) continue
    images.push({
      zone,
      name: entry.name,
      path: ctx.fs.processPath(entry.target),
      bytes: entry.size ?? 0,
    })
  }
  return images
}

/**
 * List every image in the inbox, `reference/` first.
 *
 * `listDir` already returns a stable name order, so the result is deterministic
 * without a second sort — which matters because the `compare` task defines the
 * FIRST image as the reference.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param formats - accepted media types.
 * @param signal - optional cancellation.
 * @returns the images found, reference zone first.
 */
export async function listInboxImages(
  ctx: Context,
  layout: InboxLayout,
  formats: readonly ImageMediaType[],
  signal?: AbortSignal,
): Promise<InboxImage[]> {
  const reference = await listZone(ctx, 'reference', layout.referenceTarget, formats, signal)
  const capture = await listZone(ctx, 'capture', layout.captureTarget, formats, signal)
  return [...reference, ...capture]
}

/**
 * Write the inbox's own `.gitignore` when the user asked for git hygiene.
 *
 * Idempotent and total: a failure here is reported by the caller, never thrown
 * into an operation that had nothing to do with git.
 * @param ctx - context providing the filesystem service.
 * @param layout - the resolved inbox.
 * @param signal - optional cancellation.
 * @returns true when the file already had the expected content or was written.
 */
export async function ensureInboxIgnored(
  ctx: Context,
  layout: InboxLayout,
  signal?: AbortSignal,
): Promise<boolean> {
  const target = await ctx.fs.resolve(join(layout.root, '.gitignore'), { signal })
  assertInsideInbox(ctx, layout, target, '.gitignore')
  let existing: string | undefined
  try {
    existing = await ctx.fs.readText(target, signal)
  } catch {
    existing = undefined
  }
  if (existing === INBOX_GITIGNORE) return true
  await ctx.fs.writeText(target, INBOX_GITIGNORE, undefined, signal)
  return true
}
