// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from './lib/i18n'
import { saveLocalStorage, verifyLocalStorageWritable } from './lib/local-storage'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { LoaderCircle, RotateCcw, Siren, X } from 'lucide-react'
import type { AppUpdateStatus } from '@shared/types'
import { normalizeSecurePeerJoinTarget } from '@shared/secure-peer'
import { ChatHeader } from './components/ChatHeader'
import { ChatPane } from './components/ChatPane'
import { ChatSplitView } from './components/ChatSplitView'
import { CodeReview } from './components/CodeReview'
import { ClaudeInteractionShelf } from './components/ClaudeInteractionShelf'
import { ClaudeRuntimeProvider } from './components/ClaudeRuntimeContext'
import { CodexInteractionShelf } from './components/CodexInteractionShelf'
import { CodexRuntimeProvider } from './components/CodexRuntimeContext'
import { Composer } from './components/Composer'
import { Dialogs } from './components/Dialogs'
import { EmergencyTimelineDock } from './components/EmergencyTimelineDock'
import { InspectorDock } from './components/InspectorDock'
import { InspectorWorkspace, type InspectorWorkspaceTab } from './components/InspectorWorkspace'
import { SideChatController } from './lib/side-chat'
import { Sidebar } from './components/Sidebar'
import { TerminalDock } from './components/TerminalDock'
import { TeamNetwork, type PendingSecurePeerInvite, type TeamNetworkMailboxTarget, type TeamNetworkMessageTarget, type TeamNetworkSection } from './components/TeamNetwork'
import { Timeline } from './components/Timeline'
import { WelcomeChat } from './components/WelcomeChat'
import { WorkspaceEditor } from './components/WorkspaceEditor'
import { trackEvent } from './lib/analytics'
import { activeEmergencyAlert } from './lib/emergency-alert'
import { isTerminalToggleShortcut } from './lib/workspace-shortcuts'
import {
  WorkspaceResizeHandles,
  persistWorkspaceSidebarVisible,
  savedWorkspaceColumnStyle,
  savedWorkspaceSidebarVisible
} from './components/WorkspaceResizeHandles'
import { reviewTargetBelongsToSession, sameCodeReviewTarget, type CodeReviewTarget } from './lib/timeline'
import { closeTopTransient } from './lib/transient-close'
import { installRendererStallMonitor } from './lib/renderer-stall-monitor'
import { nativeFileRefsFromFiles } from './lib/native-files'
import { profileSessionKey, rendererWorkspaceKey } from './lib/profile-scope'
import { ChatFontApplier } from './lib/chat-font'
import { flushActiveWorkspace, useAppStore } from './store/app-store'

interface ScopedReviewTarget {
  profileId: string | null
  profileGeneration: number
  target: CodeReviewTarget
}

interface PendingWorkspaceOpenEvent {
  event: Event
  targetKey: string
}

interface SplitWorkspaceTarget {
  key: string
  sessionId: string
  profileId: string | null
  profileGeneration: number
  serverIdentity: string | null
  cwd: string
}

const splitWorkspaceKey = (target: Omit<SplitWorkspaceTarget, 'key'>): string => JSON.stringify([
  target.profileId,
  target.profileGeneration,
  target.serverIdentity,
  target.sessionId,
  target.cwd
])

const AVAILABLE_CODEX_CONTROLS = Object.freeze({ available: true })
const AVAILABLE_CLAUDE_CONTROLS = Object.freeze({
  available: true,
  interactive_client_capability: 'claude_sdk_interactive_v1'
})

