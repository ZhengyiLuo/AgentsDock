import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { AppState as NativeAppState } from 'react-native'
import { client, useAppStore } from '../store/useAppStore'
import { sideChatSupported, sideQuestionLimit } from '../lib/side-chat'
import { SideChatController, type SideChatPendingReceipt } from '../lib/side-chat-controller'

export function useSideChat(sessionId: string, visible: boolean) {
  const backend = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.backend)
  const health = useAppStore(state => state.health)
  const profileId = useAppStore(state => state.activeProfileId)
  const generation = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switching = useAppStore(state => state.switchingProfileId)
  const adopting = useAppStore(state => state.workspaceAdopting)
  const selected = useAppStore(state => state.selectedSessionId)
  const syncStatus = useAppStore(state => state.syncSessionId === sessionId ? state.syncStatus : null)
  const connection = client
  const validation = connection.validationRevision
  const identity = health?.server_identity
  const instance = health?.server_instance_id
  const owner = `${profileId ?? ''}:${generation}:${sessionId}:${backend ?? ''}`
  const knownServer = useRef({ owner, identity })
  // A transient health failure may clear metadata. Retain only the uncertain
  // mutation receipt through that gap, never render a prior owner's snapshot.
  if (knownServer.current.owner !== owner || (identity && identity !== knownServer.current.identity)) {
    knownServer.current = { owner, identity }
  }
  const pendingReceipt = useMemo<SideChatPendingReceipt>(() => ({ current: null }),
    [owner, knownServer.current.identity])
  const supported = sideChatSupported(health, backend)
  const available = Boolean(visible && supported && profileId && selected === sessionId
    && connected && !connecting && !switching && !adopting && connection.isValidated)
  const limit = sideQuestionLimit(health)

  // Construct a fresh owner synchronously during render so previous-server
  // data cannot flash for one frame before an effect resets it.
  const controller = useMemo(() => new SideChatController(connection, sessionId, () => {
    const current = useAppStore.getState()
    return available && client === connection && connection.isValidated
      && connection.validationRevision === validation
      && current.activeProfileId === profileId && current.profileGeneration === generation
      && current.selectedSessionId === sessionId && current.connected && !current.connecting
      && !current.switchingProfileId && !current.workspaceAdopting
      && current.health?.server_identity === identity && current.health?.server_instance_id === instance
      && current.sessions.find(session => session.id === sessionId)?.backend === backend
      && sideChatSupported(current.health, backend)
  }, limit, undefined, pendingReceipt), [available, connection, sessionId, validation, profileId, generation, identity, instance, backend, limit, pendingReceipt])
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)

  useEffect(() => {
    if (!available) return () => controller.dispose()
    controller.activate()
    const unsubscribe = connection.subscribeSideChatChanges((changedSessionId, revision) => {
      if (changedSessionId === sessionId && NativeAppState.currentState === 'active') controller.invalidate(revision)
    })
    const foreground = NativeAppState.addEventListener('change', next => {
      if (next === 'active') void controller.refresh()
    })
    if (NativeAppState.currentState === 'active') void controller.refresh()
    return () => { unsubscribe(); foreground.remove(); controller.dispose() }
  }, [available, connection, controller, sessionId])

  useEffect(() => {
    if (available && syncStatus === 'live' && NativeAppState.currentState === 'active') void controller.refresh()
  }, [available, controller, syncStatus])

  return {
    ...state, supported, available,
    offline: !health || !connected || connecting || Boolean(switching) || adopting || !connection.isValidated,
    refresh: controller.refresh, submit: controller.submit, stop: controller.stop, clear: controller.clear,
  }
}
