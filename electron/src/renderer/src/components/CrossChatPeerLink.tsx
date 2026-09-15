import type { ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { WorkspaceProfileScope } from '@shared/types'
import { useAppStore } from '../store/app-store'

/** Navigation only: never resolve a display name into a route or read mail. */
export function CrossChatPeerLink({ peerId, sessionId, profileScope, children }: {
  peerId: string | null | undefined; sessionId: string; profileScope: WorkspaceProfileScope | null; children: ReactNode
}) {
  const targetId = peerId?.trim()
  if (window.agentsDock.sharedChat || !targetId || targetId === sessionId) return <strong>{children}</strong>
  const scopeCurrent = () => {
    const state = useAppStore.getState()
    return profileScope && state.activeProfileId === profileScope.profileId
      && state.profileGeneration === profileScope.profileGeneration
      && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === profileScope.serverIdentity
  }
  const open = async () => {
    if (!scopeCurrent()) return
    const state = useAppStore.getState()
    if (!state.sessions.some(session => session.id === targetId)) {
      state.setError(t('teamNetwork.shell.chatUnavailable'))
      return
    }
    try { await state.selectSession(targetId) }
    catch { if (scopeCurrent()) useAppStore.getState().setError(t('teamNetwork.shell.chatOpenFailed')) }
  }
  return <button type="button" className="cross-chat-peer-link" title={t('emergency.openChat')}
    onClick={() => void open()}>{children}</button>
}
