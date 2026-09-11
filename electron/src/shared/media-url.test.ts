import { describe, expect, it } from 'vitest'
import { buildMediaURL, buildTeamAttachmentMediaURL, buildWorkspaceMediaURL, parseMediaURL } from './media-url'

describe('profile-scoped media URLs', () => {
  it('uses different browser cache keys for the same file ID on different profiles', () => {
    expect(buildMediaURL('profile-a', 3, 'chat-a', 'same-file')).toBe('agentsdock-media://file/profile-a/3/chat-a/same-file')
    expect(buildMediaURL('profile-b', 3, 'chat-a', 'same-file')).toBe('agentsdock-media://file/profile-b/3/chat-a/same-file')
    expect(buildMediaURL('profile-a', 3, 'chat-a', 'same-file')).not.toBe(buildMediaURL('profile-b', 3, 'chat-a', 'same-file'))
    expect(buildMediaURL('profile-a', 3, 'chat-a', 'same-file')).not.toBe(buildMediaURL('profile-a', 4, 'chat-a', 'same-file'))
    expect(buildMediaURL('profile-a', 3, 'chat-a', 'same-file')).not.toBe(buildMediaURL('profile-a', 3, 'chat-b', 'same-file'))
  })

  it('round-trips encoded profile and file segments', () => {
    const url = buildMediaURL('profile alpha', 7, 'chat #1', 'file #1')
    expect(url).toBe('agentsdock-media://file/profile%20alpha/7/chat%20%231/file%20%231')
    expect(parseMediaURL(url)).toEqual({ profileId: 'profile alpha', profileGeneration: 7, sessionId: 'chat #1', fileId: 'file #1' })

    const teamURL = buildTeamAttachmentMediaURL('profile alpha', 7, 9, '11111111-1111-4111-8111-111111111111', 'team #1', 'attachment #1')
    expect(teamURL).toBe('agentsdock-media://team/profile%20alpha/7/9/11111111-1111-4111-8111-111111111111/team%20%231/attachment%20%231')
    expect(parseMediaURL(teamURL)).toEqual({
      profileId: 'profile alpha',
      profileGeneration: 7,
      hubGeneration: 9,
      authCacheEpoch: '11111111-1111-4111-8111-111111111111',
      teamId: 'team #1',
      attachmentId: 'attachment #1'
    })
  })

  it('rejects legacy, ambiguous, and malformed media paths', () => {
    expect(parseMediaURL('agentsdock-media://file/profile-a/same-file')).toBeNull()
    expect(parseMediaURL('agentsdock-media://file/profile-a/1/chat-a/same-file/extra')).toBeNull()
    expect(parseMediaURL('agentsdock-media://file/profile-a/1/chat-a/%E0%A4%A')).toBeNull()
    expect(parseMediaURL('agentsdock-media://other/profile-a/1/chat-a/same-file')).toBeNull()
    expect(parseMediaURL('agentsdock-media://file/profile-a/01/chat-a/same-file')).toBeNull()
    expect(parseMediaURL('agentsdock-media://file/profile-a/1/chat-a/same-file?profile=profile-b')).toBeNull()
  })

  it('round-trips a profile- and session-scoped workspace path as one cache-safe segment', () => {
    const url = buildWorkspaceMediaURL('profile alpha', 7, 'chat #1', 'docs/design draft/image #1.png')
    expect(url).toBe(
      'agentsdock-media://workspace/profile%20alpha/7/chat%20%231/docs%2Fdesign%20draft%2Fimage%20%231.png'
    )
    expect(parseMediaURL(url)).toEqual({
      profileId: 'profile alpha',
      profileGeneration: 7,
      sessionId: 'chat #1',
      path: 'docs/design draft/image #1.png'
    })
  })

  it('uses different workspace preview cache keys across profiles, generations, chats, and paths', () => {
    const base = buildWorkspaceMediaURL('profile-a', 3, 'chat-a', 'assets/preview.png')
    expect(base).not.toBe(buildWorkspaceMediaURL('profile-b', 3, 'chat-a', 'assets/preview.png'))
    expect(base).not.toBe(buildWorkspaceMediaURL('profile-a', 4, 'chat-a', 'assets/preview.png'))
    expect(base).not.toBe(buildWorkspaceMediaURL('profile-a', 3, 'chat-b', 'assets/preview.png'))
    expect(base).not.toBe(buildWorkspaceMediaURL('profile-a', 3, 'chat-a', 'assets/other.png'))
  })

  it('rejects malformed and non-canonical workspace media paths', () => {
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a/src/file.png')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/01/chat-a/src%2Ffile.png')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a/%2Fetc%2Fpasswd')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a/src%2F..%2Fsecret.png')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a/src%5Cfile.png')).toBeNull()
    expect(parseMediaURL('agentsdock-media://workspace/profile-a/1/chat-a/src%2Ffile.png?download=1')).toBeNull()
    expect(() => buildWorkspaceMediaURL('profile-a', 1, 'chat-a', '../secret.png')).toThrow(TypeError)
  })
})
