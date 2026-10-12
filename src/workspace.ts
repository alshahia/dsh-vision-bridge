/**
 * Resolution of the project directory that owns a session.
 *
 * Requirement: the image inbox belongs to the project that owns the session,
 * not to the harness process, so two projects can never share or collide on an
 * inbox tree. The authority is `agent.session.header.cwd` — the absolute
 * directory the session was created in, immutable detached creation metadata
 * that is not part of the event log and needs no service or I/O to read.
 *
 * Why not the workspace registry: workspace membership is itself derived from
 * the canonical session cwd, so the registry would add a heavy `storageDomain`
 * dependency to reproduce a value already on the session. Why not the
 * `workingDirectory` service: its `get()` falls back to the launch directory
 * when a session has no recorded change, which would silently put every
 * project's inbox in the same place.
 *
 * The carrier is typed `unknown` and read structurally, on purpose: the shape
 * is a version-specific detail of the session object, this module needs no
 * method on it, and a structural read cannot break when the harness moves the
 * field. An unusable value is simply undefined, so a headless session degrades
 * to the launch directory instead of failing.
 *
 * Proven in the autocompact suite (`dsh-autocompact/src/workspace.ts`); copied
 * rather than imported because cross-plugin value imports are forbidden and the
 * module is 60 lines.
 *
 * @module dsh-vision-bridge/workspace
 */
import { isAbsolute } from 'node:path'

/**
 * Pick the first usable absolute directory.
 * @param candidates - Ordered candidates; empty or relative values are skipped.
 * @param fallback - Directory used when no candidate is usable.
 * @returns An absolute directory path.
 */
export function pickProjectDir(candidates: readonly (string | undefined)[], fallback: string): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && isAbsolute(candidate)) return candidate
  }
  return fallback
}

/**
 * The directory the session was created in, when the session carries one.
 * @param agent - Agent whose session is inspected; anything else yields undefined.
 * @returns An absolute directory, or undefined when the session has none.
 */
export function sessionProjectDir(agent: unknown): string | undefined {
  try {
    const header = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)
      ?.session?.header
    const cwd = header?.cwd
    return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd) ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the project directory for one session.
 * @param agent - Agent whose session is inspected.
 * @param fallback - Directory used when the session records none (the harness
 *   launch directory, which is also what a session without a recorded cwd used).
 * @returns An absolute project directory.
 */
export function projectDirOf(agent: unknown, fallback: string): string {
  return pickProjectDir([sessionProjectDir(agent)], fallback)
}
