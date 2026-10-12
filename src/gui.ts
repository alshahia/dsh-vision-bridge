/**
 * Host HTTP routes behind the vision inbox panel.
 *
 * Three routes, and one deliberate refusal:
 *
 * - `GET  /dsh-vision-bridge/inbox`  — what the panel renders;
 * - `POST /dsh-vision-bridge/upload` — commit an image the user picked;
 * - `POST /dsh-vision-bridge/remove` — always 501, honestly.
 *
 * The refusal is a feature. The mounted filesystem service has no delete or
 * unlink primitive, and an attachment-store object is immutable and
 * content-addressed, so this plugin genuinely cannot remove an image. A route
 * that pretended otherwise would be the one place in this plugin where the user
 * is told something untrue about what happened, so instead the panel shows the
 * exact path to remove by hand.
 *
 * Configuration is deliberately absent here. The harness renders this plugin's
 * volatile `Config` as a native, validated, revision-safe settings form, so the
 * panel is a view and an upload surface and must not duplicate those inputs.
 *
 * A route handler receives a raw request: there is no session and no Agent on
 * it. The panel is registered into a session-scoped slot, so it passes its own
 * `sessionId` and the host resolves that session's project directory — the inbox
 * stays per-project rather than per-process.
 *
 * @module dsh-vision-bridge/gui
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { sha256Hex } from './inbox.ts'
import type { InboxImage, InboxLayout } from './inbox.ts'
import { safeGet } from './service.ts'
import {
  checkUploadBytes,
  checkUploadName,
  decodeBase64,
  listUploads,
  uploadPath,
} from './uploads.ts'
import type { AttachmentStoreLike, InboxUpload, UploadIndexRead } from './uploads.ts'
import type { InboxZone, ResolvedVisionConfig } from './types.ts'

/** Panel listing route. */
export const INBOX_ROUTE = '/dsh-vision-bridge/inbox'
/** Upload route. */
export const UPLOAD_ROUTE = '/dsh-vision-bridge/upload'
/** Remove route; refuses by design. */
export const REMOVE_ROUTE = '/dsh-vision-bridge/remove'

/**
 * Largest accepted request body.
 *
 * Sized for base64 expansion: a 16 MiB body carries roughly a 12 MiB image, and
 * the configured `inbox.maxBytes` is applied to the decoded bytes afterwards.
 */
export const MAX_UPLOAD_BODY_BYTES = 16 * 1024 * 1024

/** One route as this module registers it. */
export interface GuiRoute {
  kind: 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The slice of the web server this module needs. */
export interface WebServerLike {
  register(route: GuiRoute): () => void
}

/**
 * Everything the routes need, injected so every handler is testable without a
 * booted harness. Each filesystem- and Cordis-touching operation is a closure the
 * caller supplies, which keeps this module free of both.
 */
export interface VisionGuiDeps {
  /** The project directory owning a session, or the fallback when unknown. */
  projectDirFor(sessionId: string | undefined): string
  /** Read live config and resolve the inbox for one project directory. */
  scopeFor(
    projectDir: string,
    signal?: AbortSignal,
  ): Promise<{ config: ResolvedVisionConfig, layout: InboxLayout }>
  /** List the images physically present in the folder zones. */
  listFolder(
    layout: InboxLayout,
    formats: readonly ImageMediaType[],
    signal?: AbortSignal,
  ): Promise<InboxImage[]>
  /** Read the upload index. */
  readIndex(layout: InboxLayout, signal?: AbortSignal): Promise<UploadIndexRead>
  /** Append one upload to the index. */
  appendIndex(layout: InboxLayout, upload: InboxUpload, signal?: AbortSignal): Promise<void>
  /** One line describing the mounted vision sub-agents. */
  childSummary(): string
  /** Probe the configured route for image capability. */
  probeRoute(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ imageCapable: boolean, detail: string }>
  /** The attachment store, read per request because it may mount after this plugin. */
  attachments(): AttachmentStoreLike | undefined
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Write one JSON response. Never throws: a gone client is not an error here. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.writableEnded === true) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {
    // The client disconnected; there is nothing left to report to.
  }
}

