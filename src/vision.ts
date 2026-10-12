/**
 * The vision call: the one place an image becomes model input.
 *
 * This is the deliberate inverse of the host's route gate. The host refuses to
 * put an image in front of a text-only conversation route
 * (`packages/api/session-controller/src/commands.ts:336-348`), and that refusal
 * is correct — it protects the user's own session. The bridge does not weaken
 * it; it routes the pixels somewhere else: a one-shot nested call on a route the
 * user configured *because* it declares image input. The gate is mirrored, not
 * bypassed — see {@link assertVisionRoute}, which fails the call when the
 * configured route does not actually accept images.
 *
 * `purpose` and `sessionId` are omitted on purpose. `purpose` is a closed union
 * (`'compaction' | 'session-title'`, `packages/llm/llm/src/types.ts:552`), so a
 * description call has no valid value and must not claim one; `sessionId` would
 * attach a throwaway call to the session's replay cursors for no benefit.
 *
 * @module dsh-vision-bridge/vision
 */
import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, ModelModality, StreamChunk, TextBlock, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { requireService } from './service.ts'
import type { PreparedImage } from './types.ts'

/** The two attachment-service members the bridge uses. */
interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
}

/** The two LLM-service members the bridge uses. */
interface LlmRuntimeLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    inputModalities?: readonly ModelModality[]
    contextWindow?: number
  }>
}

/** What a configured route actually supports, as the registry reports it. */
export interface VisionRouteFacts {
  provider: string
  model: string
  /** Whether the route declares image input; the whole bridge depends on this. */
  imageCapable: boolean
  contextWindow?: number
}

/**
 * Ask the model registry what a route supports.
 *
 * `resolveModelInfo` is authoritative — it is the same call the host's own
 * admission gate uses — so the bridge cannot disagree with the harness about
 * whether a model takes images.
 * @param ctx - plugin context.
 * @param provider - provider route name.
 * @param model - exact model id.
 * @param signal - optional cancellation.
 * @returns the route facts.
 */
export async function inspectVisionRoute(
  ctx: Context,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<VisionRouteFacts> {
  const llm = requireService<LlmRuntimeLike>(ctx, 'llm', 'resolve a vision model route')
  const info = await llm.resolveModelInfo(provider, model, signal)
  const modalities = info.inputModalities
  return {
    provider,
    model,
    imageCapable: Array.isArray(modalities) && modalities.includes('image'),
    ...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
  }
}

/**
 * Fail unless the configured route declares image input.
 *
 * This is the bridge's mirror of the host gate. It exists so the bridge can
 * never quietly become a way to send pixels to a model that cannot read them:
 * the failure names the route and the fix, because the realistic cause is a
 * stale route chosen in Settings after a provider changed its catalog.
 * @param ctx - plugin context.
 * @param provider - provider route name.
 * @param model - exact model id.
 * @param signal - optional cancellation.
 * @returns the route facts, once they are known to be image-capable.
 */
export async function assertVisionRoute(
  ctx: Context,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<VisionRouteFacts> {
  const facts = await inspectVisionRoute(ctx, provider, model, signal)
  if (!facts.imageCapable) {
    throw new Error('the configured vision route "' + provider + '/' + model + '" does not declare '
      + 'image input, so it cannot describe an image; choose a vision-capable model in '
      + 'Settings -> Plugins -> dsh-vision-bridge')
  }
  return facts
}

/**
 * Turn a stream finish reason into the error the caller should see.
 *
 * A local reimplementation of the module-private helper in the compaction
 * summarizer (`packages/compaction/compaction-basic/src/summarizer.ts:197-211`);
 * it is not exported, and a cross-package value import is forbidden. The
 * mapping is deliberately identical so both nested-call sites report provider
 * failures the same way.
 * @param finish - the terminal finish reason.
 * @returns the error to throw, or undefined for a normal stop.
 */
function finishError(finish: FinishReason): Error | undefined {
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
  }
  if (finish.kind === 'max-tokens') {
    const error = new Error('the vision model hit the maxTokens limit before finishing its '
      + 'description; raise route.maxTokens in Settings -> Plugins -> dsh-vision-bridge') as
      Error & { code?: string }
    error.code = 'MAX_TOKENS'
    return error
  }
  return undefined
}

/** One description request. */
export interface VisionCallRequest {
  provider: string
  model: string
  maxTokens: number
  /** The task instruction plus any caller question. */
  instruction: string
  /** Images in order; for the `compare` task the first is the reference. */
  images: readonly PreparedImage[]
  signal?: AbortSignal
}

/** One description. */
export interface VisionCallResult {
  text: string
  provider: string
  model: string
  usage?: TokenUsage
}

/**
 * Describe images on a vision route.
 *
 * Images are saved to the attachment store first: the store is content
 * addressed, so the same screenshot described twice costs one copy on disk, and
 * the LLM service requires a mounted `attachments` service to project image
 * blocks at all (`packages/llm/llm-.../src/images.ts:46`).
 * @param ctx - plugin context.
 * @param request - the route, instruction, and images.
 * @returns the model's description.
 */
export async function runVisionCall(ctx: Context, request: VisionCallRequest): Promise<VisionCallResult> {
  if (request.images.length === 0) throw new Error('a vision call needs at least one image')
  const attachments = requireService<AttachmentStoreLike>(ctx, 'attachments',
    'store the image for a vision call')
  const llm = requireService<LlmRuntimeLike>(ctx, 'llm', 'run a vision call')
  await assertVisionRoute(ctx, request.provider, request.model, request.signal)

  const content: ContentBlock[] = [{ type: 'text', text: request.instruction }]
  for (const image of request.images) {
    content.push({
      type: 'image',
      attachment: await attachments.saveImage({
        data: image.data,
        mediaType: image.mediaType,
        name: image.name,
      }),
    })
  }
  const messages = [{ role: 'user' as const, content }]

  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: request.provider,
    model: request.model,
    messages,
    maxTokens: request.maxTokens,
    signal: request.signal,
  })) {
    assembler.push(chunk)
  }

  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure

  const text = assembler.blocks()
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim()
  if (text === '') {
    throw new Error('the vision model returned no text; the image may be unreadable to it, or the '
      + 'task prompt may not ask for a description')
  }
  return {
    text,
    provider: request.provider,
    model: request.model,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}
