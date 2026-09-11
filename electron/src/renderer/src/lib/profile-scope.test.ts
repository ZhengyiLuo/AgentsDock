import { describe, expect, it } from 'vitest'
import { profileSessionKey, rendererProfileKey } from './profile-scope'

describe('renderer profile scope', () => {
  it('keeps identical session IDs distinct across profiles', () => {
    expect(profileSessionKey('profile-a', 'shared-chat')).toBe('profile-a:shared-chat')
    expect(profileSessionKey('profile-b', 'shared-chat')).toBe('profile-b:shared-chat')
    expect(profileSessionKey('profile-a', 'shared-chat')).not.toBe(profileSessionKey('profile-b', 'shared-chat'))
  })

  it('provides a stable key while the initial profile is unresolved', () => {
    expect(rendererProfileKey(null)).toBe('unidentified-profile')
  })
})
