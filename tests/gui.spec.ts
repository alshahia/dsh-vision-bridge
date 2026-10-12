/**
 * The host HTTP routes behind the inbox panel.
 *
 * The route handlers are driven with a structural request/response pair, and the
 * three filesystem-touching dependencies are wired to the real `inbox.ts` and
 * `uploads.ts` implementations against the fake filesystem. So these are
 * integration tests of the frozen contract, not assertions that a mock was
 * called: an upload really does traverse base64 decoding, byte validation,
 * collision checks, the store, and a guarded index write.
 *
 * @module dsh-vision-bridge/tests/gui.spec
 */
import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { listInboxImages, resolveInbox, sha256Hex } from '../src/inbox.ts'
import type { InboxLayout } from '../src/inbox.ts'
import {
  INBOX_ROUTE, MAX_UPLOAD_BODY_BYTES, REMOVE_ROUTE, UPLOAD_ROUTE, createVisionRoutes,
  installVisionGui,
} from '../src/gui.ts'
import type { GuiRoute, VisionGuiDeps, WebServerLike } from '../src/gui.ts'
import { appendUpload, readUploadIndex, UPLOADS_FILE } from '../src/uploads.ts'
import type { AttachmentStoreLike, InboxUpload } from '../src/uploads.ts'
import type { ResolvedVisionConfig } from '../src/types.ts'
import { createFakeFs, jpegBytes, pngBytes } from './helpers/fake-fs.ts'
import type { FakeFs } from './helpers/fake-fs.ts'

const PROJECT = 'D:/proj'
const FALLBACK = 'D:/fallback'
const ROOT_REL = '.dsh/vision'
const ROOT = 'D:/proj/.dsh/vision'
const INDEX_PATH = ROOT + '/' + UPLOADS_FILE

const ALL_FORMATS: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const SEED: Record<string, Uint8Array> = {
  [ROOT + '/reference/mock.png']: pngBytes(64),
  [ROOT + '/capture/shot.jpg']: jpegBytes(32),
}

const CONFIG: ResolvedVisionConfig = {
  enabled: true,
  inbox: { root: ROOT_REL, gitIgnore: true, maxBytes: 4096, formats: ALL_FORMATS },
  route: { provider: 'vp', model: 'vm', maxTokens: 512 },
  tasks: [{ id: 'describe', title: 'Describe', prompt: 'Describe it.', version: 1 }],
  cache: { enabled: true, maxEntries: 16 },
}

/* ---------------------------------------------------------------- transport */

interface Captured {
  headers: Record<string, string>
  body: string
  ended: boolean
}

interface FakeRes {
  res: ServerResponse
  status: () => number
  captured: Captured
}

/** A response that records what the handler wrote. */
function fakeRes(): FakeRes {
  const captured: Captured = { headers: {}, body: '', ended: false }
  const raw = {
    statusCode: 200,
    writableEnded: false,
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = String(value)
    },
    end(chunk?: string) {
      captured.body += chunk ?? ''
      captured.ended = true
      raw.writableEnded = true
    },
    on() {
      return raw
    },
  }
  return { res: raw as unknown as ServerResponse, status: () => raw.statusCode, captured }
}

/** A request that streams the given body. */
function fakeReq(options: {
  method: string
  url?: string
  headers?: Record<string, string>
  body?: string
}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [new TextEncoder().encode(options.body)]
  const raw = {
    method: options.method,
    url: options.url ?? '/',
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    on() {
      return raw
    },
  }
  return raw as unknown as IncomingMessage
}

/** Call one route and decode its JSON reply. */
async function call(route: GuiRoute, request: IncomingMessage): Promise<{
  status: number
  json: Record<string, unknown>
  headers: Record<string, string>
}> {
  const { res, status, captured } = fakeRes()
  await route.handler(request, res)
  return {
    status: status(),
    json: captured.body === '' ? {} : JSON.parse(captured.body) as Record<string, unknown>,
    headers: captured.headers,
  }
}

