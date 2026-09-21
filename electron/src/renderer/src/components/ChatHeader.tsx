// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Archive, ArchiveRestore, ArrowLeftRight, Check, ChevronRight, Columns2, Copy, Folder, GitFork, LoaderCircle, MoreHorizontal, PanelLeft, PanelRight, PanelRightClose, Pin, RefreshCw, SquareTerminal, Trash2, X } from 'lucide-react'
import type { Session } from '@shared/types'
import { completedPrefixForkAvailable } from '@shared/session-fork'
import { backendLabel, shortId } from '../lib/format'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { ShortcutTooltip } from './ShortcutTooltip'
import { CodexStatusButton } from './CodexControls'
import { useCodexRuntime } from './CodexRuntimeContext'
import { ScheduledJobsPopover } from './ScheduledJobsPopover'

export function ChatHeader({
  session: sessionProp,
  focused = true,
  sidebarVisible = true,
  terminalOpen = false,
  onSidebarToggle,
  onTerminalToggle,
  onOpenSplit,
  onSwapPanes,
  onClosePane
}: {
  session?: Session | null
  focused?: boolean
  sidebarVisible?: boolean
  terminalOpen?: boolean
  onSidebarToggle?: () => void
  onTerminalToggle?: () => void
  onOpenSplit?: (sessionId: string) => void
  onSwapPanes?: () => void
  onClosePane?: () => void
}) {
  useLocale()
  const selectedSession = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const session = sessionProp === undefined ? selectedSession : sessionProp
  const inspector = useAppStore(state => state.inspectorVisible)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const chatPanes = useAppStore(state => state.chatPanes)
  const running = useAppStore(state => (session ? state.activeSessionIds.has(session.id) : false))
  const admitting = useAppStore(state => (session ? Boolean(state.turnAdmissionTokens[session.id]) : false))
  const codexControlsSupported = useCodexRuntime().supported
  const liveForkSupported = useAppStore(state => completedPrefixForkAvailable(state.health, session?.backend))
  const forkBlocked = (running || admitting) && !liveForkSupported
  const currentFolder = session?.folder?.trim() || 'General'
  const splitCandidates = useMemo(
    () => sessions.filter(candidate => (
      !candidate.archived
      && candidate.id !== session?.id
      && candidate.id !== chatPanes.primary
      && candidate.id !== chatPanes.secondary
    )).slice(0, 30),
    [chatPanes.primary, chatPanes.secondary, session?.id, sessions]
  )
  const folders = useMemo(() => {
    const order = new Map(folderOrder.map((folder, index) => [folder, index]))
    return [...new Set([
      ...folderOrder,
      ...sessions.filter(candidate => !candidate.archived && !candidate.pinned).map(candidate => candidate.folder?.trim() || 'General'),
      currentFolder
    ])].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
  }, [currentFolder, folderOrder, sessions])
  const [title, setTitle] = useState(session?.title ?? '')
  const [sessionIdCopied, setSessionIdCopied] = useState(false)
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
  const [splitMenuRequested, setSplitMenuRequested] = useState(false)
  useTransientClose(actionsMenuOpen, () => {
    setActionsMenuOpen(false)
    setSplitMenuRequested(false)
  })
  useEffect(() => setTitle(session?.title ?? ''), [session?.id, session?.title])
  useEffect(() => {
    setActionsMenuOpen(false)
    setSplitMenuRequested(false)
    setSessionIdCopied(false)
  }, [session?.id, profileId, profileGeneration])
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail
      if (!onOpenSplit || !session || detail?.sessionId !== session.id) return
      setSplitMenuRequested(true)
      setActionsMenuOpen(true)
    }
    window.addEventListener('agentsdock:open-split-chat-menu', open)
    return () => window.removeEventListener('agentsdock:open-split-chat-menu', open)
  }, [onOpenSplit, session?.id])
  const sidebarButton = !sidebarVisible && onSidebarToggle
    ? <ShortcutTooltip shortcut="toggleSidebar" label={t('ui.sidebar.showChatList')}><button className="icon-button" aria-label={t('ui.sidebar.showChatList')} onClick={onSidebarToggle}><PanelLeft size={16} /></button></ShortcutTooltip>
    : null
  if (!session) return <header className="chat-header empty"><strong>AgentsDock</strong><div className="header-actions">{sidebarButton}</div></header>
  const save = () => { const clean = title.trim(); if (clean && clean !== session.title) void useAppStore.getState().updateSession(session.id, { title: clean }) }
  const sessionIdValue = session.session_id || session.codex_thread_id || session.claude_session_id || session.cursor_session_id
  const copySessionId = () => {
    if (!sessionIdValue) return
    void window.agentsDock.native.writeClipboard(sessionIdValue).then(() => {
      setSessionIdCopied(true)
      window.setTimeout(() => setSessionIdCopied(false), 1200)
    }).catch(() => undefined)
  }
  return (
    <header className={`chat-header${focused ? ' focused' : ''}`}>
      <div className="title-block">
        <div className="editable-title">
          <input
            aria-label={t("ui.ChatHeader.ChatHeader.rename_e84e258", { "name": String(session.title) })}
            value={title}
            size={Math.max(1, Array.from(title).length)}
            onChange={event => setTitle(event.target.value)}
            onBlur={save}
            onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); save() } }}
          />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="chat-folder-label" title={t("ui.ChatHeader.ChatHeader.move_chat_to_folder_currently_b505564", { "folder": String(currentFolder) })} aria-label={t("ui.ChatHeader.ChatHeader.folder_4e7d7bc", { "folder": String(currentFolder) })}>
                <Folder size={12} aria-hidden="true" /><span>{currentFolder}</span>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="menu-content chat-folder-menu" side="bottom" align="start" sideOffset={6} collisionPadding={12}>
                <DropdownMenu.Label className="menu-label">{t("ui.ChatHeader.ChatHeader.move_to_folder_91d631e")}</DropdownMenu.Label>
                {folders.map(folder => {
                  const selected = folder === currentFolder
                  return <DropdownMenu.CheckboxItem
                    className="menu-item"
                    key={folder}
                    checked={selected}
                    onSelect={() => {
                      if (!selected) void useAppStore.getState().updateSession(session.id, { folder, archived: false })
                    }}
                  ><span className="chat-folder-menu-check" aria-hidden="true">{selected && <Check size={14} />}</span><span>{folder}</span></DropdownMenu.CheckboxItem>
                })}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
        <small>session {shortId(sessionIdValue)}{sessionIdValue && <button type="button" className="session-id-copy" title={sessionIdCopied ? t("ui.ChatHeader.ChatHeader.copied_8d525e5") : t("ui.ChatHeader.ChatHeader.copy_session_8b985e2")} aria-label={sessionIdCopied ? t("ui.ChatHeader.ChatHeader.session_copied_673328f") : t("ui.ChatHeader.ChatHeader.copy_session_8b985e2")} onClick={copySessionId}>{sessionIdCopied ? <Check size={12} /> : <Copy size={12} />}</button>}</small>
      </div>
      <div className="header-actions">
        <DropdownMenu.Root open={actionsMenuOpen} onOpenChange={open => {
          setActionsMenuOpen(open)
          if (!open) setSplitMenuRequested(false)
        }}><DropdownMenu.Trigger asChild><button className="icon-button" title={t("ui.ChatHeader.ChatHeader.chat_actions_8ba35bb")} aria-label={t("ui.ChatHeader.ChatHeader.chat_actions_8ba35bb")}><MoreHorizontal size={16} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item className="menu-item" onSelect={() => useAppStore.getState().setModal('digest', true)}><GitFork size={14} />{t("ui.ChatHeader.ChatHeader.create_digest_8b04e01")}</DropdownMenu.Item>
          {splitMenuRequested && onOpenSplit && <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="menu-item split-chat-menu-trigger"><Columns2 size={14} />{t("ui.ChatHeader.ChatHeader.open_split_view_51e50f7")}<ChevronRight size={13} /></DropdownMenu.SubTrigger>
            <DropdownMenu.Portal><DropdownMenu.SubContent className="menu-content split-chat-menu" sideOffset={6} collisionPadding={12}>
              <DropdownMenu.Label className="menu-label">{t("ui.ChatHeader.ChatHeader.open_beside_e35adb0")}{" "}{session.title}</DropdownMenu.Label>
              {splitCandidates.length
                ? splitCandidates.map(candidate => <DropdownMenu.Item className="menu-item split-chat-menu-item" key={candidate.id} onSelect={() => onOpenSplit(candidate.id)}><span>{candidate.title}</span><small>{backendLabel(candidate.backend)}</small></DropdownMenu.Item>)
                : <DropdownMenu.Label className="menu-label">{t("ui.ChatHeader.ChatHeader.no_other_active_chats_40889ab")}</DropdownMenu.Label>}
            </DropdownMenu.SubContent></DropdownMenu.Portal>
          </DropdownMenu.Sub>}
          <DropdownMenu.Item className="menu-item" disabled={forkBlocked} title={forkBlocked ? t('sessionFork.runningUnavailable') : running || admitting ? t('sessionFork.runningDescription') : undefined} onSelect={() => void useAppStore.getState().forkSession(session.id)}><GitFork size={14} />{t("ui.ChatHeader.ChatHeader.fork_chat_dfbcbb3")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void useAppStore.getState().updateSession(session.id, { pinned: !session.pinned })}><Pin size={14} fill={session.pinned ? 'currentColor' : 'none'} />{session.pinned ? t("ui.ChatHeader.ChatHeader.unpin_chat_1944e0e") : t("ui.ChatHeader.ChatHeader.pin_chat_a754adf")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void useAppStore.getState().importHistory(session.id)}><RefreshCw size={14} />{t("ui.ChatHeader.ChatHeader.refresh_provider_history_9d88960")}</DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={() => void useAppStore.getState().updateSession(session.id, { archived: !session.archived })}>{session.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}{session.archived ? t("ui.ChatHeader.ChatHeader.unarchive_chat_54953a7") : t("ui.ChatHeader.ChatHeader.archive_chat_9bd687c")}</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item danger" onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-delete', { detail: session }))}><Trash2 size={14} />{t("ui.ChatHeader.ChatHeader.delete_chat_93291d9")}</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        {sidebarButton}
        <ScheduledJobsPopover session={session} />
        {onSwapPanes && <button className="icon-button" title={t("ui.ChatHeader.ChatHeader.swap_chat_panes_7129f59")} aria-label={t("ui.ChatHeader.ChatHeader.swap_chat_panes_7129f59")} onClick={onSwapPanes}><ArrowLeftRight size={15} /></button>}
        {focused && onTerminalToggle && <ShortcutTooltip shortcut="toggleTerminal" label={terminalOpen ? t("ui.ChatHeader.ChatHeader.close_terminal_panel_48e963f") : t("ui.ChatHeader.ChatHeader.open_terminal_panel_3284242")}><button
          className={`icon-button terminal-toggle${terminalOpen ? ' active' : ''}`}
          aria-label={terminalOpen ? t("ui.ChatHeader.ChatHeader.close_terminal_panel_48e963f") : t("ui.ChatHeader.ChatHeader.open_terminal_panel_3284242")}
          aria-pressed={terminalOpen}
          onClick={onTerminalToggle}
        ><SquareTerminal size={16} /></button></ShortcutTooltip>}
        <CodexStatusButton />
        {(running || admitting) && (
          session.backend === 'claude'
          || (session.backend === 'codex' && !codexControlsSupported)
        ) && <AgentRunningStatus backend={session.backend} />}
        <ChatSyncStatus sessionId={session.id} />
        {focused && <ShortcutTooltip shortcut="toggleInspector" label={`${inspector ? t("ui.ChatHeader.ChatHeader.hide_ac20a57") : 'Show'} right panel`}><button className="icon-button inspector-toggle" aria-label={`${inspector ? t("ui.ChatHeader.ChatHeader.hide_ac20a57") : 'Show'} right panel`} onClick={() => useAppStore.getState().setInspectorVisible(!inspector)}>{inspector ? <PanelRightClose size={16} /> : <PanelRight size={16} />}</button></ShortcutTooltip>}
        {onClosePane && <button className="icon-button" title={t("ui.ChatHeader.ChatHeader.close_this_chat_pane_4926598")} aria-label={t("ui.ChatHeader.ChatHeader.close_pane_fe2672f", { "title": String(session.title) })} onClick={onClosePane}><X size={15} /></button>}
      </div>
    </header>
  )
}

function AgentRunningStatus({ backend }: { backend: 'claude' | 'codex' }) {
  const provider = backendLabel(backend)
  const status = t('timeline.status.running')
  return <span className="codex-status-button active agent-running-status" role="status" aria-label={`${provider} ${status}`} title={`${provider} ${status}`}>
    <span aria-hidden="true" />
    <b>{provider}</b>
    <small>{status}</small>
  </span>
}

function ChatSyncStatus({ sessionId }: { sessionId: string }) {
  const syncing = useAppStore(state => {
    if (!state.connected) return false
    const status = state.syncBySession[sessionId]?.status
      ?? (state.syncSessionId === sessionId ? state.syncStatus : 'cached')
    return status === 'syncing'
  })
  if (!syncing) return null
  const label = t('ui.ChatHeader.ChatHeader.syncing_8eeb25e')
  return <span className="codex-status-button agent-sync-status" role="status" aria-label={label} title={label}>
    <LoaderCircle className="spin" size={11} aria-hidden="true" />
    <b>{label}</b>
  </span>
}
