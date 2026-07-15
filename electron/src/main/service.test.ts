import { describe, expect, it, vi } from 'vitest'
import type { Session, UpdateSessionInput } from '../shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: class {},
  dialog: {},
  nativeImage: {},
  Notification: class { static isSupported() { return false } },
  shell: {}
}))

import { AppService } from './service'

function serviceHarness(updated: Session) {
  const updateSession = vi.fn().mockResolvedValue(updated)
  const disconnectTerminal = vi.fn()
  const upsertSession = vi.fn()
  const service = Object.create(AppService.prototype) as AppService
  Object.assign(service, {
    client: { updateSession },
    disconnectTerminal,
    upsertSession
  })
  return { service, updateSession, disconnectTerminal, upsertSession }
}

describe('session terminal lifecycle', () => {
  it('disconnects the local terminal after a chat is archived', async () => {
    const updated: Session = { id: 'chat', title: 'Chat', backend: 'codex', archived: true }
    const { service, disconnectTerminal, upsertSession } = serviceHarness(updated)

    await service.updateSession('chat', { archived: true } as UpdateSessionInput)

    expect(disconnectTerminal).toHaveBeenCalledWith('chat')
    expect(upsertSession).toHaveBeenCalledWith(updated)
  })

  it('does not disconnect the terminal for ordinary session edits', async () => {
    const updated: Session = { id: 'chat', title: 'Renamed', backend: 'codex', archived: false }
    const { service, disconnectTerminal } = serviceHarness(updated)

    await service.updateSession('chat', { title: 'Renamed' } as UpdateSessionInput)

    expect(disconnectTerminal).not.toHaveBeenCalled()
  })
})
