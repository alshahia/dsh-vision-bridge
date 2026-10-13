/**
 * Structural access to the host services the bridge depends on.
 *
 * Services are read by name through a structural type rather than a declared
 * module augmentation, for two reasons: the plugin never needs more than a
 * couple of methods from each service, and a structural type keeps every
 * dependency fakeable in a unit test without a booted harness.
 *
 * @module dsh-vision-bridge/service
 */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Read one service from the context without throwing.
 *
 * Two host rules make the obvious property read wrong. A service that is not in
 * the plugin's `inject` list is not readable as a property at all — the host
 * throws `cannot get property "<name>" without inject` — and a read can also
 * throw while the context is being torn down. `ctx.get(name)` is the sanctioned
 * optional lookup, so it goes first; the property read is kept as the fallback
 * for the ambient handles that are not services at all (`logger`, `fs`-style
 * declared dependencies) and for structural contexts without `get` (unit tests,
 * a hand-built host). A capability probe must never be the thing that fails a
 * tool call, and it must never report an available service as absent.
 * @param ctx - plugin context.
 * @param name - service property name on the context.
 * @returns the service, or undefined when absent or unreadable.
 */
export function safeGet<T>(ctx: Context, name: string): T | undefined {
  try {
    const get = (ctx as unknown as { get?: (key: string) => unknown }).get
    if (typeof get === 'function') {
      const viaGet = get.call(ctx, name)
      if (viaGet !== undefined && viaGet !== null) return viaGet as T
    }
  } catch {
    // A `get` that throws means the optional lookup is unavailable here; the
    // property read below is still worth attempting.
  }
  try {
    const value = (ctx as unknown as Record<string, unknown>)[name]
    return value === undefined || value === null ? undefined : value as T
  } catch {
    return undefined
  }
}

/**
 * Read a required service, failing with an actionable message when it is absent.
 *
 * The message names the service and the operation, because the realistic cause
 * is a profile that does not mount it — and the user, not the developer, is who
 * sees this text.
 * @param ctx - plugin context.
 * @param name - service property name on the context.
 * @param purpose - what the caller needed the service for.
 * @returns the service.
 */
export function requireService<T>(ctx: Context, name: string, purpose: string): T {
  const service = safeGet<T>(ctx, name)
  if (service === undefined) {
    throw new Error('dsh-vision-bridge needs the "' + name + '" service to ' + purpose
      + ', and it is not mounted in this profile')
  }
  return service
}