/** Report a method that this route does not serve. */
function methodNotAllowed(res: ServerResponse, allowed: string): void {
  try {
    res.setHeader('allow', allowed)
  } catch {
    // A header write failure must not hide the refusal itself.
  }
  send(res, 405, { ok: false, error: 'this route accepts ' + allowed + ' only' })
}

/**
 * A cancellation signal for one request.
 *
 * Wired to the response rather than the request: a request stream also closes
 * when its body has been fully read, which would abort the work that body asked
 * for. The response closes when the client has actually gone away.
 * @param res - the response being written.
 * @returns a signal that aborts when the client disconnects.
 */
function requestSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  try {
    res.on('close', () => { controller.abort() })
  } catch {
    // Without a close event the signal simply never aborts.
  }
  return controller.signal
}

/**
 * Refuse a cross-origin write.
 *
 * Plugin routes on this web server are not behind the GUI's session gate — a
 * deliberate property of the host, and one this plugin does not get to change.
 * What it can do is refuse a browser request that another origin initiated, so a
 * page the user happens to have open cannot post images into their project.
 * @param req - the incoming request.
 * @returns a refusal reason, or undefined when the request is same-origin.
 */
function crossOriginReason(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin
  if (origin === undefined || origin === '' || origin === 'null') return undefined
  const host = req.headers.host
  if (host === undefined || host === '') return 'the request carries an Origin but no Host header'
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return 'the request Origin is not a valid URL'
  }
  if (parsed.host !== host) {
    return 'the request Origin (' + origin + ') does not match this server (' + host + ')'
  }
  return undefined
}

/** The result of reading a request body. */
type BodyResult =
  | { ok: true, value: Record<string, unknown> }
  | { ok: false, status: number, error: string }

/** Read a bounded JSON object body. */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as string)
      total += bytes.byteLength
      if (total > limit) {
        return {
          ok: false,
          status: 413,
          error: 'the request body exceeds the ' + String(limit) + '-byte limit; send one image per request',
        }
      }
      chunks.push(bytes)
    }
  } catch (error: unknown) {
    return { ok: false, status: 400, error: 'the request body could not be read: ' + messageOf(error) }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') {
    return { ok: false, status: 400, error: 'the request body is empty; a JSON object is required' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, error: 'the request body is not valid JSON' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 400, error: 'the request body is not a JSON object' }
  }
  return { ok: true, value: parsed }
}

/** Read an optional session id from a query string or a body value. */
function sessionOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The session id on a GET query string. */
function querySession(req: IncomingMessage): string | undefined {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return sessionOf(url.searchParams.get('session'))
  } catch {
    return undefined
  }
}

/** Accept only the two zones that exist. */
function zoneOf(value: unknown): InboxZone | undefined {
  return value === 'reference' || value === 'capture' ? value : undefined
}

/**
 * Build the listing payload the panel renders.
 *
 * Exported so a test can drive it directly, exactly as the route does.
 * @param deps - injected dependencies.
 * @param config - the resolved configuration.
 * @param layout - the resolved inbox.
 * @param signal - cancellation.
 * @returns the JSON body.
 */
export async function buildListing(
  deps: VisionGuiDeps,
  config: ResolvedVisionConfig,
  layout: InboxLayout,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const attachments = deps.attachments()
  const read = await deps.readIndex(layout, signal)
  const uploads = attachments === undefined ? [] : listUploads(attachments, read.index)
  const folder = await deps.listFolder(layout, config.inbox.formats, signal)

  const routeLabel = config.route.provider === '' ? '' : config.route.provider + '/' + config.route.model
  let routeReady = false
  let routeDetail = 'no route configured'
  if (routeLabel !== '') {
    try {
      const facts = await deps.probeRoute(config.route.provider, config.route.model, signal)
      routeReady = facts.imageCapable
      routeDetail = facts.detail
    } catch (error: unknown) {
      routeDetail = 'could not be resolved: ' + messageOf(error)
    }
  }

  const images = [
    ...folder.map(image => ({
      zone: image.zone,
      name: image.name,
      path: image.path,
      bytes: image.bytes,
      source: 'folder' as const,
    })),
    ...uploads.map(image => ({
      zone: image.zone,
      name: image.name,
      path: image.path,
      bytes: image.bytes,
      source: 'upload' as const,
    })),
  ]

  return {
    ok: true,
    enabled: config.enabled,
    projectDir: layout.projectDir,
    inbox: layout.root,
    route: routeLabel,
    routeReady,
    routeDetail,
    agents: deps.childSummary(),
    tasks: config.tasks.map(task => task.id),
    zones: {
      reference: layout.referenceTarget.displayPath,
      capture: layout.captureTarget.displayPath,
    },
    uploadsSupported: attachments !== undefined,
    images,
    canDelete: false,
    deleteHint: 'dsh-vision-bridge cannot delete files: the mounted filesystem service has no delete or '
      + 'unlink primitive, and an attachment-store object is immutable and content-addressed. Remove the '
      + 'file yourself at the path shown.',
    ...(read.problem === undefined ? {} : { problem: read.problem }),
  }
}

