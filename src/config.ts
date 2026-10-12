/**
 * Live configuration surface for the vision bridge.
 *
 * Every tunable group is one schemastery `.volatile()` node, so the Settings
 * service can rewrite that group in place while the plugin keeps running — and,
 * on 0.2.x, gets a validated, revision-safe form for it with no hand-written UI
 * (`docs/best-practices/creating-a-client-card-plugin.md` §7). The plugin is NOT
 * re-instantiated on a live edit, so every operation re-reads the groups with
 * `.get()` at its start (`LiveConfigReader`).
 *
 * Schemastery's containment rules this schema obeys:
 * - a volatile node may not sit inside another volatile node, inside an array
 *   item, or inside a union/lazy member, so each group is volatile as a whole
 *   and `tasks` is marked volatile as a whole rather than item by item;
 * - a group's inner fields carry defaults, so a group is always a complete,
 *   concrete object as soon as it resolves.
 *
 * Schemastery has no cross-field validator (there is no `.check()`), so the
 * field rules a fail-fast loader would enforce are applied here as
 * clamp-and-warn-once normalization: reading a live config never throws, which
 * is what makes a half-typed value in the Settings form harmless. A value that
 * cannot be repaired (a route with only one of provider/model) is dropped and
 * reported once.
 *
 * @module dsh-vision-bridge/config
 */
import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { BUILTIN_TASKS } from './prompts.ts'
import type { ResolvedVisionConfig, VisionTaskPreset } from './types.ts'

/** Default inbox folder, relative to the owning project directory. */
export const DEFAULT_INBOX_ROOT = '.dsh/vision'
/** Default pre-read byte cap (8 MiB); the attachment service's own limit also applies. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
/** Default description cap; a description is a few hundred tokens. */
export const DEFAULT_MAX_TOKENS = 2048
/** Default number of cached descriptions kept. */
export const DEFAULT_MAX_ENTRIES = 200

/** Media types the version-one attachment path accepts. */
export const KNOWN_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
]

/** Reported once per distinct problem; cleared whenever the live values change. */
export type ConfigWarn = (message: string) => void

/** A live group as the runtime hands it to the plugin: a stable `.get()` reference. */
export type LiveGroup<T> = Volatile<T> | T

/**
 * The row config the plugin receives, with every group wrapped for live edit.
 *
 * Every group is optional because `LiveConfigReader` must tolerate a partial or
 * absent object — a settings document that omits a section, and a direct caller
 * in a test. After resolution the loader always supplies all five, so the
 * plugin's `apply` always sees a complete set.
 */
export interface VisionVolatileConfig {
  readonly enabled?: LiveGroup<boolean>
  readonly inbox?: LiveGroup<{
    root?: string
    gitIgnore?: boolean
    maxBytes?: number
    formats?: readonly string[]
  }>
  readonly route?: LiveGroup<{
    provider?: string
    model?: string
    maxTokens?: number
  }>
  readonly tasks?: LiveGroup<readonly {
    id?: string
    title?: string
    prompt?: string
    version?: number
  }[]>
  readonly cache?: LiveGroup<{
    enabled?: boolean
    maxEntries?: number
  }>
}

/**
 * The plugin's `Config`. Groups are volatile (live-editable); `tasks` is
 * volatile as a whole because a volatile node may not live inside an array item.
 */
export const visionBridgeConfig = z.object({
  enabled: z.boolean().default(true).volatile(),
  inbox: z.object({
    root: z.string().default(DEFAULT_INBOX_ROOT),
    gitIgnore: z.boolean().default(true),
    maxBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BYTES),
    formats: z.array(z.string()).default([...KNOWN_MEDIA_TYPES]),
  }).default({}).volatile(),
  route: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    maxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  }).default({}).volatile(),
  tasks: z.array(z.object({
    id: z.string().default(''),
    title: z.string().default(''),
    prompt: z.string().default(''),
    version: z.number().step(1).min(1).default(1),
  })).default([]).volatile(),
  cache: z.object({
    enabled: z.boolean().default(true),
    maxEntries: z.number().step(1).min(0).default(DEFAULT_MAX_ENTRIES),
  }).default({}).volatile(),
})

/** Whether a value is one of schemastery's live references. */
function isLiveGroup<T>(value: unknown): value is Volatile<T> {
  return typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function'
}

/** Read one group, accepting both a live reference and a plain value (tests). */
function readGroup<T>(value: LiveGroup<T> | undefined): T | undefined {
  if (value === undefined || value === null) return undefined
  if (isLiveGroup<T>(value)) return value.get() as T
  return value
}

/** A trimmed non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A finite positive number, or undefined. */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** A non-negative integer, or undefined; 0 stays meaningful. */
function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Normalize the accepted-format list.
 *
 * An unknown entry is reported and dropped rather than failing the read: the
 * Settings form lets a user type a value that is not a media type, and that must
 * never take the plugin down. An empty result falls back to every known format,
 * because "accept nothing" is not a state the plugin can act on.
 * @param raw - the configured list.
 * @param warn - sink for the drop notices.
 * @returns at least one accepted media type.
 */