/* ------------------------------------------------------------------ harness */

interface LocalStore {
  store: AttachmentStoreLike
  saved: Map<string, Uint8Array>
  savedInputs: Array<{ bytes: number, mediaType: string, name?: string }>
  hostPath: 'derived' | 'missing'
}

function makeStore(hostPath: 'derived' | 'missing' = 'derived'): LocalStore {
  const saved = new Map<string, Uint8Array>()
  const savedInputs: LocalStore['savedInputs'] = []
  const state: LocalStore = { saved, savedInputs, hostPath, store: undefined as unknown as AttachmentStoreLike }
  state.store = {
    imageLimits: { mediaTypes: ALL_FORMATS, maxMessageImageBytes: 4096 },
    async saveImage(input) {
      savedInputs.push({
        bytes: input.data.byteLength,
        mediaType: input.mediaType,
        ...(input.name === undefined ? {} : { name: input.name }),
      })
      const id = 'att-' + String(saved.size + 1)
      saved.set(id, input.data.slice())
      return {
        attachmentId: id,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 800,
        height: 600,
        ...(input.name === undefined ? {} : { name: input.name }),
      } as unknown as ImageAttachmentRef
    },
    async readImage(ref) {
      const data = saved.get(ref.attachmentId)
      if (data === undefined) throw new Error('no such attachment')
      return { ref, data: data.slice() }
    },
    imageHostPath(ref) {
      return hostPath === 'missing' ? undefined : 'D:/store/' + ref.attachmentId + '.png'
    },
  }
  return state
}

interface Harness {
  deps: VisionGuiDeps
  routes: GuiRoute[]
  fake: FakeFs
  layout: InboxLayout
  config: ResolvedVisionConfig
  store: LocalStore | undefined
  /** Every session id the routes resolved a project directory for. */
  sessions: Array<string | undefined>
}

async function harness(options: {
  files?: Record<string, Uint8Array>
  withStore?: boolean
  hostPath?: 'derived' | 'missing'
  route?: { provider: string, model: string }
  probe?: 'ready' | 'not-ready' | 'throw'
  scopeThrows?: boolean
  appendThrows?: string
} = {}): Promise<Harness> {
  const fake = createFakeFs({ files: options.files ?? SEED })
  const layout = await resolveInbox(fake.ctx, PROJECT, ROOT_REL)
  const config: ResolvedVisionConfig = {
    ...CONFIG,
    route: { ...CONFIG.route, ...options.route ?? {} },
  }
  const store = options.withStore === false ? undefined : makeStore(options.hostPath ?? 'derived')
  const sessions: Harness['sessions'] = []

  const deps: VisionGuiDeps = {
    projectDirFor(sessionId) {
      sessions.push(sessionId)
      return sessionId === undefined ? PROJECT : FALLBACK
    },
    async scopeFor(projectDir) {
      if (options.scopeThrows === true) throw new Error('the inbox root is outside the project')
      // Resolved per call, exactly as the plugin does, so a test can prove that
      // the session id reached the project lookup and shaped the payload.
      return { config, layout: await resolveInbox(fake.ctx, projectDir, ROOT_REL) }
    },
    listFolder: (target, formats, signal) => listInboxImages(fake.ctx, target, formats, signal),
    readIndex: (target, signal) => readUploadIndex(fake.ctx, target, signal),
    async appendIndex(target, upload: InboxUpload, signal) {
      if (options.appendThrows !== undefined) throw new Error(options.appendThrows)
      await appendUpload(fake.ctx, target, upload, signal)
    },
    childSummary: () => 'vision_agent -> vp/vm',
    async probeRoute(provider, model) {
      if (options.probe === 'throw') throw new Error('the provider is not configured')
      return options.probe === 'not-ready'
        ? { imageCapable: false, detail: 'does not declare image input' }
        : { imageCapable: true, detail: provider + '/' + model + ' declares image input' }
    },
    attachments: () => store?.store,
  }
  return { deps, routes: createVisionRoutes(deps), fake, layout, config, store, sessions }
}

