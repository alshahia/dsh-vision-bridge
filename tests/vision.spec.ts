import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { assertVisionRoute, inspectVisionRoute, runVisionCall } from '../src/vision.ts'
import type { PreparedImage } from '../src/types.ts'

const IMAGE: PreparedImage = {
  path: 'D:/proj/.dsh/vision/capture/shot.png',
  name: 'shot.png',
  mediaType: 'image/png',
  data: new Uint8Array([1, 2, 3]),
  sha256: 'a'.repeat(64),
  bytes: 3,
}

function streamOf(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const TEXT_REPLY: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'A dark sidebar ' },
  { type: 'text-delta', index: 0, text: 'with a teal accent.' },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 12 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface Harness {
  ctx: Context
  calls: GenerateOptions[]
  saved: Array<{ mediaType: string, name?: string, bytes: number }>
}

function harness(options: {
  modalities?: readonly string[]
  chunks?: readonly StreamChunk[]
  withLlm?: boolean
  withAttachments?: boolean
} = {}): Harness {
  const calls: GenerateOptions[] = []
  const saved: Array<{ mediaType: string, name?: string, bytes: number }> = []
  const services: Record<string, unknown> = {}
  if (options.withLlm !== false) {
    services.llm = {
      async resolveModelInfo() {
        return { inputModalities: options.modalities ?? ['text', 'image'], contextWindow: 128_000 }
      },
      stream(generateOptions: GenerateOptions) {
        calls.push(generateOptions)
        return streamOf(options.chunks ?? TEXT_REPLY)
      },
    }
  }
  if (options.withAttachments !== false) {
    services.attachments = {
      async saveImage(input: { data: Uint8Array, mediaType: string, name?: string }) {
        saved.push({
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          ...input.name === undefined ? {} : { name: input.name },
        })
        return {
          attachmentId: 'att-' + String(saved.length),
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 800,
          height: 600,
          ...input.name === undefined ? {} : { name: input.name },
        }
      },
    }
  }
  return { ctx: services as unknown as Context, calls, saved }
}

const REQUEST = {
  provider: 'vp',
  model: 'vm',
  maxTokens: 512,
  instruction: 'Describe this image.',
  images: [IMAGE],
}

describe('inspectVisionRoute', () => {
  it('reports a route that declares image input', async () => {
    const { ctx } = harness({ modalities: ['text', 'image'] })
    await expect(inspectVisionRoute(ctx, 'vp', 'vm')).resolves.toEqual({
      provider: 'vp', model: 'vm', imageCapable: true, contextWindow: 128_000,
    })
  })

  it('reports a text-only route as not image-capable', async () => {
    const { ctx } = harness({ modalities: ['text'] })
    await expect(inspectVisionRoute(ctx, 'vp', 'vm')).resolves.toMatchObject({ imageCapable: false })
  })

  it('reports a route with no declared modalities as not image-capable', async () => {
    const services = {
      llm: { async resolveModelInfo() { return {} } },
    } as unknown as Context
    await expect(inspectVisionRoute(services, 'vp', 'vm')).resolves.toMatchObject({ imageCapable: false })
  })

  it('names the missing service when there is no llm runtime', async () => {
    const { ctx } = harness({ withLlm: false })
    await expect(inspectVisionRoute(ctx, 'vp', 'vm')).rejects.toThrow(/needs the "llm" service/)
  })
})

describe('assertVisionRoute', () => {
  it('passes for an image-capable route', async () => {
    const { ctx } = harness({ modalities: ['text', 'image'] })
    await expect(assertVisionRoute(ctx, 'vp', 'vm')).resolves.toMatchObject({ imageCapable: true })
  })

  it('refuses a text-only route and names it and the fix', async () => {
    const { ctx } = harness({ modalities: ['text'] })
    await expect(assertVisionRoute(ctx, 'vp', 'vm')).rejects.toThrow(
      /the configured vision route "vp\/vm" does not declare image input/,
    )
  })
})

