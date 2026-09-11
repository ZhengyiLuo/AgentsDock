// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Switch from '@radix-ui/react-switch'
import { AlertTriangle, LoaderCircle, Network, RefreshCw, RotateCw, Server, X } from 'lucide-react'
import type {
  ClaudeMcpControlAction,
  ClaudeMcpControlInput,
  ClaudeMcpServer,
  ClaudeMcpSnapshot,
  InteractiveProviderCapability,
  Session
} from '@shared/types'
import { useAppStore } from '../store/app-store'

export const CLAUDE_MCP_CAPABILITY_VERSION = 3

export function claudeMcpCapabilityAdvertised(capability?: InteractiveProviderCapability | null): boolean {
  return Boolean(
    capability
    && (capability.version ?? 0) >= CLAUDE_MCP_CAPABILITY_VERSION
    && capability.features?.mcp_management === true
  )
}

export function claudeMcpCapabilitySupported(capability?: InteractiveProviderCapability | null): boolean {
  return capability?.available === true && claudeMcpCapabilityAdvertised(capability)
}

export function ClaudeMcpDialog({
  open,
  session,
  running,
  supported,
  onOpenChange
}: {
  open: boolean
  session: Session
  running: boolean
  supported: boolean
  onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const scopeKey = JSON.stringify([activeProfileId, profileGeneration, session.id, open])
  const [scopedSnapshot, setScopedSnapshot] = useState<{ scopeKey: string; value: ClaudeMcpSnapshot } | null>(null)
  const snapshot = scopedSnapshot?.scopeKey === scopeKey ? scopedSnapshot.value : null
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mutating, setMutating] = useState<string | null>(null)
  const [scopedLoadError, setScopedLoadError] = useState<{ scopeKey: string; value: string } | null>(null)
  const loadError = scopedLoadError?.scopeKey === scopeKey ? scopedLoadError.value : null
  const [scopedMutationError, setScopedMutationError] = useState<{ scopeKey: string; value: string } | null>(null)
  const mutationError = scopedMutationError?.scopeKey === scopeKey ? scopedMutationError.value : null
  const requestEpoch = useRef(0)
  const scopeKeyRef = useRef(scopeKey)
  const runningRef = useRef(running)
  scopeKeyRef.current = scopeKey
  const bridgeAvailable = typeof window.agentsDock.claude?.mcp === 'function'
    && typeof window.agentsDock.claude?.controlMcp === 'function'
  const profileReady = switchingProfileId == null
  const canRead = supported && bridgeAvailable && profileReady

  const requestIsCurrent = useCallback((
    epoch: number,
    expectedScopeKey: string,
    expectedProfileId: string | null,
    expectedProfileGeneration: number,
    expectedSessionId: string
  ) => {
    const current = useAppStore.getState()
    return epoch === requestEpoch.current
      && scopeKeyRef.current === expectedScopeKey
      && current.activeProfileId === expectedProfileId
      && current.profileGeneration === expectedProfileGeneration
      && current.switchingProfileId == null
      && expectedSessionId === session.id
  }, [session.id])

  const readSnapshot = useCallback(async (refresh = false, preserveMutationError = false) => {
    const read = window.agentsDock.claude?.mcp
    if (!canRead || running || typeof read !== 'function') return null
    const liveScope = useAppStore.getState()
    if (
      liveScope.switchingProfileId
      || liveScope.activeProfileId !== activeProfileId
      || liveScope.profileGeneration !== profileGeneration
    ) return null
    const epoch = ++requestEpoch.current
    const expectedScopeKey = scopeKey
    const expectedProfileId = activeProfileId
    const expectedProfileGeneration = profileGeneration
    const expectedSessionId = session.id
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setScopedLoadError(null)
    if (!preserveMutationError) setScopedMutationError(null)
    try {
      const next = await read(session.id)
      if (!requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) return null
      setScopedSnapshot({ scopeKey: expectedScopeKey, value: next })
      return next
    } catch (cause) {
      if (!requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) return null
      if (activeTurnError(cause)) {
        setScopedLoadError({ scopeKey: expectedScopeKey, value: 'Wait for the active Claude turn to finish before viewing MCP servers for this chat.' })
      } else if (oldServerError(cause)) {
        setScopedSnapshot(null)
        setScopedLoadError({ scopeKey: expectedScopeKey, value: 'This AgentsServer is too old to manage Claude MCP servers. Update the server and try again.' })
      } else {
        setScopedLoadError({ scopeKey: expectedScopeKey, value: 'Unable to load MCP servers. Check the server connection and try again.' })
      }
      return null
    } finally {
      if (requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [activeProfileId, canRead, profileGeneration, requestIsCurrent, running, scopeKey, session.id])

  useEffect(() => {
    requestEpoch.current += 1
    setScopedSnapshot(null)
    setScopedLoadError(null)
    setScopedMutationError(null)
    setLoading(false)
    setRefreshing(false)
    setMutating(null)
    runningRef.current = running
    return () => { requestEpoch.current += 1 }
  }, [activeProfileId, open, profileGeneration, session.id, supported, switchingProfileId])

  useEffect(() => {
    const turnFinished = runningRef.current && !running
    runningRef.current = running
    if (!open || !canRead || running || loading || (!turnFinished && (snapshot || loadError))) return
    void readSnapshot(Boolean(snapshot))
  }, [canRead, loadError, loading, open, readSnapshot, running, snapshot])

  const control = async (action: ClaudeMcpControlAction, serverName: string | null) => {
    const generation = snapshot?.generation
    const mutate = window.agentsDock.claude?.controlMcp
    if (!canRead || !snapshot?.available || !generation || running || mutating || typeof mutate !== 'function') return
    const liveScope = useAppStore.getState()
    if (
      liveScope.switchingProfileId
      || liveScope.activeProfileId !== activeProfileId
      || liveScope.profileGeneration !== profileGeneration
    ) return
    const input: ClaudeMcpControlInput = action === 'reconnect_all'
      ? { version: 1, action, server_name: null, expected_generation: generation }
      : { version: 1, action, server_name: serverName!, expected_generation: generation }
    const epoch = ++requestEpoch.current
    const expectedScopeKey = scopeKey
    const expectedProfileId = activeProfileId
    const expectedProfileGeneration = profileGeneration
    const expectedSessionId = session.id
    setMutating(action === 'reconnect_all' ? 'all' : serverName)
    setScopedMutationError(null)
    try {
      const next = await mutate(session.id, input)
      if (requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) {
        setScopedSnapshot({ scopeKey: expectedScopeKey, value: next })
      }
    } catch (cause) {
      if (!requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) return
      setScopedMutationError({ scopeKey: expectedScopeKey, value: mcpMutationError(cause) })
      setMutating(null)
      // Mutations are generation-fenced. Always refresh after a rejection, but
      // never retry the user's action against a newer runtime automatically.
      await readSnapshot(true, true)
    } finally {
      if (requestIsCurrent(epoch, expectedScopeKey, expectedProfileId, expectedProfileGeneration, expectedSessionId)) setMutating(null)
    }
  }

  const reconnectable = snapshot?.servers.some(server => (
    server.enabled && (server.status === 'failed' || server.status === 'needs-auth')
  )) ?? false
  const controlsDisabled = !profileReady || running || mutating !== null || snapshot?.generation == null

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog claude-mcp-dialog" aria-busy={loading || refreshing || mutating !== null}>
        <header>
          <span className="claude-mcp-heading-icon" aria-hidden="true"><Network size={18} /></span>
          <div>
            <Dialog.Title>{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.claude_mcp_servers_ffe29ca")}</Dialog.Title>
            <Dialog.Description>{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.view_mcp_connections_for_the_current_claud_e9d9fe0")}</Dialog.Description>
          </div>
          <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.close_claude_mcp_servers_8f571ac")}><X size={16} /></button></Dialog.Close>
        </header>
        <div className="claude-mcp-body">
          {!supported && <McpNotice
            tone="warning"
            title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.update_agentsserver_73ee81f")}
            message="This server does not support native Claude MCP management yet. Update AgentsServer to use /mcp here."
          />}

          {supported && !bridgeAvailable && <McpNotice
            tone="warning"
            title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.update_agentsdock_e76b279")}
            message="This AgentsDock build does not include Claude MCP controls. Update the desktop app and try again."
          />}

          {supported && bridgeAvailable && !profileReady && <McpNotice
            tone="warning"
            title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.switching_agentsserver_1e200d9")}
            message="MCP status and controls will load after the server switch finishes."
          />}

          {canRead && running && !snapshot && <McpNotice
            tone="warning"
            title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.claude_turn_in_progress_8c7f27d")}
            message="Wait for the active Claude turn to finish before viewing or changing MCP servers for this chat."
          />}

          {canRead && !running && loading && !snapshot && <div className="claude-mcp-loading" role="status">
            <LoaderCircle className="spin" size={17} aria-hidden="true" />{" "}{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.connecting_to_this_chat_s_claude_mcp_runti_c47b952")}</div>}

          {canRead && !running && loadError && <McpNotice
            tone="error"
            title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.mcp_status_unavailable_a74d3d1")}
            message={loadError}
            alert
            action={<button type="button" className="quiet-button" disabled={loading} onClick={() => void readSnapshot()}>{loading ? 'Retrying…' : 'Retry'}</button>}
          />}

          {canRead && snapshot && !snapshot.available && <McpNotice
            tone="warning"
            title={snapshot.transport === 'print' ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.claude_is_using_print_mode_3ca909f") : t("ui.ClaudeMcpDialog.ClaudeMcpDialog.mcp_management_unavailable_8be5079")}
            message={snapshot.reason?.message || (snapshot.transport === 'print'
              ? 'Native MCP controls require the Claude Agent SDK transport for this chat.'
              : 'Claude MCP management is not available for this chat right now.')}
            action={snapshot.reason?.retryable
              ? <button type="button" className="quiet-button" disabled={refreshing} onClick={() => void readSnapshot(true)}>{refreshing ? 'Checking…' : 'Try again'}</button>
              : undefined}
          />}

          {canRead && snapshot?.available && <>
            <div className="claude-mcp-toolbar">
              <div>
                <strong>{snapshot.servers.length} MCP {snapshot.servers.length === 1 ? 'server' : 'servers'}</strong>
                <small>{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.enable_and_disable_changes_last_only_while_1d0b02a")}</small>
              </div>
              <button
                type="button"
                className="quiet-button"
                disabled={controlsDisabled || !reconnectable}
                title={running ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.wait_for_the_active_claude_turn_to_finish_76b639d") : reconnectable ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.reconnect_failed_or_unauthenticated_mcp_se_4caa765") : t("ui.ClaudeMcpDialog.ClaudeMcpDialog.no_mcp_servers_need_reconnecting_e7f4e31")}
                onClick={() => void control('reconnect_all', null)}
              >
                {mutating === 'all' ? <LoaderCircle className="spin" size={13} /> : <RotateCw size={13} />}{" "}{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.reconnect_bf8a9ea")}</button>
              <button type="button" className="icon-button" aria-label={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.refresh_claude_mcp_servers_d002420")} title={running ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.wait_for_the_active_claude_turn_to_finish_76b639d") : t("ui.ClaudeMcpDialog.ClaudeMcpDialog.refresh_0e91610")} disabled={running || refreshing || mutating !== null} onClick={() => void readSnapshot(true)}>
                <RefreshCw className={refreshing ? 'spin' : undefined} size={14} />
              </button>
            </div>

            {snapshot.truncated && <McpNotice
              tone="warning"
              title={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.some_mcp_servers_are_not_shown_133f6cd")}
              message="This server has more MCP servers than AgentsDock can show. Open Terminal on the AgentsServer host, run claude, then enter /mcp to view and manage the complete list."
            />}

            {running && <p className="claude-mcp-turn-note" role="status">{t("ui.ClaudeMcpDialog.ClaudeMcpDialog.this_status_may_be_out_of_date_wait_for_th_ef8b81e")}</p>}
            {mutationError && <p className="claude-mcp-action-error" role="alert">{mutationError}</p>}
            {snapshot.action && !mutationError && <p className="claude-mcp-action-success" role="status">{mcpActionMessage(snapshot.action)}</p>}

            {snapshot.servers.length === 0
              ? <div className="claude-mcp-empty"><Server size={18} aria-hidden="true" /><strong>{snapshot.truncated ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.no_displayable_mcp_servers_51c5252") : t("ui.ClaudeMcpDialog.ClaudeMcpDialog.no_mcp_servers_configured_013e6b9")}</strong><small>{snapshot.truncated ? t("ui.ClaudeMcpDialog.ClaudeMcpDialog.use_claude_code_in_terminal_on_the_agentss_6186ce7") : t("ui.ClaudeMcpDialog.ClaudeMcpDialog.configure_an_mcp_server_for_claude_then_re_9de4186")}</small></div>
              : <div className="claude-mcp-list" aria-label={t("ui.ClaudeMcpDialog.ClaudeMcpDialog.mcp_servers_22a7559")}>
                {snapshot.servers.map((server, index) => <ClaudeMcpServerRow
                  key={`${server.name}:${index}`}
                  server={server}
                  index={index}
                  disabled={controlsDisabled}
                  mutating={mutating === server.name}
                  onEnabledChange={enabled => void control(enabled ? 'enable' : 'disable', server.name)}
                  onReconnect={() => void control('reconnect', server.name)}
                />)}
              </div>}
          </>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function ClaudeMcpServerRow({
  server,
  index,
  disabled,
  mutating,
  onEnabledChange,
  onReconnect
}: {
  server: ClaudeMcpServer
  index: number
  disabled: boolean
  mutating: boolean
  onEnabledChange: (enabled: boolean) => void
  onReconnect: () => void
}) {
  useLocale()
  const statusLabel = mcpStatusLabel(server)
  const detail = [scopeLabel(server.scope), toolCountLabel(server.tool_count)].filter(Boolean).join(' · ')
  const reconnectDisabled = disabled || mutating || !server.enabled || server.status === 'pending'
  const statusId = `claude-mcp-${safeDomId(server.name)}-${index}-status`

  return <article className={`claude-mcp-row status-${server.status}${server.enabled ? '' : ' disabled'}`}>
    <span className="claude-mcp-status-dot" aria-hidden="true" />
    <div className="claude-mcp-server-copy">
      <strong>{server.name}</strong>
      <span id={statusId} className="claude-mcp-status-label">{statusLabel}</span>
      {detail && <small>{detail}</small>}
      {server.error && <small className="claude-mcp-server-error">{server.error}</small>}
      {server.status === 'needs-auth' && <small className="claude-mcp-auth-help">{t("ui.ClaudeMcpDialog.ClaudeMcpServerRow.open_terminal_run_claude_then_enter_mcp_to_d4db552")}</small>}
    </div>
    <div className="claude-mcp-row-actions">
      <button
        type="button"
        className="quiet-button claude-mcp-reconnect"
        disabled={reconnectDisabled}
        aria-label={t("ui.ClaudeMcpDialog.ClaudeMcpServerRow.reconnect_cc2b839", { "server": String(server.name) })}
        onClick={onReconnect}
      >
        {mutating ? <LoaderCircle className="spin" size={12} /> : <RotateCw size={12} />}{" "}{t("ui.ClaudeMcpDialog.ClaudeMcpServerRow.reconnect_bf8a9ea")}</button>
      <Switch.Root
        className="settings-switch"
        checked={server.enabled}
        disabled={disabled || mutating}
        aria-label={`${server.enabled ? 'Disable' : 'Enable'} ${server.name} for this Claude chat`}
        aria-describedby={statusId}
        onCheckedChange={onEnabledChange}
      >
        <Switch.Thumb className="settings-switch-thumb" />
      </Switch.Root>
    </div>
  </article>
}

function McpNotice({
  tone,
  title,
  message,
  action,
  alert = false
}: {
  tone: 'warning' | 'error'
  title: string
  message: string
  action?: ReactNode
  alert?: boolean
}) {
  useLocale()
  return <div className={`claude-mcp-notice ${tone}`} role={alert ? 'alert' : 'status'}>
    <AlertTriangle size={18} aria-hidden="true" />
    <div><strong>{title}</strong><small>{safeDisplayMessage(message)}</small></div>
    {action}
  </div>
}

function mcpStatusLabel(server: ClaudeMcpServer): string {
  if (!server.enabled || server.status === 'disabled') return 'Disabled'
  switch (server.status) {
    case 'connected': return t("ui.ClaudeMcpDialog.mcpStatusLabel.connected_2296556")
    case 'pending': return t("ui.ClaudeMcpDialog.mcpStatusLabel.connecting_d403c68")
    case 'failed': return t("ui.ClaudeMcpDialog.mcpStatusLabel.connection_failed_596c52f")
    case 'needs-auth': return t("ui.ClaudeMcpDialog.mcpStatusLabel.authentication_required_0fcfb12")
    case 'unknown': return t("ui.ClaudeMcpDialog.mcpStatusLabel.status_unknown_e412d87")
  }
}

function scopeLabel(scope: ClaudeMcpServer['scope']): string | null {
  switch (scope) {
    case 'user': return t("ui.ClaudeMcpDialog.scopeLabel.user_scope_15a9f15")
    case 'project': return t("ui.ClaudeMcpDialog.scopeLabel.project_scope_64a01bd")
    case 'local': return t("ui.ClaudeMcpDialog.scopeLabel.local_scope_3c8d70d")
    case 'claudeai': return t("ui.ClaudeMcpDialog.scopeLabel.claude_ai_scope_52d47b5")
    case 'managed': return t("ui.ClaudeMcpDialog.scopeLabel.managed_scope_3cdbcdf")
    default: return null
  }
}

function mcpActionMessage(action: NonNullable<ClaudeMcpSnapshot['action']>): string {
  if (action.type === 'reconnect_all') return t("ui.ClaudeMcpDialog.mcpActionMessage.reconnect_requested_for_mcp_servers_that_n_7f49c9a")
  const name = action.server_name || 'MCP server'
  if (action.type === 'enable') return t("ui.ClaudeMcpDialog.mcpActionMessage.enabled_while_this_claude_session_remains__b43d345", { "server": String(name) })
  if (action.type === 'disable') return t("ui.ClaudeMcpDialog.mcpActionMessage.disabled_while_this_claude_session_remains_a42495c", { "server": String(name) })
  return t("ui.ClaudeMcpDialog.mcpActionMessage.reconnected_a618f1d", { "server": String(name) })
}

function toolCountLabel(count: number | null): string | null {
  if (count == null || !Number.isFinite(count) || count < 0) return null
  return `${count} ${count === 1 ? 'tool' : 'tools'}`
}

function safeDomId(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-').slice(0, 80) || 'server'
}

function safeDisplayMessage(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').slice(0, 400)
}

function oldServerError(cause: unknown): boolean {
  return /(?:\b404\b|\b405\b|\b501\b|not found|method not allowed|not implemented)/iu.test(errorMessage(cause))
}

function activeTurnError(cause: unknown): boolean {
  return /(?:active Claude turn|claude_mcp_turn_active)/iu.test(errorMessage(cause))
}

function mcpMutationError(cause: unknown): string {
  const message = errorMessage(cause)
  if (/active Claude turn|claude_mcp_turn_active/iu.test(message)) {
    return t("ui.ClaudeMcpDialog.mcpMutationError.wait_for_the_active_claude_turn_to_finish__db67cb1")
  }
  if (/generation|status changed|claude_mcp_generation_changed/iu.test(message)) {
    return t("ui.ClaudeMcpDialog.mcpMutationError.mcp_status_changed_while_this_panel_was_op_04364b0")
  }
  if (/not found|claude_mcp_server_not_found/iu.test(message)) {
    return t("ui.ClaudeMcpDialog.mcpMutationError.that_mcp_server_is_no_longer_available_the_b080768")
  }
  return t("ui.ClaudeMcpDialog.mcpMutationError.claude_could_not_apply_that_mcp_change_rev_7009a5e")
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