export function App() {
  useLocale()
  const initialize = useAppStore(state => state.initialize)
  const initialized = useAppStore(state => state.initialized)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const activeServerIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const inspectorVisible = useAppStore(state => state.inspectorVisible)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const chatPanes = useAppStore(state => state.chatPanes)
  const focusedChatPane = useAppStore(state => state.focusedChatPane)
  const selectedSession = useAppStore(state => state.sessions.find(session => session.id === state.selectedSessionId) ?? null)
  const noServerConfigured = useAppStore(state => state.profiles.length === 0)
  const primarySession = useAppStore(state => state.sessions.find(session => session.id === state.chatPanes.primary) ?? null)
  const secondarySession = useAppStore(state => state.sessions.find(session => session.id === state.chatPanes.secondary) ?? null)
  // Health also includes high-frequency activity and queue telemetry. Keep the
  // app shell subscribed only to the primitive contract fields it renders so
  // a heartbeat cannot repaint every workspace, timeline and input surface.
  const workspaceFilesAvailable = useAppStore(state => state.health === null
    ? null
    : state.health.capabilities?.workspace_files?.available === true)
  const workspaceFilesVersion = useAppStore(state => state.health?.capabilities?.workspace_files?.version)
  const workspaceFilesMaxTextFileBytes = useAppStore(state => state.health?.capabilities?.workspace_files?.max_text_file_bytes)
  const workspaceFilesUnavailableMessage = useAppStore(state => {
    const capability = state.health?.capabilities?.workspace_files
    return [capability?.message, capability?.action].filter(Boolean).join(' ')
  })
  const codexControlsAvailable = useAppStore(state => state.health?.capabilities?.codex_controls?.available === true)
  const claudeControlsAvailable = useAppStore(state => {
    const capability = state.health?.capabilities?.claude_controls
    return capability?.available === true
      && (capability.interactive_client_capability ?? capability.interactive_capability) === 'claude_sdk_interactive_v1'
  })
  const codexControlsCapability = codexControlsAvailable ? AVAILABLE_CODEX_CONTROLS : null
  const claudeControlsCapability = claudeControlsAvailable ? AVAILABLE_CLAUDE_CONTROLS : null
  const error = useAppStore(state => state.error)
  const storageFull = useAppStore(state => state.storageFull)
  const activeProfileKey = rendererWorkspaceKey(activeProfileId, activeServerIdentity)
  const activeRenderKey = `${activeProfileKey}:generation:${profileGeneration}`
  const selectedWorkspaceKey = selectedSessionId ? profileSessionKey(activeProfileId, selectedSessionId, activeServerIdentity) : `${activeProfileKey}:empty`
  const selectedRenderKey = `${activeRenderKey}:${selectedSessionId ?? 'empty'}`
  const workspaceProfileScope = useMemo(() => activeProfileId ? {
    profileId: activeProfileId,
    profileGeneration,
    serverIdentity: activeServerIdentity
  } : null, [activeProfileId, activeServerIdentity, profileGeneration])
  const [scopedReviewTarget, setScopedReviewTarget] = useState<ScopedReviewTarget | null>(null)
  const [sideChatController] = useState(() => new SideChatController())
  const [inspectorTab, setInspectorTab] = useState<InspectorWorkspaceTab>('details')
  const [sideChatFocusVersion, setSideChatFocusVersion] = useState(0)
  const [sideChatFocusTarget, setSideChatFocusTarget] = useState<string | null>(null)
  useEffect(() => () => sideChatController.reset(), [sideChatController, activeRenderKey, Boolean(switchingProfileId)])
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; profileId: string | null; profileGeneration: number }>).detail
      const state = useAppStore.getState()
      if (!detail || state.switchingProfileId || detail.profileId !== state.activeProfileId || detail.profileGeneration !== state.profileGeneration || window.agentsDock.sharedChat) return
      const session = state.sessions.find(candidate => candidate.id === detail.sessionId)
      if (!session || !['codex', 'claude'].includes(session.backend)) return
      if (state.chatPanes.primary === session.id) state.focusChatPane('primary')
      else if (state.chatPanes.secondary === session.id) state.focusChatPane('secondary')
      else if (state.selectedSessionId !== session.id) return
      setInspectorTab('details')
      setSideChatFocusTarget(JSON.stringify([detail.profileId, detail.profileGeneration, session.id]))
      setSideChatFocusVersion(value => value + 1)
      state.setInspectorVisible(true)
    }
    window.addEventListener('agentsdock:open-side-chat', open)
    return () => window.removeEventListener('agentsdock:open-side-chat', open)
  }, [])
  const columnStyle = useMemo(() => savedWorkspaceColumnStyle(activeProfileKey), [activeProfileKey])
  const shellRef = useRef<HTMLElement | null>(null)
  const fileDragTimeout = useRef<number | null>(null)
  const closingWindowRef = useRef(false)
  const pendingWorkspaceOpenEvent = useRef<PendingWorkspaceOpenEvent | null>(null)
  const replayingWorkspaceOpenEvent = useRef<Event | null>(null)
  const splitWorkspaceTargetRef = useRef<SplitWorkspaceTarget | null>(null)
  const readySplitWorkspaceKeyRef = useRef<string | null>(null)
  const splitWorkspaceOverlayRef = useRef<HTMLDivElement | null>(null)
  const [splitWorkspaceTarget, setSplitWorkspaceTarget] = useState<SplitWorkspaceTarget | null>(null)
  const [slowBoot, setSlowBoot] = useState(false)
  const [retryingStorage, setRetryingStorage] = useState(false)
  useEffect(() => {
    const failed = () => { useAppStore.setState({ storageFull: true }) }
    window.addEventListener('agentsdock:storage-full', failed)
    return () => window.removeEventListener('agentsdock:storage-full', failed)
  }, [])
  const retryStorage = async (): Promise<void> => {
    if (retryingStorage) return
    setRetryingStorage(true)
    try {
      await window.agentsDock.native.retryStorage()
      verifyLocalStorageWritable()
      await flushActiveWorkspace()
      useAppStore.setState({ storageFull: false, error: null })
      const state = useAppStore.getState()
      if (state.selectedSessionId) await state.selectSession(state.selectedSessionId, true)
    } catch (error) {
      useAppStore.setState({ storageFull: true, error: error instanceof Error ? error.message : t('storage.closeFailed') })
    } finally { setRetryingStorage(false) }
  }
  const [fileDropActive, setFileDropActive] = useState(false)
  const [teamspaceScopeKey, setTeamspaceScopeKey] = useState<string | null>(null)
  const [teamspaceInitialSection, setTeamspaceInitialSection] = useState<TeamNetworkSection>('mail')
  const [teamspaceMailboxTarget, setTeamspaceMailboxTarget] = useState<TeamNetworkMailboxTarget | null>(null)
  const [teamspaceMessageTarget, setTeamspaceMessageTarget] = useState<TeamNetworkMessageTarget | null>(null)
  const [teamspaceMailboxRequestId, setTeamspaceMailboxRequestId] = useState(0)
  const [pendingSecurePeerInvite, setPendingSecurePeerInvite] = useState<PendingSecurePeerInvite | null>(null)
  const securePeerInviteSequence = useRef(0)
  const teamspaceMailboxRequestSequence = useRef(0)
  const queuedSecurePeerInvite = useRef<string | null>(null)
  const [sidebarVisibilityByWorkspace, setSidebarVisibilityByWorkspace] = useState<Record<string, boolean>>({})
  const [terminalOpenBySession, setTerminalOpenBySession] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('agentsdock:terminal-open')
      if (saved) return JSON.parse(saved) as Record<string, boolean>
      const legacy = JSON.parse(localStorage.getItem('agentsdock:workspace-modes') || '{}') as Record<string, string>
      return Object.fromEntries(Object.entries(legacy).map(([sessionId, mode]) => [sessionId, mode === 'terminal']))
    } catch { return {} }
  })
  const reviewTarget = scopedReviewTarget?.profileId === activeProfileId && scopedReviewTarget.profileGeneration === profileGeneration
    ? scopedReviewTarget.target
    : null
  const teamspaceOpen = teamspaceScopeKey === activeRenderKey
  const sidebarVisible = sidebarVisibilityByWorkspace[activeProfileKey] ?? savedWorkspaceSidebarVisible(activeProfileKey)
  const terminalOpen = selectedSessionId && !selectedSession?.archived ? terminalOpenBySession[selectedWorkspaceKey] ?? false : false
  const toggleSidebar = useCallback(() => {
    const next = !sidebarVisible
    persistWorkspaceSidebarVisible(activeProfileKey, next)
    setSidebarVisibilityByWorkspace(current => ({ ...current, [activeProfileKey]: next }))
  }, [activeProfileKey, sidebarVisible])
  const setTerminalOpen = useCallback((sessionId: string, open: boolean) => {
    if (open) trackEvent('terminal_opened')
    const scopedKey = profileSessionKey(activeProfileId, sessionId, activeServerIdentity)
    setTerminalOpenBySession(current => {
      const next = { ...current, [scopedKey]: open }
      saveLocalStorage('agentsdock:terminal-open', JSON.stringify(next))
      return next
    })
  }, [activeProfileId, activeServerIdentity])
  const reviewVisible = Boolean(reviewTarget) && inspectorTab === 'review'
  const dockOpen = inspectorVisible || reviewVisible
  const visibleDockOpen = !teamspaceOpen && dockOpen
  const splitOpen = Boolean(primarySession && secondarySession)
  const clearFileDragTimeout = useCallback(() => {
    if (fileDragTimeout.current !== null) {
      window.clearTimeout(fileDragTimeout.current)
      fileDragTimeout.current = null
    }
  }, [])
  const resetFileDrag = useCallback(() => {
    clearFileDragTimeout()
    setFileDropActive(false)
  }, [clearFileDragTimeout])
  const markFileDragActive = useCallback(() => {
    setFileDropActive(true)
    clearFileDragTimeout()
    fileDragTimeout.current = window.setTimeout(resetFileDrag, 1_500)
  }, [clearFileDragTimeout, resetFileDrag])
  const dismissSplitWorkspace = useCallback(() => {
    const target = splitWorkspaceTargetRef.current
    splitWorkspaceTargetRef.current = null
    readySplitWorkspaceKeyRef.current = null
    pendingWorkspaceOpenEvent.current = null
    setSplitWorkspaceTarget(null)
    if (!target) return
    window.requestAnimationFrame(() => {
      if (splitWorkspaceTargetRef.current) return
      const state = useAppStore.getState()
      const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
      if (
        state.activeProfileId !== target.profileId
        || state.profileGeneration !== target.profileGeneration
        || serverIdentity !== target.serverIdentity
        || !state.chatPanes.primary
        || !state.chatPanes.secondary
      ) return
      document.querySelector<HTMLElement>(`[data-chat-pane="${state.focusedChatPane}"]`)?.focus({ preventScroll: true })
    })
  }, [])
  const workspaceEditorReady = useCallback((expectedTargetKey: string) => {
    const target = splitWorkspaceTargetRef.current
    if (!target || target.key !== expectedTargetKey) return
    const state = useAppStore.getState()
    const targetSession = state.sessions.find(session => session.id === target.sessionId)
    const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
    if (
      state.activeProfileId !== target.profileId
      || state.profileGeneration !== target.profileGeneration
      || serverIdentity !== target.serverIdentity
      || state.selectedSessionId !== target.sessionId
      || (state.chatPanes.primary !== target.sessionId && state.chatPanes.secondary !== target.sessionId)
      || !state.chatPanes.primary
      || !state.chatPanes.secondary
      || !targetSession
      || (targetSession.cwd ?? '') !== target.cwd
    ) return
    readySplitWorkspaceKeyRef.current = expectedTargetKey
    const pending = pendingWorkspaceOpenEvent.current
    if (!pending || pending.targetKey !== expectedTargetKey) return
    pendingWorkspaceOpenEvent.current = null
    replayingWorkspaceOpenEvent.current = pending.event
    try {
      window.dispatchEvent(pending.event)
    } finally {
      replayingWorkspaceOpenEvent.current = null
    }
  }, [])
  const renderedSplitWorkspaceKey = splitWorkspaceTarget?.key ?? null
  const renderedSplitWorkspaceReady = useCallback(() => {
    if (renderedSplitWorkspaceKey) workspaceEditorReady(renderedSplitWorkspaceKey)
  }, [renderedSplitWorkspaceKey, workspaceEditorReady])
  const presentQueuedSecurePeerInvite = useCallback((): boolean => {
    const invite = queuedSecurePeerInvite.current
    if (!invite) return false
    const state = useAppStore.getState()
    const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
    if (!state.initialized || state.switchingProfileId || !state.activeProfileId || !serverIdentity) return false
    const targetKey = `${rendererWorkspaceKey(state.activeProfileId, serverIdentity)}:generation:${state.profileGeneration}`
    queuedSecurePeerInvite.current = null
    securePeerInviteSequence.current += 1
    setPendingSecurePeerInvite({ id: securePeerInviteSequence.current, invite })
    setTeamspaceInitialSection('directory')
    setTeamspaceMailboxTarget(null)
    setTeamspaceScopeKey(targetKey)
    setScopedReviewTarget(null)
    state.setInspectorVisible(false)
    return true
  }, [])
  const queueSecurePeerInvite = useCallback((invite: string): void => {
    try {
      if (!normalizeSecurePeerJoinTarget(invite).expectedCaFingerprint) return
    } catch {
      return
    }
    queuedSecurePeerInvite.current = invite
    presentQueuedSecurePeerInvite()
  }, [presentQueuedSecurePeerInvite])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell) return
    for (const property of ['--sidebar-width', '--inspector-width', '--review-width'] as const) {
      const value = (columnStyle as Record<string, string>)[property]
      if (value) shell.style.setProperty(property, value)
    }
  }, [activeProfileKey, columnStyle])
  useLayoutEffect(() => {
    if (splitWorkspaceTarget) splitWorkspaceOverlayRef.current?.focus({ preventScroll: true })
  }, [splitWorkspaceTarget])

  useEffect(() => { trackEvent('app_launched') }, [])
  useEffect(() => { void initialize() }, [initialize])
  useEffect(() => installRendererStallMonitor(
    () => {
      const state = useAppStore.getState()
      const snapshot = state.selectedSessionId ? state.snapshots[state.selectedSessionId] : null
      return {
        sessionId: state.selectedSessionId,
        eventCount: snapshot?.events.length ?? 0,
        fileCount: snapshot?.files.length ?? 0,
        syncStatus: state.syncStatus
      }
    },
    details => { void window.agentsDock.native.log('performance', 'renderer responsiveness degraded', details) }
  ), [])
  useEffect(() => {
    if (initialized) return
    const timer = window.setTimeout(() => setSlowBoot(true), 5000)
    return () => window.clearTimeout(timer)
  }, [initialized])
  useEffect(() => {
    resetFileDrag()
  }, [resetFileDrag, selectedRenderKey, switchingProfileId])
  useEffect(() => {
    const resetOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetFileDrag()
    }
    const resetWhenHidden = () => {
      if (document.visibilityState !== 'visible') resetFileDrag()
    }
    window.addEventListener('dragend', resetFileDrag, true)
    window.addEventListener('drop', resetFileDrag, true)
    window.addEventListener('blur', resetFileDrag)
    window.addEventListener('pointerdown', resetFileDrag, true)
    window.addEventListener('keydown', resetOnEscape, true)
    document.addEventListener('visibilitychange', resetWhenHidden)
    return () => {
      window.removeEventListener('dragend', resetFileDrag, true)
      window.removeEventListener('drop', resetFileDrag, true)
      window.removeEventListener('blur', resetFileDrag)
      window.removeEventListener('pointerdown', resetFileDrag, true)
      window.removeEventListener('keydown', resetOnEscape, true)
      document.removeEventListener('visibilitychange', resetWhenHidden)
      clearFileDragTimeout()
    }
  }, [clearFileDragTimeout, resetFileDrag])
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<CodeReviewTarget>).detail
      const state = useAppStore.getState()
      if (state.switchingProfileId || !reviewTargetBelongsToSession(target, state.selectedSessionId)) return
      setInspectorTab('review')
      setScopedReviewTarget(current => current?.profileId === state.activeProfileId && current.profileGeneration === state.profileGeneration && sameCodeReviewTarget(current.target, target)
        ? null
        : { profileId: state.activeProfileId, profileGeneration: state.profileGeneration, target })
    }
    window.addEventListener('agentsdock:review-diff', open)
    return () => window.removeEventListener('agentsdock:review-diff', open)
  }, [])
  useEffect(() => {
    setScopedReviewTarget(current => current?.profileId === activeProfileId && current.profileGeneration === profileGeneration && reviewTargetBelongsToSession(current.target, selectedSessionId) ? current : null)
  }, [activeProfileId, profileGeneration, selectedSessionId])
  useEffect(() => {
    if (!splitOpen) return
    const openEditorForChat = (event: Event) => {
      if (replayingWorkspaceOpenEvent.current === event) return
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId ?? useAppStore.getState().selectedSessionId
      if (!targetSessionId || (targetSessionId !== chatPanes.primary && targetSessionId !== chatPanes.secondary)) return
      const state = useAppStore.getState()
      const session = state.sessions.find(candidate => candidate.id === targetSessionId)
      if (!session) return
      const pane = state.chatPanes.primary === targetSessionId
        ? 'primary'
        : state.chatPanes.secondary === targetSessionId
          ? 'secondary'
          : null
      if (!pane) return
      const serverIdentity = state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null
      const targetWithoutKey = {
        sessionId: targetSessionId,
        profileId: state.activeProfileId,
        profileGeneration: state.profileGeneration,
        serverIdentity,
        cwd: session.cwd ?? ''
      }
      const target: SplitWorkspaceTarget = {
        ...targetWithoutKey,
        key: splitWorkspaceKey(targetWithoutKey)
      }
      if (
        splitWorkspaceTargetRef.current?.key === target.key
        && readySplitWorkspaceKeyRef.current === target.key
      ) {
        state.focusChatPane(pane)
        return
      }
      event.stopImmediatePropagation()
      pendingWorkspaceOpenEvent.current = {
        event,
        targetKey: target.key
      }
      readySplitWorkspaceKeyRef.current = null
      splitWorkspaceTargetRef.current = target
      setSplitWorkspaceTarget(target)
      state.focusChatPane(pane)
    }
    window.addEventListener('agentsdock:open-workspace-file', openEditorForChat, true)
    window.addEventListener('agentsdock:open-workspace-path', openEditorForChat, true)
    window.addEventListener('agentsdock:open-agent-file', openEditorForChat, true)
    return () => {
      window.removeEventListener('agentsdock:open-workspace-file', openEditorForChat, true)
      window.removeEventListener('agentsdock:open-workspace-path', openEditorForChat, true)
      window.removeEventListener('agentsdock:open-agent-file', openEditorForChat, true)
    }
  }, [chatPanes.primary, chatPanes.secondary, splitOpen])
  useEffect(() => {
    const target = splitWorkspaceTargetRef.current
    if (!target) return
    const state = useAppStore.getState()
    const targetSession = state.sessions.find(session => session.id === target.sessionId)
    if (
      !splitOpen
      || activeProfileId !== target.profileId
      || profileGeneration !== target.profileGeneration
      || activeServerIdentity !== target.serverIdentity
      || selectedSessionId !== target.sessionId
      || (chatPanes.primary !== target.sessionId && chatPanes.secondary !== target.sessionId)
      || !targetSession
      || (targetSession.cwd ?? '') !== target.cwd
    ) dismissSplitWorkspace()
  }, [activeProfileId, activeServerIdentity, chatPanes.primary, chatPanes.secondary, dismissSplitWorkspace, primarySession?.cwd, profileGeneration, secondarySession?.cwd, selectedSessionId, splitOpen])
  useEffect(() => {
    if (!activeProfileId || !selectedSessionId) return
    const scopedKey = profileSessionKey(activeProfileId, selectedSessionId, activeServerIdentity)
    setTerminalOpenBySession(current => {
      if (Object.prototype.hasOwnProperty.call(current, scopedKey) || !Object.prototype.hasOwnProperty.call(current, selectedSessionId)) return current
      const next = { ...current, [scopedKey]: current[selectedSessionId] }
      delete next[selectedSessionId]
      saveLocalStorage('agentsdock:terminal-open', JSON.stringify(next))
      return next
    })
  }, [activeProfileId, activeServerIdentity, selectedSessionId])
  useEffect(() => {
    if (!selectedSession?.archived) return
    const scopedKey = profileSessionKey(activeProfileId, selectedSession.id, activeServerIdentity)
    if (!terminalOpenBySession[scopedKey]) return
    setTerminalOpenBySession(current => {
      if (!current[scopedKey]) return current
      const next = { ...current, [scopedKey]: false }
      saveLocalStorage('agentsdock:terminal-open', JSON.stringify(next))
      return next
    })
  }, [activeProfileId, activeServerIdentity, selectedSession?.id, selectedSession?.archived, terminalOpenBySession])
  useEffect(() => {
    const focusSplitPane = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.shiftKey) return
      if (document.querySelector('[aria-modal="true"]')) return
      const isMac = /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
      const exactModifiers = isMac
        ? event.metaKey && event.altKey && !event.ctrlKey
        : event.ctrlKey && event.altKey && !event.metaKey
      if (!exactModifiers) return
      const pane = event.key === 'ArrowLeft' || event.code === 'ArrowLeft'
        ? 'primary'
        : event.key === 'ArrowRight' || event.code === 'ArrowRight'
          ? 'secondary'
          : null
      if (!pane) return
      const state = useAppStore.getState()
      const { primary, secondary } = state.chatPanes
      if (
        !primary
        || !secondary
        || primary === secondary
        || !state.sessions.some(session => session.id === primary)
        || !state.sessions.some(session => session.id === secondary)
      ) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const workspaceCovered = Boolean(splitWorkspaceTargetRef.current)
      if (workspaceCovered) dismissSplitWorkspace()
      state.focusChatPane(pane)
      if (!workspaceCovered) {
        document.querySelector<HTMLElement>(`[data-chat-pane="${pane}"]`)?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', focusSplitPane, true)
    return () => window.removeEventListener('keydown', focusSplitPane, true)
  }, [dismissSplitWorkspace])
  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented
        && (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key === '/'
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        toggleSidebar()
        return
      }
      if (isTerminalToggleShortcut(event) && selectedSessionId) {
        event.preventDefault()
        event.stopPropagation()
        setTerminalOpen(selectedSessionId, !terminalOpen)
        return
      }
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (!event.shiftKey && key === 'l') {
        event.preventDefault()
        event.stopPropagation()
        if (reviewVisible) { setScopedReviewTarget(null); setInspectorTab('details') }
        else useAppStore.getState().setInspectorVisible(!inspectorVisible)
      }
    }
    window.addEventListener('keydown', handleWorkspaceShortcut, true)
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut, true)
  }, [inspectorVisible, reviewVisible, selectedSessionId, setTerminalOpen, terminalOpen, toggleSidebar])
  useEffect(() => {
    window.addEventListener('agentsdock:toggle-sidebar', toggleSidebar)
    return () => window.removeEventListener('agentsdock:toggle-sidebar', toggleSidebar)
  }, [toggleSidebar])
  useEffect(() => {
    // A pending invite is a user handoff, not a credential for the current
    // profile. Keep it while the user chooses which server should connect.
    if (pendingSecurePeerInvite && initialized && !switchingProfileId && activeProfileId && activeServerIdentity) {
      setTeamspaceScopeKey(activeRenderKey)
      return
    }
    setTeamspaceScopeKey(current => (
      current === null || current === activeRenderKey ? current : null
    ))
  }, [activeProfileId, activeRenderKey, activeServerIdentity, initialized, pendingSecurePeerInvite, switchingProfileId])
  useEffect(() => {
    const remove = window.agentsDock.events.on('native:secure-peer-invite', ({ invite }) => queueSecurePeerInvite(invite))
    const openLocalInvite = (event: Event): void => {
      const detail = (event as CustomEvent<{ invite?: unknown }>).detail
      if (typeof detail?.invite === 'string') queueSecurePeerInvite(detail.invite)
    }
    window.addEventListener('agentsdock:open-secure-peer-invite', openLocalInvite)
    return () => {
      remove()
      window.removeEventListener('agentsdock:open-secure-peer-invite', openLocalInvite)
    }
  }, [queueSecurePeerInvite])
  useEffect(() => {
    if (!initialized) return
    void window.agentsDock.native.readyForNotifications().catch(error => (
      window.agentsDock.native.log('notification', 'renderer readiness handshake failed', {
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined)
    ))
  }, [initialized])
  useEffect(() => {
    // The main process retains a cold-launch invite until this handshake.
    // Wait for one stable, identified AgentsServer scope so the bootstrap
    // transition cannot immediately clear an invite delivered under the
    // renderer's temporary pre-initialization key.
    if (!initialized || switchingProfileId || !activeProfileId || !activeServerIdentity) return
    presentQueuedSecurePeerInvite()
    void window.agentsDock.native.readyForSecurePeerInvite().catch(error => (
      window.agentsDock.native.log('secure-peer', 'invite readiness handshake failed', {
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined)
    ))
  }, [activeProfileId, activeServerIdentity, initialized, presentQueuedSecurePeerInvite, switchingProfileId])
  useEffect(() => {
    const open = (event: Event) => {
      const section = (event as CustomEvent<{ section?: unknown }>).detail?.section
      const detail = (event as CustomEvent<{
        teamId?: unknown; messageId?: unknown; mailboxBox?: unknown
        profileId?: unknown; serverIdentity?: unknown
        mailboxAddress?: { kind?: unknown; id?: unknown }
      }>).detail
      const app = useAppStore.getState()
      const profile = app.profiles.find(candidate => candidate.id === app.activeProfileId)
      if ((typeof detail?.profileId === 'string' && detail.profileId !== app.activeProfileId)
        || (typeof detail?.serverIdentity === 'string' && detail.serverIdentity !== profile?.serverIdentity)) {
        app.setError('This message belongs to another server. Switch to that server to open it.')
        return
      }
      const address = detail?.mailboxAddress
      teamspaceMailboxRequestSequence.current += 1
      setTeamspaceMailboxRequestId(teamspaceMailboxRequestSequence.current)
      setTeamspaceInitialSection(
        section === 'feed' || section === 'mail' || section === 'skills' || section === 'directory'
          ? section
          : 'mail'
      )
      setTeamspaceMailboxTarget(
        typeof detail?.teamId === 'string'
        && (address?.kind === 'server' || address?.kind === 'agent' || address?.kind === 'human')
        && typeof address.id === 'string'
          ? { teamId: detail.teamId, address: { kind: address.kind, id: address.id } }
          : null
      )
      setTeamspaceMessageTarget(
        typeof detail?.teamId === 'string' && detail.teamId.length > 0 && detail.teamId.length <= 240
        && typeof detail?.messageId === 'string' && detail.messageId.length > 0 && detail.messageId.length <= 240
          ? { teamId: detail.teamId, messageId: detail.messageId, mailboxBox: detail.mailboxBox === 'sent' ? 'sent' : 'inbox' }
          : null
      )
      setTeamspaceScopeKey(activeRenderKey)
      setScopedReviewTarget(null)
      useAppStore.getState().setInspectorVisible(false)
    }
    const close = () => setTeamspaceScopeKey(null)
    window.addEventListener('agentsdock:open-teamspace', open)
    window.addEventListener('agentsdock:close-teamspace', close)
    return () => {
      window.removeEventListener('agentsdock:open-teamspace', open)
      window.removeEventListener('agentsdock:close-teamspace', close)
    }
  }, [activeRenderKey])
  useEffect(() => {
    const closeSurface = () => {
      if (closeTopTransient()) return
      if (teamspaceOpen) { setTeamspaceScopeKey(null); return }
      const closeWorkspaceFile = new Event('agentsdock:workspace-close-active', { cancelable: true })
      window.dispatchEvent(closeWorkspaceFile)
      if (closeWorkspaceFile.defaultPrevented) return
      if (reviewVisible) { setScopedReviewTarget(null); setInspectorTab('details'); return }
      if (terminalOpen && selectedSessionId) { setTerminalOpen(selectedSessionId, false); return }
      if (splitWorkspaceTargetRef.current) { dismissSplitWorkspace(); return }
      if (splitOpen) { useAppStore.getState().closeChatPane(focusedChatPane); return }
      if (closingWindowRef.current) return
      closingWindowRef.current = true
      void flushActiveWorkspace()
        .then(() => window.agentsDock.native.closeWindow())
        .catch(() => { useAppStore.getState().setError(t('storage.closeFailed')) })
        .finally(() => { closingWindowRef.current = false })
    }
    window.addEventListener('agentsdock:close-surface', closeSurface)
    return () => window.removeEventListener('agentsdock:close-surface', closeSurface)
  }, [dismissSplitWorkspace, focusedChatPane, reviewVisible, selectedSessionId, setTerminalOpen, splitOpen, teamspaceOpen, terminalOpen])
  useEffect(() => window.agentsDock.events.on('native:close-request', ({ requestId }) => {
    void (async () => {
      let saved = false
      try {
        await flushActiveWorkspace()
        saved = true
      } catch (error) {
        useAppStore.getState().setError(t('storage.closeFailed'))
        await window.agentsDock.native.log('persistence', 'workspace flush before native close failed', {
          message: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined)
      } finally {
        await window.agentsDock.native.completeCloseFlush(requestId, saved).catch(error => (
          window.agentsDock.native.log('persistence', 'native close flush acknowledgement failed', {
            requestId,
            message: error instanceof Error ? error.message : String(error)
          }).catch(() => undefined)
        ))
      }
    })()
  }), [])
  const toggleTerminal = useCallback(() => {
    if (!selectedSessionId || selectedSession?.archived) return
    setTerminalOpen(selectedSessionId, !terminalOpen)
  }, [selectedSession?.archived, selectedSessionId, setTerminalOpen, terminalOpen])
  const closeTerminal = useCallback(() => {
    if (selectedSessionId) setTerminalOpen(selectedSessionId, false)
  }, [selectedSessionId, setTerminalOpen])
  const canDropFiles = Boolean(selectedSession && !selectedSession.archived && !switchingProfileId)
  const dragContainsFiles = (event: ReactDragEvent<HTMLDivElement>) => Array.from(event.dataTransfer.types).includes('Files')
  const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDropFiles || !dragContainsFiles(event)) return
    event.preventDefault()
    markFileDragActive()
  }
  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDropFiles || !dragContainsFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    markFileDragActive()
  }
  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!fileDropActive) return
    event.preventDefault()
    if (event.target !== event.currentTarget) return
    const destination = event.relatedTarget
    if (destination instanceof Node && event.currentTarget.contains(destination)) return
    resetFileDrag()
  }
  const handleFileDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDropFiles || !dragContainsFiles(event)) return
    event.preventDefault()
    resetFileDrag()
    try {
      const refs = await nativeFileRefsFromFiles(event.dataTransfer.files)
      const current = useAppStore.getState()
      if (
        refs.length
        && current.activeProfileId === activeProfileId
        && current.profileGeneration === profileGeneration
        && current.selectedSessionId === selectedSessionId
        && !current.switchingProfileId
      ) await current.attachPaths(refs)
    } catch (cause) {
      const current = useAppStore.getState()
      if (
        current.activeProfileId === activeProfileId
        && current.profileGeneration === profileGeneration
        && current.selectedSessionId === selectedSessionId
        && !current.switchingProfileId
      ) current.setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const handleChatShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented
      || !(event.metaKey || event.ctrlKey)
      || event.altKey
      || event.shiftKey
      || event.key.toLowerCase() !== 'd'
      || !selectedSessionId
    ) return
    event.preventDefault()
    event.stopPropagation()
    useAppStore.getState().setModal('digest', true)
  }

  const chatWorkspace = <div
    className="chat-workspace"
    onKeyDown={handleChatShortcut}
    onDragEnter={handleFileDragEnter}
    onDragOver={handleFileDragOver}
    onDragLeave={handleFileDragLeave}
    onDrop={handleFileDrop}
  >
    {noServerConfigured ? <WelcomeChat /> : <>
      <div className="chat-workspace-history">
        <Timeline key={`timeline:${selectedRenderKey}`} />
      </div>
      <div className="chat-workspace-shelves">
        <CodexInteractionShelf key={`codex-interactions:${selectedRenderKey}`} />
        <ClaudeInteractionShelf key={`claude-interactions:${selectedRenderKey}`} />
      </div>
      {selectedSession && <EmergencyTimelineDock
        key={`emergency:${selectedRenderKey}`}
        sessionId={selectedSession.id}
        focused
      />}
      {selectedSession?.archived
        ? <div className="composer disabled"><span>{t("ui.App.App.archived_chat_unarchive_it_to_send_a_messa_1b14da3")}</span></div>
        : <Composer key={`composer:${selectedRenderKey}`} dropActive={fileDropActive} />}
    </>}
  </div>

  const singleConversation = <>
    <ChatHeader
      key={`header:${selectedRenderKey}`}
      session={noServerConfigured ? null : undefined}
      sidebarVisible={sidebarVisible}
      terminalOpen={terminalOpen}
      onSidebarToggle={toggleSidebar}
      onTerminalToggle={selectedSession?.archived ? undefined : toggleTerminal}
      onOpenSplit={sessionId => void useAppStore.getState().openSessionInSplit(sessionId)}
    />
    {selectedSession
      ? <WorkspaceEditor
        key={`workspace-editor:${selectedRenderKey}:${selectedSession.cwd ?? ''}`}
        workspaceKey={`${selectedWorkspaceKey}:cwd:${selectedSession.cwd ?? ''}`}
        session={selectedSession}
        profileScope={workspaceProfileScope}
        available={workspaceFilesAvailable}
        capabilityVersion={workspaceFilesVersion}
        maxTextFileBytes={workspaceFilesMaxTextFileBytes}
        unavailableMessage={workspaceFilesUnavailableMessage}
        chatContent={chatWorkspace}
      />
      : chatWorkspace}
  </>

  const splitWorkspaceSession = splitWorkspaceTarget?.sessionId === primarySession?.id
    ? primarySession
    : splitWorkspaceTarget?.sessionId === secondarySession?.id
      ? secondarySession
      : null
  const splitWorkspaceProfileScope = splitWorkspaceTarget?.profileId ? {
    profileId: splitWorkspaceTarget.profileId,
    profileGeneration: splitWorkspaceTarget.profileGeneration,
    serverIdentity: splitWorkspaceTarget.serverIdentity
  } : null

  if (!initialized) {
    return <main className="app-boot"><LoaderCircle className="spin" size={20} /><span>{t("ui.App.App.opening_agentsdock_24f75ec")}</span>{slowBoot && <><small>{t("ui.App.App.startup_is_taking_longer_than_expected_che_4274a9c")}</small><button className="quiet-button" onClick={() => window.location.reload()}>{t("ui.App.App.retry_942087c")}</button></>}</main>
  }

  return (
    <main ref={shellRef} className={`app-shell ${sidebarVisible ? '' : 'sidebar-hidden '}${visibleDockOpen ? 'inspector-open' : ''}${reviewVisible && !teamspaceOpen ? ' review-open' : ''}${teamspaceOpen ? ' teamspace-open' : ''}${switchingProfileId ? ' profile-switching' : ''}`} style={columnStyle}>
      <ChatFontApplier />
      <Sidebar key={`sidebar:${activeRenderKey}`} hidden={!sidebarVisible} />
      <section className={`conversation-pane${teamspaceOpen ? ' teamspace-pane' : splitOpen ? ' split-open' : selectedSession ? ' workspace-editor-open' : ''}`} aria-busy={Boolean(switchingProfileId)} inert={switchingProfileId ? true : undefined}>
        {teamspaceOpen
          ? <TeamNetwork
            key={`teamspace:${activeRenderKey}`}
            initialMailboxTarget={teamspaceMailboxTarget}
            initialMessageTarget={teamspaceMessageTarget}
            onInitialMessageConsumed={() => setTeamspaceMessageTarget(null)}
            initialMailboxRequestId={teamspaceMailboxRequestId}
            initialSection={teamspaceInitialSection}
            onClose={() => setTeamspaceScopeKey(null)}
            pendingSecurePeerInvite={pendingSecurePeerInvite}
            onSecurePeerInviteHandled={requestId => setPendingSecurePeerInvite(current => {
              if (current?.id !== requestId) return current
              return null
            })}
          />
          : splitOpen && primarySession && secondarySession
          ? <>
            <ChatSplitView
              preferenceScope={workspaceProfileScope}
              inactive={Boolean(splitWorkspaceTarget)}
              primary={<ChatPane
                key={`${activeRenderKey}:${primarySession.id}`}
                pane="primary"
                session={primarySession}
                focused={focusedChatPane === 'primary'}
                split
                sidebarVisible={sidebarVisible}
                terminalOpen={focusedChatPane === 'primary' && terminalOpen}
                onSidebarToggle={toggleSidebar}
                onTerminalToggle={toggleTerminal}
              />}
              secondary={<ChatPane
                key={`${activeRenderKey}:${secondarySession.id}`}
                pane="secondary"
                session={secondarySession}
                focused={focusedChatPane === 'secondary'}
                split
                sidebarVisible={sidebarVisible}
                terminalOpen={focusedChatPane === 'secondary' && terminalOpen}
                onTerminalToggle={toggleTerminal}
              />}
            />
            {splitWorkspaceTarget && splitWorkspaceSession && <div
              ref={splitWorkspaceOverlayRef}
              className="split-workspace-overlay"
              role="region"
              aria-label={t("ui.App.App.file_workspace_7499ea9", { "name": String(splitWorkspaceSession.title) })}
              data-session-id={splitWorkspaceSession.id}
              tabIndex={-1}
            >
              <WorkspaceEditor
                key={`split-workspace-editor:${splitWorkspaceTarget.key}`}
                workspaceKey={`${profileSessionKey(splitWorkspaceTarget.profileId, splitWorkspaceSession.id, splitWorkspaceTarget.serverIdentity)}:cwd:${splitWorkspaceTarget.cwd}`}
                session={splitWorkspaceSession}
                profileScope={splitWorkspaceProfileScope}
                available={workspaceFilesAvailable}
                capabilityVersion={workspaceFilesVersion}
                maxTextFileBytes={workspaceFilesMaxTextFileBytes}
                unavailableMessage={workspaceFilesUnavailableMessage}
                onReady={renderedSplitWorkspaceReady}
                onReturnToChat={dismissSplitWorkspace}
                chatContent={<div className="split-workspace-return">
                  <strong>{t("ui.App.App.your_split_chats_are_still_open_4a8601f")}</strong>
                  <span>{t("ui.App.App.choose_chat_to_return_to_both_panes_3c6aab3")}</span>
                  <button type="button" className="quiet-button" onClick={dismissSplitWorkspace}>{t("ui.App.App.return_to_split_chats_f0b8029")}</button>
                </div>}
              />
            </div>}
          </>
          : selectedSession?.archived
            ? singleConversation
            : <ClaudeRuntimeProvider key={`claude-runtime:${selectedRenderKey}`} session={selectedSession} capability={claudeControlsCapability}>
              <CodexRuntimeProvider key={`codex-runtime:${selectedRenderKey}`} session={selectedSession} capability={codexControlsCapability}>
                {singleConversation}
              </CodexRuntimeProvider>
            </ClaudeRuntimeProvider>}
      </section>
      <InspectorDock
        open={visibleDockOpen}
        disabled={Boolean(switchingProfileId)}
        contentKey={selectedRenderKey}
        content={<InspectorWorkspace session={selectedSession} scope={{ profileId: activeProfileId ?? '', profileGeneration }}
          controller={sideChatController} tab={inspectorTab} focusVersion={sideChatFocusTarget === JSON.stringify([activeProfileId, profileGeneration, selectedSession?.id]) ? sideChatFocusVersion : 0} visible={visibleDockOpen}
          onFocusHandled={() => setSideChatFocusTarget(null)} onTabChange={setInspectorTab}
          onHide={() => { setInspectorTab(current => current === 'review' ? 'details' : current); useAppStore.getState().setInspectorVisible(false) }}
          review={reviewTarget ? <CodeReview target={reviewTarget} onClose={() => { setScopedReviewTarget(null); setInspectorTab('details') }} /> : undefined} />}
      />
      {!switchingProfileId && <WorkspaceResizeHandles
        key={`resize:${activeRenderKey}`}
        workspaceKey={activeProfileKey}
        sidebarVisible={sidebarVisible}
        inspectorOpen={visibleDockOpen}
        inspectorMode={reviewVisible ? 'review' : 'inspector'}
      />}
      {!switchingProfileId && !teamspaceOpen && selectedSession && <TerminalDock
        key={`terminal:${selectedRenderKey}`}
        workspaceKey={activeProfileKey}
        open={terminalOpen}
        session={selectedSession}
        onRequestClose={closeTerminal}
      />}
      {!storageFull && error && <div className="error-toast" role="alert"><span>{error}</span><button type="button" aria-label={t("ui.App.App.dismiss_error_2db0466")} onClick={() => useAppStore.getState().setError(null)}><X size={14} /></button></div>}
      <div className="top-right-notice-stack">
        <EmergencyNotice />
        {storageFull && <div className="error-toast storage-full-notice" role="alert">
          <span>{t('storage.fullWarning')}{error && <><br />{error}</>}</span>
          <button type="button" disabled={retryingStorage} onClick={() => { void retryStorage() }}>{t('storage.retrySaving')}</button>
        </div>}
        <UpdateNotice />
      </div>
      <Dialogs key={`dialogs:${activeRenderKey}`} />
    </main>
  )
}