/** The listing route's handler. */
async function inboxHandler(req: IncomingMessage, res: ServerResponse, deps: VisionGuiDeps): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET')
    return
  }
  const signal = requestSignal(res)
  const projectDir = deps.projectDirFor(querySession(req))
  try {
    const { config, layout } = await deps.scopeFor(projectDir, signal)
    send(res, 200, await buildListing(deps, config, layout, signal))
  } catch (error: unknown) {
    send(res, 500, {
      ok: false,
      error: 'the vision inbox could not be read: ' + messageOf(error),
      projectDir,
    })
  }
}

/** The upload route's handler. */
async function uploadHandler(req: IncomingMessage, res: ServerResponse, deps: VisionGuiDeps): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  const crossOrigin = crossOriginReason(req)
  if (crossOrigin !== undefined) {
    send(res, 403, { ok: false, error: crossOrigin })
    return
  }
  const attachments = deps.attachments()
  if (attachments === undefined) {
    send(res, 503, {
      ok: false,
      error: 'this profile mounts no attachment store, so an uploaded image could not be committed '
        + 'durably; the folder zones still work',
    })
    return
  }
  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES)
  if (!body.ok) {
    send(res, body.status, { ok: false, error: body.error })
    return
  }
  const zone = zoneOf(body.value.zone)
  if (zone === undefined) {
    send(res, 400, {
      ok: false,
      error: 'zone must be "reference" (user-authored design) or "capture" (screenshot of the running app)',
    })
    return
  }
  const rawName = body.value.name
  if (typeof rawName !== 'string') {
    send(res, 400, { ok: false, error: 'name must be the uploaded file\'s name, as a string' })
    return
  }
  const rawData = body.value.data
  if (typeof rawData !== 'string') {
    send(res, 400, { ok: false, error: 'data must be the image as canonical base64 text' })
    return
  }

  const signal = requestSignal(res)
  const projectDir = deps.projectDirFor(sessionOf(body.value.session))
  let config: ResolvedVisionConfig
  let layout: InboxLayout
  try {
    ({ config, layout } = await deps.scopeFor(projectDir, signal))
  } catch (error: unknown) {
    send(res, 500, { ok: false, error: 'the vision inbox could not be resolved: ' + messageOf(error) })
    return
  }

  const named = checkUploadName(rawName, config.inbox.formats)
  if (!named.ok) {
    send(res, 400, { ok: false, error: named.error })
    return
  }
  const data = decodeBase64(rawData)
  if (data === undefined) {
    send(res, 400, {
      ok: false,
      error: 'data is not canonical base64; send the bytes exactly as the browser encoded them, without '
        + 'a "data:" prefix',
    })
    return
  }
  const byteProblem = checkUploadBytes(data, named.mediaType, config.inbox.maxBytes)
  if (byteProblem !== undefined) {
    send(res, data.byteLength > config.inbox.maxBytes ? 413 : 400, { ok: false, error: byteProblem })
    return
  }

  // Collision is checked before anything is committed, so a refused upload leaves
  // no orphaned object in the store and no index entry to explain.
  try {
    const existing = await deps.listFolder(layout, config.inbox.formats, signal)
    const takenInFolder = existing.some(image => image.zone === zone && image.name === named.name)
    const takenInUploads = listUploads(attachments, (await deps.readIndex(layout, signal)).index)
      .some(image => image.zone === zone && image.name === named.name)
    if (takenInFolder || takenInUploads) {
      send(res, 409, {
        ok: false,
        error: 'the ' + zone + ' zone already holds an image named "' + named.name + '"',
        hint: 'rename the file before uploading it; this plugin never overwrites an existing image',
      })
      return
    }
  } catch (error: unknown) {
    send(res, 500, { ok: false, error: 'the inbox could not be listed: ' + messageOf(error) })
    return
  }

  let ref: ImageAttachmentRef
  try {
    ref = await attachments.saveImage({ data, mediaType: named.mediaType, name: named.name })
  } catch (error: unknown) {
    send(res, 400, { ok: false, error: 'the image was refused by the attachment store: ' + messageOf(error) })
    return
  }

  const entry: InboxUpload = { zone, name: named.name, ref, uploadedAt: new Date().toISOString() }
  const path = uploadPath(attachments, entry)
  if (path === undefined) {
    send(res, 503, {
      ok: false,
      error: 'the image was committed to the attachment store, but this deployment does not expose a '
        + 'filesystem path for a stored image, so a vision route cannot be pointed at it',
    })
    return
  }

  try {
    await deps.appendIndex(layout, entry, signal)
  } catch (error: unknown) {
    send(res, 409, {
      ok: false,
      error: 'the upload index could not be updated: ' + messageOf(error),
      hint: 'the image is committed in the attachment store but is not listed in the inbox index',
    })
    return
  }

  send(res, 200, {
    ok: true,
    zone,
    name: named.name,
    path,
    bytes: data.byteLength,
    mediaType: named.mediaType,
    sha256: sha256Hex(data),
  })
}