describe('runVisionCall', () => {
  it('assembles the description from the stream and reports usage', async () => {
    const { ctx } = harness()
    const result = await runVisionCall(ctx, REQUEST)
    expect(result.text).toBe('A dark sidebar with a teal accent.')
    expect(result.usage).toEqual({ inputTokens: 1200, outputTokens: 12 })
    expect(result.provider).toBe('vp')
    expect(result.model).toBe('vm')
  })

  it('saves every image to the attachment store with its media type and name', async () => {
    const { ctx, saved } = harness()
    await runVisionCall(ctx, REQUEST)
    expect(saved).toEqual([{ mediaType: 'image/png', name: 'shot.png', bytes: 3 }])
  })

  it('sends one text block followed by one image block per image', async () => {
    const { ctx, calls } = harness()
    await runVisionCall(ctx, { ...REQUEST, images: [IMAGE, { ...IMAGE, name: 'second.png' }] })
    const message = calls[0]!.messages[0] as unknown as { content: Array<Record<string, unknown>> }
    expect(message.content).toHaveLength(3)
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'Describe this image.' })
    expect(message.content[1]!.type).toBe('image')
    expect(message.content[2]!.type).toBe('image')
  })

  it('omits purpose and sessionId from the nested call', async () => {
    const { ctx, calls } = harness()
    await runVisionCall(ctx, REQUEST)
    expect(calls[0]).not.toHaveProperty('purpose')
    expect(calls[0]).not.toHaveProperty('sessionId')
    expect(calls[0]).toMatchObject({ provider: 'vp', model: 'vm', maxTokens: 512 })
  })

  it('refuses before streaming when the route cannot read images', async () => {
    const { ctx, calls, saved } = harness({ modalities: ['text'] })
    await expect(runVisionCall(ctx, REQUEST)).rejects.toThrow(/does not declare image input/)
    expect(calls).toEqual([])
    expect(saved).toEqual([])
  })

  it('refuses when there are no images to describe', async () => {
    const { ctx, calls } = harness()
    await expect(runVisionCall(ctx, { ...REQUEST, images: [] }))
      .rejects.toThrow(/needs at least one image/)
    expect(calls).toEqual([])
  })

  it('names the missing service when there is no attachment store', async () => {
    const { ctx } = harness({ withAttachments: false })
    await expect(runVisionCall(ctx, REQUEST)).rejects.toThrow(/needs the "attachments" service/)
  })

  it('surfaces a provider failure as an LlmError carrying the provider code', async () => {
    const { ctx } = harness({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream boom', code: 'PROVIDER_ERROR' } } },
      ],
    })
    const error = await runVisionCall(ctx, REQUEST).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('PROVIDER_ERROR')
    expect((error as LlmError).message).toBe('upstream boom')
  })

  it('surfaces an abort as an LlmError too', async () => {
    const { ctx } = harness({
      chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled', code: 'ABORTED' } } }],
    })
    const error = await runVisionCall(ctx, REQUEST).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe('ABORTED')
  })

  it('reports max-tokens as an actionable MAX_TOKENS failure, not a truncated description', async () => {
    const { ctx } = harness({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'A dark side' },
        { type: 'finish', reason: { kind: 'max-tokens' } },
      ],
    })
    const error = await runVisionCall(ctx, REQUEST).catch((thrown: unknown) => thrown) as Error & { code?: string }
    expect(error.code).toBe('MAX_TOKENS')
    expect(error.message).toContain('raise route.maxTokens')
  })

  it('refuses an empty description instead of returning an empty envelope', async () => {
    const { ctx } = harness({ chunks: [{ type: 'finish', reason: { kind: 'stop' } }] })
    await expect(runVisionCall(ctx, REQUEST)).rejects.toThrow(/returned no text/)
  })

  it('ignores reasoning blocks and returns only the visible text', async () => {
    const { ctx } = harness({
      chunks: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'thinking hard' },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'The answer.' },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    })
    await expect(runVisionCall(ctx, REQUEST)).resolves.toMatchObject({ text: 'The answer.' })
  })
})
