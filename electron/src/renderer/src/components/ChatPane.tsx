// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Session } from '@shared/types'
import type { ChatPane as ChatPaneId } from '../lib/chat-panes'
import { nativeFileRefsFromFiles } from '../lib/native-files'
import { useAppStore } from '../store/app-store'
import { ChatHeader } from './ChatHeader'
import { ClaudeInteractionShelf } from './ClaudeInteractionShelf'
import { GeminiInteractionShelf } from './GeminiInteractionShelf'
import { ClaudeRuntimeProvider } from './ClaudeRuntimeContext'
import { CodexInteractionShelf } from './CodexInteractionShelf'
import { CodexRuntimeProvider } from './CodexRuntimeContext'
import { Composer } from './Composer'
import { EmergencyTimelineDock } from './EmergencyTimelineDock'
import { Timeline } from './Timeline'
import { WorkspaceEditor } from './WorkspaceEditor'
import { profileSessionKey } from '../lib/profile-scope'

const AVAILABLE_CODEX_CONTROLS = Object.freeze({ available: true })
const AVAILABLE_CLAUDE_CONTROLS = Object.freeze({
  available: true,
  interactive_client_capability: 'claude_sdk_interactive_v1'
})

export const ChatPane = memo(function ChatPane({
  pane,
  session,
  sideChat,
  focused,
  split,
  sidebarVisible = true,
  terminalOpen,
  onSidebarToggle,
  onTerminalToggle
}: {
  pane: ChatPaneId
  session: Session
  sideChat?: ReactNode
  focused: boolean
  split: boolean
  sidebarVisible?: boolean
  terminalOpen: boolean
  onSidebarToggle?: () => void
  onTerminalToggle?: () => void
}) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const workspaceFilesAvailable = useAppStore(state => state.health === null ? null : state.health.capabilities?.workspace_files?.available === true)
  const workspaceFilesVersion = useAppStore(state => state.health?.capabilities?.workspace_files?.version)
  const workspaceFilesMaxBytes = useAppStore(state => state.health?.capabilities?.workspace_files?.max_text_file_bytes)
  const workspaceFilesMessage = useAppStore(state => {
    const capability = state.health?.capabilities?.workspace_files
    return [capability?.message, capability?.action].filter(Boolean).join(' ')
  })
  const scope = useMemo(() => activeProfileId ? { profileId: activeProfileId, profileGeneration, serverIdentity } : null,
    [activeProfileId, profileGeneration, serverIdentity])
  const codexControlsAvailable = useAppStore(state => state.health?.capabilities?.codex_controls?.available === true)
  const claudeControlsAvailable = useAppStore(state => {
    const capability = state.health?.capabilities?.claude_controls
    return capability?.available === true
      && (capability.interactive_client_capability ?? capability.interactive_capability) === 'claude_sdk_interactive_v1'
  })
  const codexCapability = codexControlsAvailable ? AVAILABLE_CODEX_CONTROLS : null
  const claudeCapability = claudeControlsAvailable ? AVAILABLE_CLAUDE_CONTROLS : null
  const dragTimer = useRef<number | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const focusPane = useCallback(() => useAppStore.getState().focusChatPane(pane), [pane])
  const clearDragTimer = useCallback(() => {
    if (dragTimer.current === null) return
    window.clearTimeout(dragTimer.current)
    dragTimer.current = null
  }, [])
  const resetDrag = useCallback(() => {
    clearDragTimer()
    setDropActive(false)
  }, [clearDragTimer])
  const refreshDrag = useCallback(() => {
    setDropActive(true)
    clearDragTimer()
    dragTimer.current = window.setTimeout(resetDrag, 1_500)
  }, [clearDragTimer, resetDrag])

  useEffect(() => {
    resetDrag()
  }, [activeProfileId, profileGeneration, serverIdentity, session.id, switchingProfileId, resetDrag])

  useEffect(() => {
    const resetOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resetDrag()
    }
    const resetWhenHidden = () => {
      if (document.visibilityState !== 'visible') resetDrag()
    }
    window.addEventListener('dragend', resetDrag, true)
    window.addEventListener('drop', resetDrag, true)
    window.addEventListener('blur', resetDrag)
    window.addEventListener('pointerdown', resetDrag, true)
    window.addEventListener('keydown', resetOnEscape, true)
    document.addEventListener('visibilitychange', resetWhenHidden)
    return () => {
      window.removeEventListener('dragend', resetDrag, true)
      window.removeEventListener('drop', resetDrag, true)
      window.removeEventListener('blur', resetDrag)
      window.removeEventListener('pointerdown', resetDrag, true)
      window.removeEventListener('keydown', resetOnEscape, true)
      document.removeEventListener('visibilitychange', resetWhenHidden)
      clearDragTimer()
    }
  }, [clearDragTimer, resetDrag])

  const hasFiles = (event: ReactDragEvent) => Array.from(event.dataTransfer.types).includes('Files')
  const canDrop = !session.archived && !switchingProfileId
  const onDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDrop || !hasFiles(event)) return
    event.preventDefault()
    focusPane()
    refreshDrag()
  }
  const onDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDrop || !hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    refreshDrag()
  }
  const onDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dropActive) return
    event.preventDefault()
    if (event.target !== event.currentTarget) return
    const destination = event.relatedTarget
    if (destination instanceof Node && event.currentTarget.contains(destination)) return
    resetDrag()
  }
  const onDrop = async (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canDrop || !hasFiles(event)) return
    event.preventDefault()
    focusPane()
    resetDrag()
    try {
      const refs = await nativeFileRefsFromFiles(event.dataTransfer.files)
      const state = useAppStore.getState()
      if (
        refs.length
        && state.activeProfileId === activeProfileId
        && state.profileGeneration === profileGeneration
        && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === serverIdentity
        && Object.values(state.chatPanes).includes(session.id)
        && state.sessions.some(candidate => candidate.id === session.id && !candidate.archived)
        && !state.switchingProfileId
      ) await state.attachPathsForSession(session.id, refs)
    } catch (cause) {
      const state = useAppStore.getState()
      if (
        state.activeProfileId === activeProfileId
        && state.profileGeneration === profileGeneration
        && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === serverIdentity
        && Object.values(state.chatPanes).includes(session.id)
        && state.sessions.some(candidate => candidate.id === session.id && !candidate.archived)
        && !state.switchingProfileId
      ) state.setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const onShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented
      || !(event.metaKey || event.ctrlKey)
      || event.altKey
      || event.shiftKey
      || event.key.toLowerCase() !== 'd'
    ) return
    event.preventDefault()
    event.stopPropagation()
    focusPane()
    useAppStore.getState().setModal('digest', true)
  }

  const conversation = <div className="pane-conversation">
    <ChatHeader
      session={session}
      titleInTab
      focused={focused}
      sidebarVisible={sidebarVisible}
      terminalOpen={terminalOpen}
      onSidebarToggle={pane === 'primary' ? onSidebarToggle : undefined}
      onTerminalToggle={focused ? onTerminalToggle : undefined}
      onOpenSplit={candidateId => void useAppStore.getState().openSessionInSplit(candidateId)}
      onClosePane={split ? () => useAppStore.getState().closeChatPane(pane) : undefined}
    />
    <div
      className="chat-workspace"
      onKeyDown={onShortcut}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="chat-workspace-history">
        <Timeline sessionId={session.id} focused={focused} />
      </div>
      <div className="chat-workspace-shelves">
        <CodexInteractionShelf />
        <ClaudeInteractionShelf />
        <GeminiInteractionShelf session={session} />
      </div>
      <EmergencyTimelineDock sessionId={session.id} focused={focused} />
      <div className="chat-workspace-composer">
        {sideChat}
        {session.archived
          ? <div className="composer disabled"><span>{t("ui.ChatPane.ChatPane.archived_chat_unarchive_it_to_send_a_messa_1b14da3")}</span></div>
          : <Composer sessionId={session.id} dropActive={dropActive} />}
      </div>
    </div>
  </div>

  const paneContent = <WorkspaceEditor
    key={`${session.id}:${session.cwd ?? ''}`}
    workspaceKey={`${profileSessionKey(activeProfileId, session.id, serverIdentity)}:cwd:${session.cwd ?? ''}`}
    session={session}
    profileScope={scope}
    available={workspaceFilesAvailable}
    capabilityVersion={workspaceFilesVersion}
    maxTextFileBytes={workspaceFilesMaxBytes}
    unavailableMessage={workspaceFilesMessage}
    tabbedPane
    paneFocused={focused}
    chatContent={conversation}
  />

  return <section
    className={`chat-pane chat-pane-${pane}${focused ? ' focused' : ''}`}
    aria-label={`${session.title} chat pane${focused ? ', active' : ''}`}
    tabIndex={-1}
    data-chat-pane={pane}
    data-session-id={session.id}
    onPointerDownCapture={focusPane}
    onFocusCapture={focusPane}
  >
    {session.archived
      ? paneContent
      : <ClaudeRuntimeProvider session={session} capability={claudeCapability}>
        <CodexRuntimeProvider session={session} capability={codexCapability} focused={focused}>
          {paneContent}
        </CodexRuntimeProvider>
      </ClaudeRuntimeProvider>}
  </section>
})