/** The remove route's handler: an honest, permanent refusal. */
async function removeHandler(req: IncomingMessage, res: ServerResponse, deps: VisionGuiDeps): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  const crossOrigin = crossOriginReason(req)
  if (crossOrigin !== undefined) {
    send(res, 403, { ok: false, error: crossOrigin })
    return
  }
  void deps
  const body = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES).catch(() => undefined)
  const path = body !== undefined && body.ok && typeof body.value.path === 'string' ? body.value.path : ''
  send(res, 501, {
    ok: false,
    error: 'dsh-vision-bridge cannot delete files',
    ...(path === '' ? {} : { path }),
    hint: 'the mounted filesystem service has no delete or unlink primitive, and an attachment-store object '
      + 'is immutable and content-addressed. Remove the file yourself'
      + (path === '' ? '' : ' at ' + path) + '.',
  })
}

/**
 * Build the three routes.
 * @param deps - injected dependencies.
 * @returns the routes to register.
 */
export function createVisionRoutes(deps: VisionGuiDeps): GuiRoute[] {
  return [
    { kind: 'exact', path: INBOX_ROUTE, handler: (req, res) => inboxHandler(req, res, deps) },
    { kind: 'exact', path: UPLOAD_ROUTE, handler: (req, res) => uploadHandler(req, res, deps) },
    { kind: 'exact', path: REMOVE_ROUTE, handler: (req, res) => removeHandler(req, res, deps) },
  ]
}

/**
 * Register the routes on the web server, when this composition has one.
 *
 * Absence is reported, not thrown: a headless composition is a legitimate place
 * to mount this plugin, and the tools work there.
 * @param ctx - plugin context.
 * @param deps - injected dependencies.
 * @returns whether the routes were registered.
 */
export function installVisionGui(ctx: Context, deps: VisionGuiDeps): boolean {
  const server = safeGet<WebServerLike>(ctx, 'webServer')
  if (server === undefined || typeof server.register !== 'function') {
    ctx.logger.info('dsh-vision-bridge: no web server in this composition; the inbox panel is off and the '
      + 'tools are unaffected')
    return false
  }
  try {
    ctx.effect(() => {
      const disposers: Array<() => void> = []
      for (const route of createVisionRoutes(deps)) {
        try {
          disposers.push(server.register(route))
        } catch (error: unknown) {
          ctx.logger.warn('dsh-vision-bridge: could not register ' + route.path + ' (' + messageOf(error)
            + '); the inbox panel is partly unavailable')
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // A failing disposer must not stop the remaining ones.
          }
        }
      }
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn('dsh-vision-bridge: could not install the inbox panel (' + messageOf(error) + ')')
    return false
  }
}
