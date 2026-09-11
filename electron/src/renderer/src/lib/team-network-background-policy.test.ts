import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const renderer = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('Team Network must not schedule background traffic', () => {
  for (const file of ['components/TeamNetwork.tsx', 'components/TeamMessagesBoard.tsx', 'components/SecurePeerPanel.tsx']) {
    it(`${file} uses explicit loads, not polling or live streams`, () => {
      const source = readFileSync(resolve(renderer, file), 'utf8')
      const schedulers = source.match(/\b(?:startRendererBackgroundPolling|scheduleRendererBackgroundWork|setInterval|setTimeout|EventSource|WebSocket)\s*\(/g) ?? []
      expect(schedulers).toEqual([])
    })
  }

  it('does not mount an inbox monitor beside chats and terminals', () => {
    const app = readFileSync(resolve(renderer, 'App.tsx'), 'utf8')
    expect(app.match(/TeamNetworkInboxNotice|TeamMessagesInboxNotice|LegacyTeamNetworkInboxNotice/g) ?? []).toEqual([])
  })

  it('confines the reply typing debounce to local draft persistence', () => {
    const source = readFileSync(resolve(renderer, 'lib/team-mail-reply-draft.ts'), 'utf8')
    expect(source).toContain('localStorage.setItem')
    expect(source.match(/\bsetTimeout\s*\(/g)).toHaveLength(1)
    expect(source.match(/\b(?:agentsDock|fetch|XMLHttpRequest|WebSocket|EventSource|setInterval)\b/g) ?? []).toEqual([])
  })
})
