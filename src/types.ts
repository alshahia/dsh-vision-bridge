/**
 * Shared vocabulary for the vision bridge.
 *
 * Kept separate from the schemas so the config layer, the inbox layer, and the
 * model-call layer can agree on one shape without importing each other.
 *
 * @module dsh-vision-bridge/types
 */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

/** Which inbox zone an image belongs to; the two zones carry different trust. */
export type InboxZone = 'reference' | 'capture'

/** How a cached description may be reused. */
export type ReuseMode = 'auto' | 'never' | 'only'

/**
 * One description task preset.
 *
 * `version` is part of the cache key on purpose: editing a prompt must
 * invalidate every description written with the old one, or the cache silently
 * serves output from a prompt the user has already replaced.
 */
export interface VisionTaskPreset {
  /** Stable identifier; unique across the resolved task list. */
  id: string
  /** Human-facing name for logs and the GUI. */
  title: string
  /** The instruction sent beside the image. */
  prompt: string
  /** Prompt revision; bump on any wording change. */
  version: number
}

/** Resolved inbox settings. */
export interface ResolvedInboxConfig {
  /** Folder, relative to the owning project directory. */
  root: string
  /** Whether the plugin keeps the inbox ignored by git. */
  gitIgnore: boolean
  /** Pre-read byte cap; the attachment service's own limit is applied too. */
  maxBytes: number
  /** Media types accepted for upload and listing. */
  formats: readonly ImageMediaType[]
}

/** Resolved vision route. Empty provider+model means "not configured yet". */
export interface ResolvedRouteConfig {
  provider: string
  model: string
  maxTokens: number
}

/** Resolved description cache settings. */
export interface ResolvedCacheConfig {
  enabled: boolean
  maxEntries: number
}

/** The whole resolved configuration, read fresh at the start of every operation. */
export interface ResolvedVisionConfig {
  enabled: boolean
  inbox: ResolvedInboxConfig
  route: ResolvedRouteConfig
  tasks: VisionTaskPreset[]
  cache: ResolvedCacheConfig
}

/** One image read from the inbox and prepared for a model call. */
export interface PreparedImage {
  /** Process path of the file, as the caller should cite it. */
  path: string
  /** Leaf name, used as the attachment display name. */
  name: string
  mediaType: ImageMediaType
  data: Uint8Array
  /** Lowercase hex sha256 of exactly these bytes. */
  sha256: string
  bytes: number
}