const EMERGENCY_NOTICE_TIMEOUT_MS = 12_000

interface EmergencyNoticeCandidate {
  key: string
  chatKey: string
  scopeKey: string
  profileId: string
  serverIdentity: string | null
  sessionId: string
  sessionTitle: string
  alertId: string
  message: string
  raisedAt: string
}

export function EmergencyNotice() {
  useLocale()
  const sessions = useAppStore(state => state.sessions)
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const activeServerIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const scopeKey = JSON.stringify([activeProfileId])
  const candidates = useMemo(() => !activeProfileId || switchingProfileId ? [] : sessions.flatMap(session => {
    const alert = activeEmergencyAlert(session)
    return alert ? [{
      key: JSON.stringify([activeProfileId, session.id, alert.id]),
      chatKey: JSON.stringify([activeProfileId, session.id]),
      scopeKey,
      profileId: activeProfileId,
      serverIdentity: activeServerIdentity,
      sessionId: session.id,
      sessionTitle: session.title,
      alertId: alert.id,
      message: alert.message,
      raisedAt: alert.raised_at
    }] : []
  }).sort((left, right) => (
    (Date.parse(right.raisedAt) || 0) - (Date.parse(left.raisedAt) || 0)
    || right.key.localeCompare(left.key)
  )), [activeProfileId, activeServerIdentity, scopeKey, sessions, switchingProfileId])
  const seenKeys = useRef(new Set<string>())
  const [notices, setNotices] = useState<EmergencyNoticeCandidate[]>([])
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const validRoute = useCallback((notice: EmergencyNoticeCandidate) => profiles.some(profile => (
    profile.id === notice.profileId
    && (profile.serverIdentity ?? null) === notice.serverIdentity
  )), [profiles])
  const routeCanBeReconciled = useCallback((notice: EmergencyNoticeCandidate) => {
    const profile = profiles.find(candidate => candidate.id === notice.profileId)
    if (!profile) return false
    const savedIdentity = profile.serverIdentity ?? null
    return savedIdentity === notice.serverIdentity || notice.serverIdentity === null
  }, [profiles])

  useEffect(() => {
    const candidatesByKey = new Map(candidates.map(candidate => [candidate.key, candidate]))
    const unseen = candidates.filter(candidate => !seenKeys.current.has(candidate.key))
    for (const candidate of unseen) seenKeys.current.add(candidate.key)
    setNotices(current => {
      let next = current
        .map(notice => {
          const candidate = candidatesByKey.get(notice.key)
          return candidate && (candidate.serverIdentity === notice.serverIdentity || notice.serverIdentity === null)
            ? candidate
            : notice
        })
        .filter(routeCanBeReconciled)
      if (activeProfileId && !switchingProfileId) {
        const currentChatKey = next[0]?.chatKey
        const activeKeys = new Set(candidates.map(candidate => candidate.key))
        next = next.filter(notice => notice.scopeKey !== scopeKey || activeKeys.has(notice.key))

        if (unseen.length > 0) {
          const replacedChats = new Set(unseen.map(candidate => candidate.chatKey))
          const replacesCurrent = Boolean(currentChatKey && replacedChats.has(currentChatKey))
          next = next.filter(notice => !replacedChats.has(notice.chatKey))
          next = replacesCurrent || next.length === 0
            ? [...unseen, ...next]
            : [next[0], ...unseen, ...next.slice(1)]
        }
      }
      return sameEmergencyNoticeQueue(current, next) ? current : next
    })
  }, [activeProfileId, candidates, routeCanBeReconciled, scopeKey, switchingProfileId])

  const notice = notices.find(validRoute) ?? null
  const dismiss = useCallback((key: string) => {
    setNotices(current => current.filter(candidate => candidate.key !== key))
    setOpeningKey(current => current === key ? null : current)
  }, [])
  useEffect(() => {
    if (!notice || openingKey) return
    const timer = window.setTimeout(() => dismiss(notice.key), EMERGENCY_NOTICE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [dismiss, notice, openingKey])
  if (!notice) return null
  const remaining = notices.filter(candidate => candidate.key !== notice.key && validRoute(candidate)).length
  const openChat = async () => {
    if (openingKey) return
    const target = notice
    setOpeningKey(target.key)
    try {
      const opened = await useAppStore.getState().openNotificationRoute({
        profileId: target.profileId,
        serverIdentity: target.serverIdentity,
        sessionId: target.sessionId
      })
      if (opened) dismiss(target.key)
    } catch (error) {
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    } finally {
      setOpeningKey(current => current === target.key ? null : current)
    }
  }
  const opening = Boolean(openingKey)
  return <aside className="emergency-toast" role="alert" aria-live="assertive" aria-busy={opening} data-alert-id={notice.alertId}>
    <Siren size={17} aria-hidden="true" />
    <div>
      <strong>Emergency in {notice.sessionTitle}</strong>
      <span>{notice.message}</span>
      {remaining > 0 && <small>{remaining} more emergency {remaining === 1 ? 'alert' : 'alerts'} waiting</small>}
    </div>
    <button type="button" className="primary-button" disabled={opening} onClick={() => void openChat()}>
      {opening ? <><LoaderCircle className="spin" size={13} /> Opening</> : t("ui.App.EmergencyNotice.open_chat_0600175")}
    </button>
    <button
      type="button"
      className="icon-button"
      aria-label={t("ui.App.EmergencyNotice.dismiss_emergency_notification_for_7c8b815", { "chat": String(notice.sessionTitle) })}
      title={t("ui.App.EmergencyNotice.dismiss_notification_the_emergency_stays_a_28f6eaf")}
      onClick={() => dismiss(notice.key)}
    ><X size={14} /></button>
  </aside>
}

function sameEmergencyNoticeQueue(left: EmergencyNoticeCandidate[], right: EmergencyNoticeCandidate[]): boolean {
  return left.length === right.length && left.every((candidate, index) => {
    const other = right[index]
    return candidate.key === other?.key
      && candidate.serverIdentity === other.serverIdentity
      && candidate.sessionTitle === other.sessionTitle
      && candidate.message === other.message
      && candidate.raisedAt === other.raisedAt
  })
}

function UpdateNotice() {
  useLocale()
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.agentsDock.updates.status().then(status => { if (active) setUpdate(status) })
    const unsubscribe = window.agentsDock.events.on('app:update', status => {
      setUpdate(status)
      if (status.state === 'downloaded') setDismissedVersion(current => current === status.availableVersion ? current : null)
    })
    return () => { active = false; unsubscribe() }
  }, [])

  if (!update || update.channel !== 'direct' || update.state !== 'downloaded' || dismissedVersion === update.availableVersion) return null
  return <aside className="update-toast" role="status" aria-live="polite">
    <RotateCcw size={17} />
    <div><strong>AgentsDock {update.availableVersion} is ready</strong><span>{t("ui.App.UpdateNotice.your_chats_stay_on_the_server_restart_when_de808de")}</span></div>
    <button type="button" className="primary-button" onClick={() => void window.agentsDock.updates.install()}>{t("ui.App.UpdateNotice.restart_6b983a8")}</button>
    <button type="button" className="icon-button" aria-label={t("ui.App.UpdateNotice.later_73b6e48")} title={t("ui.App.UpdateNotice.later_73b6e48")} onClick={() => setDismissedVersion(update.availableVersion ?? '')}><X size={14} /></button>
  </aside>
}