/** The route with the given path. */
function routeFor(routes: GuiRoute[], path: string): GuiRoute {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error('no route ' + path)
  return route
}

/**
 * A JSON upload body.
 *
 * A key that is present is emitted even when its value is `undefined`, so that
 * `{ zone: undefined }` really does omit the field — the "missing zone" case is
 * distinct from the default.
 */
function uploadBody(options: {
  zone?: unknown
  name?: unknown
  data?: unknown
  session?: unknown
}): string {
  const body: Record<string, unknown> = {
    zone: 'zone' in options ? options.zone : 'reference',
    name: 'name' in options ? options.name : 'new.png',
    data: 'data' in options ? options.data : Buffer.from(pngBytes(64)).toString('base64'),
  }
  if ('session' in options) body.session = options.session
  return JSON.stringify(body)
}

const SAME_ORIGIN = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }

/* ------------------------------------------------------------------- routes */

describe('createVisionRoutes', () => {
  it('registers exactly the three frozen routes', async () => {
    const { routes } = await harness()
    expect(routes.map(route => [route.kind, route.path])).toEqual([
      ['exact', INBOX_ROUTE],
      ['exact', UPLOAD_ROUTE],
      ['exact', REMOVE_ROUTE],
    ])
    expect(INBOX_ROUTE).toBe('/dsh-vision-bridge/inbox')
    expect(UPLOAD_ROUTE).toBe('/dsh-vision-bridge/upload')
    expect(REMOVE_ROUTE).toBe('/dsh-vision-bridge/remove')
  })
})

describe('GET /dsh-vision-bridge/inbox', () => {
  it('reports the inbox, the route, the tasks and both image sources', async () => {
    const { routes, fake, layout } = await harness()
    // One image was uploaded earlier and recorded in the index.
    await appendUpload(fake.ctx, await resolveInbox(fake.ctx, PROJECT, ROOT_REL), {
      zone: 'capture',
      name: 'uploaded.png',
      ref: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 40, width: 100, height: 50 } as
        unknown as ImageAttachmentRef,
      uploadedAt: '2026-10-12T12:00:00.000Z',
    })

    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET', url: INBOX_ROUTE }))

    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toContain('application/json')
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.json).toMatchObject({
      ok: true,
      enabled: true,
      projectDir: PROJECT,
      inbox: layout.root,
      route: 'vp/vm',
      routeReady: true,
      agents: 'vision_agent -> vp/vm',
      tasks: ['describe'],
      uploadsSupported: true,
      canDelete: false,
      zones: {
        reference: layout.referenceTarget.displayPath,
        capture: layout.captureTarget.displayPath,
      },
    })
    expect(result.json.deleteHint).toContain('cannot delete files')

    const images = result.json.images as Array<Record<string, unknown>>
    expect(images.map(image => [image.zone, image.name, image.source])).toEqual([
      ['reference', 'mock.png', 'folder'],
      ['capture', 'shot.jpg', 'folder'],
      ['capture', 'uploaded.png', 'upload'],
    ])
    expect(images[0]!.path).toBe(ROOT + '/reference/mock.png')
    expect(images[0]!.bytes).toBe(64)
    expect(images[2]!.path).toBe('D:/store/att-9.png')
    expect(result.json.problem).toBeUndefined()
  })

  it('passes the session id through to the project lookup', async () => {
    const { routes, sessions } = await harness()
    const result = await call(
      routeFor(routes, INBOX_ROUTE),
      fakeReq({ method: 'GET', url: INBOX_ROUTE + '?session=abc-123' }),
    )
    expect(sessions).toEqual(['abc-123'])
    expect(result.json.projectDir).toBe(FALLBACK)
  })

  it('resolves the fallback project when no session is given', async () => {
    const { routes, sessions } = await harness()
    await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET', url: INBOX_ROUTE }))
    expect(sessions).toEqual([undefined])
  })

  it('reports uploads as unsupported when no attachment store is mounted', async () => {
    const { routes } = await harness({ withStore: false })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.status).toBe(200)
    expect(result.json.uploadsSupported).toBe(false)
    const images = result.json.images as Array<Record<string, unknown>>
    expect(images.every(image => image.source === 'folder')).toBe(true)
  })

  it('says so plainly when no route is configured', async () => {
    const { routes } = await harness({ route: { provider: '', model: '' } })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.json).toMatchObject({ route: '', routeReady: false, routeDetail: 'no route configured' })
  })

  it('reports a route that cannot describe images', async () => {
    const { routes } = await harness({ probe: 'not-ready' })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.json).toMatchObject({ routeReady: false, routeDetail: 'does not declare image input' })
  })

  it('survives a route probe that throws, and keeps the reason', async () => {
    const { routes } = await harness({ probe: 'throw' })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.status).toBe(200)
    expect(result.json.routeReady).toBe(false)
    expect(String(result.json.routeDetail)).toContain('the provider is not configured')
  })

  it('surfaces an unreadable index as a problem instead of failing', async () => {
    const { routes } = await harness({
      files: { ...SEED, [INDEX_PATH]: new TextEncoder().encode('{ broken') },
    })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.status).toBe(200)
    expect(String(result.json.problem)).toContain('not valid JSON')
    expect(result.json.images).toHaveLength(2)
  })

  it('reports a failure to resolve the inbox as a 500 that still names the project', async () => {
    const { routes } = await harness({ scopeThrows: true })
    const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.status).toBe(500)
    expect(String(result.json.error)).toContain('the inbox root is outside the project')
    expect(result.json.projectDir).toBe(PROJECT)
  })

  it('accepts HEAD and refuses every other method with 405 and an Allow header', async () => {
    const { routes } = await harness()
    const head = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method: 'HEAD' }))
    expect(head.status).toBe(200)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const result = await call(routeFor(routes, INBOX_ROUTE), fakeReq({ method }))
      expect(result.status, method).toBe(405)
      expect(result.headers.allow, method).toBe('GET')
    }
  })
})

