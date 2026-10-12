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
 * A service read can throw when the context is being torn down, and a
 * capability probe must never be the thing that fails a tool call.
 * @param ctx - plugin context.
 * @param name - service property name on the context.
 * @returns the service, or undefined when absent or unreadable.
 */
export function safeGet<T>(ctx: Context, name: string): T | undefined {
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