function normalizeFormats(raw: unknown, warn: ConfigWarn): ImageMediaType[] {
  const accepted: ImageMediaType[] = []
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      const value = entry.trim()
      if (!KNOWN_MEDIA_TYPES.includes(value as ImageMediaType)) {
        warn('inbox.formats: "' + value + '" is not a supported image format; ignoring it')
        continue
      }
      const mediaType = value as ImageMediaType
      if (!accepted.includes(mediaType)) accepted.push(mediaType)
    }
  }
  return accepted.length === 0 ? [...KNOWN_MEDIA_TYPES] : accepted
}

/**
 * Normalize the task list, falling back to the built-in presets when empty.
 *
 * An empty list means "use the built-ins" rather than "offer no tasks": a
 * plugin whose every task was deleted could not describe anything, and the
 * built-ins are the documented default.
 * @param raw - the configured list.
 * @param warn - sink for the drop notices.
 * @returns at least one preset, with unique ids.
 */
function normalizeTasks(raw: unknown, warn: ConfigWarn): VisionTaskPreset[] {
  const builtins = (): VisionTaskPreset[] => BUILTIN_TASKS.map(task => ({ ...task }))
  if (!Array.isArray(raw) || raw.length === 0) return builtins()
  const tasks: VisionTaskPreset[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = entry as Record<string, unknown>
    const id = text(source.id)
    const prompt = text(source.prompt)
    if (id === undefined || prompt === undefined) {
      warn('tasks: a task needs both an id and a prompt; dropping the incomplete task')
      continue
    }
    if (seen.has(id)) {
      warn('tasks: duplicate task id "' + id + '"; keeping the first')
      continue
    }
    seen.add(id)
    const version = positiveNumber(source.version)
    tasks.push({
      id,
      title: text(source.title) ?? id,
      prompt,
      version: version === undefined ? 1 : Math.floor(version),
    })
  }
  return tasks.length === 0 ? builtins() : tasks
}

/** Discards notices during the silent probe pass. */
const NOOP: ConfigWarn = () => {}

/**
 * Reads the live configuration and normalizes it into the resolved form. One
 * instance per plugin, so the warn-once memory belongs to the plugin instance
 * and is reset whenever the live values change.
 */
export class LiveConfigReader {
  private signature = ''
  private readonly warned = new Set<string>()

  /** @param warn - Sink for clamp/drop notices; normally the plugin logger. */
  constructor(private readonly warn: ConfigWarn) {}

  /**
   * Resolve the current configuration, reporting each distinct problem once per
   * value generation.
   *
   * The first pass decides silently whether the values changed; only the second
   * pass may warn. Deciding in the same pass would let the change detection
   * clear the notice memory it had just filled, reporting every notice twice.
   * @param raw - The volatile row config (or a plain object in tests).
   * @returns The resolved configuration, never a throw.
   */
  read(raw: VisionVolatileConfig | undefined): ResolvedVisionConfig {
    const probe = this.resolve(raw, NOOP)
    const signature = JSON.stringify(probe)
    if (signature !== this.signature) {
      this.signature = signature
      this.warned.clear()
    }
    return this.resolve(raw, this.notice)
  }

  /** Normalize one live value into the resolved form, warning through `warn`. */
  private resolve(raw: VisionVolatileConfig | undefined, warn: ConfigWarn): ResolvedVisionConfig {
    const source = (raw ?? {}) as VisionVolatileConfig
    const inboxRaw = readGroup(source.inbox) ?? {}
    const routeRaw = readGroup(source.route) ?? {}
    const cacheRaw = readGroup(source.cache) ?? {}

    // The route pair rule: a provider without a model names no route, and
    // silently keeping half of it would produce a confusing adapter failure
    // later. Dropping both and warning once is the recoverable form.
    let provider = text(routeRaw.provider)
    let model = text(routeRaw.model)
    if ((provider === undefined) !== (model === undefined)) {
      warn('route: provider and model must be set together; the vision route is unset')
      provider = undefined
      model = undefined
    }

    return {
      enabled: readGroup(source.enabled) !== false,
      inbox: {
        root: text(inboxRaw.root) ?? DEFAULT_INBOX_ROOT,
        gitIgnore: inboxRaw.gitIgnore !== false,
        maxBytes: Math.floor(positiveNumber(inboxRaw.maxBytes) ?? DEFAULT_MAX_BYTES),
        formats: normalizeFormats(inboxRaw.formats, warn),
      },
      route: {
        provider: provider ?? '',
        model: model ?? '',
        maxTokens: Math.floor(positiveNumber(routeRaw.maxTokens) ?? DEFAULT_MAX_TOKENS),
      },
      tasks: normalizeTasks(readGroup(source.tasks), warn),
      cache: {
        enabled: cacheRaw.enabled !== false,
        maxEntries: nonNegativeInteger(cacheRaw.maxEntries) ?? DEFAULT_MAX_ENTRIES,
      },
    }
  }

  /** Report one distinct problem per live value generation. */
  private readonly notice: ConfigWarn = (message) => {
    const line = 'vision-bridge config: ' + message
    if (this.warned.has(line)) return
    this.warned.add(line)
    this.warn(line)
  }
}