describe('POST /dsh-vision-bridge/upload', () => {
  it('commits the image and records it in the index', async () => {
    const { routes, fake, store } = await harness()
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ zone: 'capture', name: 'new.png' }),
    }))

    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({
      ok: true,
      zone: 'capture',
      name: 'new.png',
      path: 'D:/store/att-1.png',
      bytes: 64,
      mediaType: 'image/png',
    })
    expect(result.json.sha256).toBe(sha256Hex(pngBytes(64)))
    expect(store!.savedInputs).toEqual([{ bytes: 64, mediaType: 'image/png', name: 'new.png' }])

    const stored = JSON.parse(new TextDecoder().decode(fake.files.get(INDEX_PATH)!))
    expect(stored.uploads).toHaveLength(1)
    expect(stored.uploads[0]).toMatchObject({ zone: 'capture', name: 'new.png' })
    expect(stored.uploads[0].ref.attachmentId).toBe('att-1')
  })

  it('appends beside an index that already has entries', async () => {
    const { routes, fake } = await harness()
    await appendUpload(fake.ctx, await resolveInbox(fake.ctx, PROJECT, ROOT_REL), {
      zone: 'reference',
      name: 'earlier.png',
      ref: { attachmentId: 'att-old', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } as
        unknown as ImageAttachmentRef,
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ name: 'second.png' }),
    }))
    expect(result.status).toBe(200)
    const stored = JSON.parse(new TextDecoder().decode(fake.files.get(INDEX_PATH)!))
    expect(stored.uploads.map((entry: { name: string }) => entry.name)).toEqual(['earlier.png', 'second.png'])
  })

  it('takes the session from the body so the upload lands in that project', async () => {
    const { routes, sessions } = await harness()
    await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ session: 'sess-9' }),
    }))
    expect(sessions).toEqual(['sess-9'])
  })

  it('refuses a body that is not JSON, not an object, or empty', async () => {
    const { routes } = await harness()
    const cases: Array<[string, string]> = [
      ['{ not json', 'not valid JSON'],
      ['[1,2,3]', 'not a JSON object'],
      ['"a string"', 'not a JSON object'],
      ['', 'empty'],
      ['   ', 'empty'],
    ]
    for (const [body, expected] of cases) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
        method: 'POST', headers: SAME_ORIGIN, body,
      }))
      expect(result.status, body).toBe(400)
      expect(String(result.json.error), body).toContain(expected)
    }
  })

  it('refuses a body larger than the transport cap', async () => {
    const { routes } = await harness()
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: '{"data":"' + 'A'.repeat(MAX_UPLOAD_BODY_BYTES) + '"}',
    }))
    expect(result.status).toBe(413)
    expect(String(result.json.error)).toContain('exceeds')
  })

  it('refuses an unknown or missing zone', async () => {
    const { routes } = await harness()
    for (const zone of [undefined, 'elsewhere', '', 7]) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
        method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ zone }),
      }))
      expect(result.status, String(zone)).toBe(400)
      expect(String(result.json.error), String(zone)).toContain('zone must be')
    }
  })

  it('refuses a name or data field of the wrong type', async () => {
    const { routes } = await harness()
    const badName = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ name: 42 }),
    }))
    expect(badName.status).toBe(400)
    expect(String(badName.json.error)).toContain('name must be')

    const badData = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ data: null }),
    }))
    expect(badData.status).toBe(400)
    expect(String(badData.json.error)).toContain('data must be')
  })

  it('refuses a name the inbox will not accept', async () => {
    const { routes } = await harness()
    for (const name of ['', 'notes.txt', 'a/b.png', '.hidden.png', 'a'.repeat(200) + '.png']) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
        method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ name }),
      }))
      expect(result.status, name).toBe(400)
    }
  })

  it('refuses data that is not canonical base64', async () => {
    const { routes } = await harness()
    for (const data of ['', 'AB==', 'data:image/png;base64,AAAA', '!!!!', 'AAA']) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
        method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ data }),
      }))
      expect(result.status, data).toBe(400)
      expect(String(result.json.error), data).toContain('base64')
    }
  })

  it('refuses bytes that are not an image, or that contradict the name', async () => {
    const { routes } = await harness()
    const notAnImage = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: uploadBody({ data: Buffer.from(new TextEncoder().encode('%PDF-1.7')).toString('base64') }),
    }))
    expect(notAnImage.status).toBe(400)
    expect(String(notAnImage.json.error)).toContain('not a supported')

    const mismatch = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: uploadBody({ name: 'shot.png', data: Buffer.from(jpegBytes(64)).toString('base64') }),
    }))
    expect(mismatch.status).toBe(400)
    expect(String(mismatch.json.error)).toContain('image/jpeg')
  })

  it('refuses bytes over the configured inbox cap with 413', async () => {
    const { routes } = await harness()
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: uploadBody({ data: Buffer.from(pngBytes(8192)).toString('base64') }),
    }))
    expect(result.status).toBe(413)
    expect(String(result.json.error)).toContain('4096')
  })

  it('refuses a name that already exists in the folder zone', async () => {
    const { routes, store } = await harness()
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ zone: 'reference', name: 'mock.png' }),
    }))
    expect(result.status).toBe(409)
    expect(String(result.json.error)).toContain('already holds an image named "mock.png"')
    // Nothing was committed before the refusal.
    expect(store!.savedInputs).toEqual([])
  })

  it('refuses a name that already exists in the index, in the same zone only', async () => {
    const { routes, fake } = await harness()
    await appendUpload(fake.ctx, await resolveInbox(fake.ctx, PROJECT, ROOT_REL), {
      zone: 'capture',
      name: 'taken.png',
      ref: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 8, width: 1, height: 1 } as
        unknown as ImageAttachmentRef,
      uploadedAt: '2026-10-01T00:00:00.000Z',
    })
    const sameZone = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ zone: 'capture', name: 'taken.png' }),
    }))
    expect(sameZone.status).toBe(409)

    // The same name in the other zone is a different image and is allowed.
    const otherZone = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ zone: 'reference', name: 'taken.png' }),
    }))
    expect(otherZone.status).toBe(200)
  })

  it('refuses a cross-origin write with 403', async () => {
    const { routes, store } = await harness()
    const crossOriginHeaders: Array<Record<string, string>> = [
      { host: '127.0.0.1:3080', origin: 'http://evil.example' },
      { host: '127.0.0.1:3080', origin: 'not a url' },
      { origin: 'http://127.0.0.1:3080' },
    ]
    for (const headers of crossOriginHeaders) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
        method: 'POST', headers, body: uploadBody({}),
      }))
      expect(result.status, JSON.stringify(headers)).toBe(403)
    }
    expect(store!.savedInputs).toEqual([])
  })

  it('allows a request with no Origin, and one whose Origin matches the Host', async () => {
    const { routes } = await harness()
    const noOrigin = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: { host: '127.0.0.1:3080' }, body: uploadBody({ name: 'a.png' }),
    }))
    expect(noOrigin.status).toBe(200)
    const sameOrigin = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({ name: 'b.png' }),
    }))
    expect(sameOrigin.status).toBe(200)
  })

  it('refuses with 503 when no attachment store is mounted', async () => {
    const { routes } = await harness({ withStore: false })
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({}),
    }))
    expect(result.status).toBe(503)
    expect(String(result.json.error)).toContain('no attachment store')
  })

  it('says honestly that an image was committed but is unreachable', async () => {
    const { routes } = await harness({ hostPath: 'missing' })
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({}),
    }))
    expect(result.status).toBe(503)
    expect(String(result.json.error)).toContain('committed to the attachment store')
    expect(String(result.json.error)).toContain('cannot be pointed at it')
  })

  it('reports an index that cannot be updated as 409 with a hint', async () => {
    const { routes, store } = await harness({ appendThrows: 'the index is read-only' })
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({}),
    }))
    expect(result.status).toBe(409)
    expect(String(result.json.error)).toContain('the index is read-only')
    expect(String(result.json.hint)).toContain('not listed in the inbox index')
    expect(store!.savedInputs).toHaveLength(1)
  })

  it('reports a failure to resolve the inbox as 500', async () => {
    const { routes } = await harness({ scopeThrows: true })
    const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({
      method: 'POST', headers: SAME_ORIGIN, body: uploadBody({}),
    }))
    expect(result.status).toBe(500)
  })

  it('refuses any method other than POST', async () => {
    const { routes } = await harness()
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const result = await call(routeFor(routes, UPLOAD_ROUTE), fakeReq({ method }))
      expect(result.status, method).toBe(405)
      expect(result.headers.allow, method).toBe('POST')
    }
  })
})

