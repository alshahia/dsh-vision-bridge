/**
 * In-memory filesystem service for unit tests.
 *
 * A structural fake rather than a mock framework: the bridge only uses
 * `resolve`/`contains`/`stat`/`readBytes`/`readText`/`writeText`/`listDir`/
 * `processPath`, and a small real implementation lets a test assert containment
 * and byte-cap behavior honestly instead of asserting that a mock was called.
 *
 * `normalizePath` resolves `..` and `.` exactly as the real backend's path
 * resolution does. That matters: the traversal test is only meaningful if the
 * fake collapses `..` before `contains` sees the path.
 *
 * @module dsh-vision-bridge/tests/helpers/fake-fs
 */
import type { Context } from '@deepseek-ai/cordis'

/** A path normalized to forward slashes with `.`/`..` collapsed. */
export function normalizePath(path: string): string {
  const unified = path.replace(/\\/gu, '/')
  const driveMatch = /^([A-Za-z]):(?=\/|$)/u.exec(unified)
  const drive = driveMatch ? driveMatch[1]!.toUpperCase() + ':' : ''
  const rest = driveMatch ? unified.slice(driveMatch[0].length) : unified
  const absolute = drive !== '' || rest.startsWith('/')
  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(segment)
  }
  const joined = parts.join('/')
  if (drive !== '') return drive + '/' + joined
  return absolute ? '/' + joined : joined
}

/** Whether a normalized path is absolute. */
export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:\//u.test(path) || path.startsWith('/')
}

interface FakeTarget {
  targetKey: string
  displayPath: string
}

interface FakeDirEntry {
  name: string
  type: 'file' | 'directory'
  target: FakeTarget
  size?: number
}

/** The fake filesystem plus its inspectable state. */
export interface FakeFs {
  ctx: Context
  files: Map<string, Uint8Array>
  /** Every path passed to `writeText`, in order. */
  writes: string[]
}

/**
 * Build a context whose only service is an in-memory filesystem.
 * @param options - seed files (keyed by path) and empty directories.
 * @returns the fake filesystem and a context carrying it.
 */
export function createFakeFs(
  options: { files?: Record<string, Uint8Array>, dirs?: readonly string[] } = {},
): FakeFs {
  const files = new Map<string, Uint8Array>()
  for (const [path, bytes] of Object.entries(options.files ?? {})) {
    files.set(normalizePath(path), bytes)
  }
  const dirs = new Set((options.dirs ?? []).map(normalizePath))
  const writes: string[] = []

  const target = (path: string): FakeTarget => ({
    targetKey: normalizePath(path),
    displayPath: normalizePath(path),
  })
  const isDir = (path: string): boolean =>
    dirs.has(path) || [...files.keys()].some(key => key.startsWith(path + '/'))

  const fs = {
    async resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FakeTarget> {
      const raw = normalizePath(path)
      if (isAbsolutePath(raw)) return target(raw)
      return target(normalizePath(opts?.cwd ?? '/') + '/' + raw)
    },
    processPath(t: FakeTarget): string {
      return t.displayPath
    },
    contains(parent: FakeTarget, child: FakeTarget): boolean {
      return child.displayPath === parent.displayPath
        || child.displayPath.startsWith(parent.displayPath + '/')
    },
    async stat(t: FakeTarget): Promise<{ version: string, type: 'file' | 'directory', size?: number } | undefined> {
      const bytes = files.get(t.displayPath)
      if (bytes !== undefined) return { version: 'v1', type: 'file', size: bytes.byteLength }
      if (isDir(t.displayPath)) return { version: 'v1', type: 'directory' }
      return undefined
    },
    async readBytes(t: FakeTarget, _signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array> {
      const bytes = files.get(t.displayPath)
      if (bytes === undefined) throw new Error('fake-fs: no such file ' + t.displayPath)
      if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
        throw new Error('fake-fs: ' + t.displayPath + ' exceeds maxBytes')
      }
      return bytes.slice()
    },
    async readText(t: FakeTarget): Promise<string> {
      const bytes = files.get(t.displayPath)
      if (bytes === undefined) throw new Error('fake-fs: no such file ' + t.displayPath)
      return new TextDecoder().decode(bytes)
    },
    async writeText(t: FakeTarget, content: string): Promise<{ version: string }> {
      files.set(t.displayPath, new TextEncoder().encode(content))
      writes.push(t.displayPath)
      return { version: 'v' + String(writes.length) }
    },
    async listDir(t: FakeTarget): Promise<FakeDirEntry[]> {
      const prefix = t.displayPath + '/'
      const entries = new Map<string, FakeDirEntry>()
      for (const [key, bytes] of files) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const name = rest.split('/')[0]!
        if (entries.has(name)) continue
        const nested = rest.includes('/')
        entries.set(name, {
          name,
          type: nested ? 'directory' : 'file',
          target: target(prefix + name),
          ...nested ? {} : { size: bytes.byteLength },
        })
      }
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue
        const rest = dir.slice(prefix.length)
        if (rest === '') continue
        const name = rest.split('/')[0]!
        if (entries.has(name)) continue
        entries.set(name, { name, type: 'directory', target: target(prefix + name) })
      }
      return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
  }

  return { ctx: { fs } as unknown as Context, files, writes }
}

/** Minimal valid PNG bytes: the real signature followed by zero padding. */
export function pngBytes(totalBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(totalBytes, 8))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

/** Minimal valid JPEG bytes: the real signature followed by zero padding. */
export function jpegBytes(totalBytes = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(totalBytes, 3))
  bytes.set([0xff, 0xd8, 0xff], 0)
  return bytes
}
