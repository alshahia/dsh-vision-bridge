import { describe, expect, it } from 'vitest'
import { pickProjectDir, projectDirOf, sessionProjectDir } from '../src/workspace.ts'

describe('pickProjectDir', () => {
  it('returns the first absolute candidate', () => {
    expect(pickProjectDir([undefined, 'D:/first', 'D:/second'], 'D:/fallback')).toBe('D:/first')
  })

  it('skips relative, empty, and non-string candidates', () => {
    expect(pickProjectDir(['relative', '', undefined], 'D:/fallback')).toBe('D:/fallback')
  })

  it('accepts a POSIX-absolute candidate', () => {
    expect(pickProjectDir(['/home/me/proj'], 'D:/fallback')).toBe('/home/me/proj')
  })
})

describe('sessionProjectDir', () => {
  it('reads the session creation directory', () => {
    expect(sessionProjectDir({ session: { header: { cwd: 'D:/proj' } } })).toBe('D:/proj')
  })

  it('rejects a relative or empty recorded cwd', () => {
    expect(sessionProjectDir({ session: { header: { cwd: 'proj' } } })).toBeUndefined()
    expect(sessionProjectDir({ session: { header: { cwd: '' } } })).toBeUndefined()
  })

  it('rejects a non-string recorded cwd', () => {
    expect(sessionProjectDir({ session: { header: { cwd: 42 } } })).toBeUndefined()
  })

  it('degrades to undefined for a session without a header', () => {
    expect(sessionProjectDir({ session: {} })).toBeUndefined()
    expect(sessionProjectDir({})).toBeUndefined()
    expect(sessionProjectDir(undefined)).toBeUndefined()
    expect(sessionProjectDir(null)).toBeUndefined()
  })

  it('never throws on a hostile shape', () => {
    const hostile = {
      get session(): never {
        throw new Error('boom')
      },
    }
    expect(sessionProjectDir(hostile)).toBeUndefined()
  })
})

describe('projectDirOf', () => {
  it('prefers the session directory over the launch directory', () => {
    expect(projectDirOf({ session: { header: { cwd: 'D:/proj' } } }, 'D:/launch')).toBe('D:/proj')
  })

  it('falls back to the launch directory when the session records none', () => {
    expect(projectDirOf({ session: {} }, 'D:/launch')).toBe('D:/launch')
  })

  it('keeps two sessions in different projects apart', () => {
    const a = projectDirOf({ session: { header: { cwd: 'D:/alpha' } } }, 'D:/launch')
    const b = projectDirOf({ session: { header: { cwd: 'D:/beta' } } }, 'D:/launch')
    expect(a).not.toBe(b)
  })
})