describe('POST /dsh-vision-bridge/remove', () => {
  it('refuses permanently with 501 and echoes the path', async () => {
    const { routes } = await harness()
    const result = await call(routeFor(routes, REMOVE_ROUTE), fakeReq({
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ path: ROOT + '/reference/mock.png' }),
    }))
    expect(result.status).toBe(501)
    expect(result.json).toMatchObject({ ok: false, error: 'dsh-vision-bridge cannot delete files' })
    expect(result.json.path).toBe(ROOT + '/reference/mock.png')
    expect(String(result.json.hint)).toContain('no delete or unlink primitive')
    expect(String(result.json.hint)).toContain(ROOT + '/reference/mock.png')
  })

  it('still refuses, without a path, when the body is empty or unusable', async () => {
    const { routes } = await harness()
    for (const body of ['', 'not json', '{"path":42}']) {
      const result = await call(routeFor(routes, REMOVE_ROUTE), fakeReq({
        method: 'POST', headers: SAME_ORIGIN, body,
      }))
      expect(result.status, body).toBe(501)
      expect(result.json.path).toBeUndefined()
      expect(String(result.json.hint)).toContain('Remove the file yourself')
    }
  })

  it('refuses a cross-origin request with 403', async () => {
    const { routes } = await harness()
    const result = await call(routeFor(routes, REMOVE_ROUTE), fakeReq({
      method: 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' }, body: '{}',
    }))
    expect(result.status).toBe(403)
  })

  it('refuses any method other than POST', async () => {
    const { routes } = await harness()
    const result = await call(routeFor(routes, REMOVE_ROUTE), fakeReq({ method: 'GET' }))
    expect(result.status).toBe(405)
    expect(result.headers.allow).toBe('POST')
  })
})

describe('installVisionGui', () => {
  interface PluginCtx {
    ctx: Context
    logs: string[]
    registered: string[]
    unregistered: string[]
    runDisposers: () => void
  }

  function pluginCtx(options: {
    /** Whether this composition mounts a web server at all. Defaults to true. */
    withWebServer?: boolean
    effectThrows?: boolean
    registerThrowsFor?: string
  } = {}): PluginCtx {
    const logs: string[] = []
    const registered: string[] = []
    const unregistered: string[] = []
    const disposers: Array<() => void> = []
    const ctx: Record<string, unknown> = {
      logger: {
        info: (message: string) => { logs.push('info: ' + message) },
        warn: (message: string) => { logs.push('warn: ' + message) },
      },
      effect(callback: () => (() => void) | void) {
        if (options.effectThrows === true) throw new Error('effects are not available here')
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    }
    if (options.withWebServer !== false) {
      ctx.webServer = {
        register(route: GuiRoute) {
          if (route.path === options.registerThrowsFor) {
            throw new Error('webserver: duplicate exact route "' + route.path + '"')
          }
          registered.push(route.path)
          return () => { unregistered.push(route.path) }
        },
      } satisfies WebServerLike
    }
    return {
      ctx: ctx as unknown as Context,
      logs,
      registered,
      unregistered,
      runDisposers: () => { for (const dispose of disposers) dispose() },
    }
  }

  it('registers all three routes and returns true', async () => {
    const { deps } = await harness()
    const plugin = pluginCtx()
    expect(installVisionGui(plugin.ctx, deps)).toBe(true)
    expect(plugin.registered).toEqual([INBOX_ROUTE, UPLOAD_ROUTE, REMOVE_ROUTE])
    plugin.runDisposers()
    expect(plugin.unregistered).toEqual([INBOX_ROUTE, UPLOAD_ROUTE, REMOVE_ROUTE])
  })

  it('reports absence of a web server without throwing', async () => {
    const { deps } = await harness()
    const plugin = pluginCtx({ withWebServer: false })
    expect(installVisionGui(plugin.ctx, deps)).toBe(false)
    expect(plugin.logs.join('\n')).toContain('no web server in this composition')
    expect(plugin.logs.join('\n')).toContain('tools are unaffected')
  })

  it('keeps the routes it could register when one is refused as a duplicate', async () => {
    const { deps } = await harness()
    const plugin = pluginCtx({ registerThrowsFor: UPLOAD_ROUTE })
    expect(installVisionGui(plugin.ctx, deps)).toBe(true)
    expect(plugin.registered).toEqual([INBOX_ROUTE, REMOVE_ROUTE])
    expect(plugin.logs.join('\n')).toContain('duplicate exact route')
  })

  it('reports a failure to install at all', async () => {
    const { deps } = await harness()
    const plugin = pluginCtx({ effectThrows: true })
    expect(installVisionGui(plugin.ctx, deps)).toBe(false)
    expect(plugin.logs.join('\n')).toContain('could not install the inbox panel')
  })
})
