import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  AlertTriangle,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock3,
  Network,
  RefreshCw,
  Server,
  type LucideIcon,
} from 'lucide-react-native'
import { AgentServerClient, ServerError } from '../api/AgentServerClient'
import { claudeMcpManagementCapability } from '../lib/claude-mcp'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette, type Palette } from '../theme'
import type { ClaudeMcpActionType, ClaudeMcpServer, ClaudeMcpSnapshot } from '../types'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

interface ClaudeMcpDialogProps {
  visible: boolean
  sessionId: string | null
  onClose: () => void
}

type RequestKind = 'loading' | 'refreshing' | null

/**
 * App-owned replacement for Claude Code's terminal-only `/mcp` panel. Every
 * request is bound to the client instance, active profile, profile generation,
 * and selected Claude chat that opened it.
 */
export function ClaudeMcpDialog({ visible, sessionId, onClose }: ClaudeMcpDialogProps) {
  const colors = usePalette()
  const connection = client
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const health = useAppStore(state => state.health)
  const session = useAppStore(state => sessionId ? state.sessions.find(candidate => candidate.id === sessionId) ?? null : null)
  const turnActive = useAppStore(state => Boolean(sessionId && state.activeSessionIds.has(sessionId)))
  const capability = claudeMcpManagementCapability(health)
  const connectionReady = Boolean(
    visible
    && sessionId
    && session?.backend === 'claude'
    && activeProfileId
    && connected
    && !connecting
    && !switchingProfileId
    && !workspaceAdopting
    && connection.isValidated,
  )
  const endpointAvailable = capability?.available === true
  const [snapshot, setSnapshot] = useState<ClaudeMcpSnapshot | null>(null)
  const [requestKind, setRequestKind] = useState<RequestKind>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyServer, setBusyServer] = useState<string | null>(null)
  const mounted = useRef(true)
  const visibleRef = useRef(visible)
  const snapshotRef = useRef<ClaudeMcpSnapshot | null>(snapshot)
  const requestEpoch = useRef(0)
  const previousTurnActive = useRef(turnActive)
  const scopeKey = `${activeProfileId ?? ''}:${profileGeneration}:${sessionId ?? ''}`
  const scopeKeyRef = useRef(scopeKey)
  visibleRef.current = visible
  snapshotRef.current = snapshot
  scopeKeyRef.current = scopeKey

  const requestIsCurrent = useCallback((
    request: number,
    expectedConnection: AgentServerClient,
    expectedProfileId: string,
    expectedGeneration: number,
    expectedSessionId: string,
    expectedScopeKey: string,
  ): boolean => mounted.current
    && visibleRef.current
    && request === requestEpoch.current
    && scopeKeyRef.current === expectedScopeKey
    && mcpScopeIsCurrent(expectedConnection, expectedProfileId, expectedGeneration, expectedSessionId), [])

  const load = useCallback(async (preserveActionError = false): Promise<ClaudeMcpSnapshot | null> => {
    if (
      !sessionId
      || !activeProfileId
      || !connectionReady
      || !endpointAvailable
      || useAppStore.getState().activeSessionIds.has(sessionId)
    ) return null
    const expectedConnection = connection
    const expectedProfileId = activeProfileId
    const expectedProfileGeneration = profileGeneration
    const expectedSessionId = sessionId
    const expectedScopeKey = scopeKey
    const request = ++requestEpoch.current
    setRequestKind(snapshotRef.current ? 'refreshing' : 'loading')
    setLoadError(null)
    if (!preserveActionError) setActionError(null)
    try {
      const next = await expectedConnection.claudeMcp(expectedSessionId)
      if (!requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) return null
      assertMcpSnapshot(next)
      snapshotRef.current = next
      setSnapshot(next)
      return next
    } catch (cause) {
      if (!requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) return null
      setLoadError(errorMessage(cause, 'Could not load Claude MCP servers.'))
      return null
    } finally {
      if (requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) setRequestKind(null)
    }
  }, [activeProfileId, connection, connectionReady, endpointAvailable, profileGeneration, requestIsCurrent, scopeKey, sessionId])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestEpoch.current += 1
    }
  }, [])

  useEffect(() => {
    requestEpoch.current += 1
    snapshotRef.current = null
    setSnapshot(null)
    setRequestKind(null)
    setLoadError(null)
    setActionError(null)
    setBusyServer(null)
    if (visible && connectionReady && endpointAvailable) void load()
    // `load` is scoped by the same identity fields. Including it here makes a
    // connection-readiness transition automatically populate an open panel.
  }, [connectionReady, endpointAvailable, load, scopeKey, visible])

  useEffect(() => {
    const wasActive = previousTurnActive.current
    previousTurnActive.current = turnActive
    if (wasActive && !turnActive && visible && connectionReady && endpointAvailable) void load()
  }, [connectionReady, endpointAvailable, load, turnActive, visible])

  const mutate = useCallback(async (action: ClaudeMcpActionType, serverName: string | null) => {
    const current = snapshotRef.current
    if (
      !sessionId
      || !activeProfileId
      || !connectionReady
      || !endpointAvailable
      || busyServer
      || turnActive
      || !current?.available
      || !current.generation?.trim()
    ) return
    const expectedConnection = connection
    const expectedProfileId = activeProfileId
    const expectedProfileGeneration = profileGeneration
    const expectedSessionId = sessionId
    const expectedScopeKey = scopeKey
    const expectedMcpGeneration = current.generation as string
    const request = ++requestEpoch.current
    let refreshSnapshot = false
    setBusyServer(serverName ?? '*')
    setActionError(null)
    setLoadError(null)
    try {
      const next = await expectedConnection.controlClaudeMcp(expectedSessionId, {
        version: 1,
        action,
        server_name: serverName,
        expected_generation: expectedMcpGeneration,
      })
      if (!requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) return
      assertMcpSnapshot(next)
      snapshotRef.current = next
      setSnapshot(next)
    } catch (cause) {
      if (!requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) return
      const code = serverErrorCode(cause)
      refreshSnapshot = code === 'claude_mcp_generation_changed' || code === 'claude_mcp_server_not_found'
      if (code === 'claude_mcp_generation_changed') {
        setActionError('MCP connections changed while this panel was open. Status was refreshed; review it and try again.')
      } else if (code === 'claude_mcp_server_not_found') {
        setActionError('This MCP server is no longer configured. The server list was refreshed; review it and try again.')
      } else {
        setActionError(errorMessage(cause, 'Could not update this MCP server.'))
      }
    } finally {
      if (requestIsCurrent(
        request,
        expectedConnection,
        expectedProfileId,
        expectedProfileGeneration,
        expectedSessionId,
        expectedScopeKey,
      )) {
        setBusyServer(null)
        if (refreshSnapshot) void load(true)
      }
    }
  }, [activeProfileId, busyServer, connection, connectionReady, endpointAvailable, load, profileGeneration, requestIsCurrent, scopeKey, sessionId, turnActive])

  const close = useCallback(() => {
    requestEpoch.current += 1
    setBusyServer(null)
    setRequestKind(null)
    onClose()
    requestAnimationFrame(dismissAppKeyboard)
  }, [onClose])

  const servers = snapshot?.servers ?? []
  const connectedCount = servers.filter(server => server.enabled && server.status === 'connected').length
  const enabledCount = servers.filter(server => server.enabled).length
  const reconnectableCount = servers.filter(server => server.enabled && (server.status === 'failed' || server.status === 'needs-auth')).length
  const initialLoading = requestKind === 'loading'
  const refreshing = requestKind === 'refreshing'
  const actionsDisabled = !connectionReady
    || !endpointAvailable
    || !snapshot?.available
    || snapshot.generation == null
    || busyServer != null
    || turnActive

  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
    allowSwipeDismissal
    onRequestClose={close}
  >
    <SafeAreaView
      testID="claude-mcp-dialog"
      accessibilityViewIsModal
      onAccessibilityEscape={close}
      style={[styles.sheet, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={[styles.headerMark, { backgroundColor: colors.raised }]}><Network size={20} color={colors.blue} /></View>
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Claude MCP servers</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>Current Claude session for this chat</Text>
        </View>
        {endpointAvailable && connectionReady ? <Pressable
          testID="claude-mcp-refresh"
          accessibilityRole="button"
          accessibilityLabel="Refresh Claude MCP server status"
          accessibilityState={{ disabled: initialLoading || refreshing || busyServer != null || turnActive, busy: initialLoading || refreshing }}
          disabled={initialLoading || refreshing || busyServer != null || turnActive}
          onPress={() => void load()}
          style={({ pressed }) => [styles.headerButton, { opacity: initialLoading || refreshing || busyServer != null || turnActive ? 0.35 : pressed ? 0.6 : 1 }]}
        >{initialLoading || refreshing ? <ActivityIndicator size="small" color={colors.blue} /> : <RefreshCw size={18} color={colors.muted} />}</Pressable> : null}
        <SheetCloseButton label="Close Claude MCP servers" testID="claude-mcp-close" onPress={close} />
      </View>

      <ScrollView
        testID="claude-mcp-scroll"
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {!connectionReady ? <StateCard
          icon={CircleX}
          title="Active server unavailable"
          body="Reconnect to the active AgentsServer, then open /mcp again."
          color={colors.orange}
        /> : capability == null ? <StateCard
          icon={AlertTriangle}
          title="MCP management needs a newer AgentsServer"
          body="This server does not advertise Claude MCP management. Update AgentsServer, reconnect, and try /mcp again."
          color={colors.orange}
        /> : !capability.available ? <StateCard
          icon={CircleX}
          title="Claude MCP management unavailable"
          body={capability.message || 'This AgentsServer cannot access native Claude Agent SDK MCP controls right now.'}
          detail={capability.action}
          color={colors.orange}
        /> : turnActive && !snapshot ? <StateCard
          icon={Clock3}
          title="Wait for Claude to finish"
          body="MCP status and controls pause while this Claude turn is active. This panel will load automatically when the turn finishes."
          color={colors.orange}
        /> : initialLoading && !snapshot ? <View accessibilityLiveRegion="polite" style={styles.loading}>
          <ActivityIndicator accessibilityLabel="Loading Claude MCP servers" size="small" color={colors.blue} />
          <Text style={[styles.loadingText, { color: colors.muted }]}>Loading MCP servers…</Text>
        </View> : loadError && !snapshot ? <StateCard
          icon={AlertTriangle}
          title="Couldn’t load MCP servers"
          body={loadError}
          color={colors.red}
          actionLabel="Retry"
          onAction={() => void load()}
        /> : snapshot && !snapshot.available ? <StateCard
          icon={CircleX}
          title="MCP controls unavailable"
          body={snapshot.reason?.message || 'Claude MCP controls are unavailable for this chat.'}
          detail={`Transport: ${snapshot.transport}`}
          color={colors.orange}
          actionLabel={snapshot.reason?.retryable ? 'Retry' : undefined}
          onAction={snapshot.reason?.retryable ? () => void load() : undefined}
        /> : snapshot ? <>
          <View accessibilityLiveRegion="polite" style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.summaryCopy}>
              <Text style={[styles.summaryTitle, { color: colors.text }]}>{servers.length ? `${connectedCount} of ${enabledCount} enabled servers connected` : snapshot.truncated ? 'No displayable MCP servers' : 'No MCP servers configured'}</Text>
              <Text style={[styles.summaryDetail, { color: colors.muted }]}>{snapshot.session_loaded ? 'Changes to enabled servers last only while this Claude session remains loaded.' : 'Claude SDK session is starting for this chat.'}</Text>
            </View>
            {refreshing ? <ActivityIndicator accessibilityLabel="Refreshing Claude MCP servers" size="small" color={colors.blue} /> : <CircleCheck size={18} color={colors.green} />}
          </View>

          {snapshot.truncated ? <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <AlertTriangle size={17} color={colors.orange} />
            <Text style={[styles.noticeText, { color: colors.muted }]}>This server has more MCP servers than can be shown here. Use Claude Code on the AgentsServer host to manage the complete list.</Text>
          </View> : null}

          {reconnectableCount > 0 ? <Pressable
            testID="claude-mcp-reconnect-all"
            accessibilityRole="button"
            accessibilityLabel={`Reconnect ${reconnectableCount} unavailable Claude MCP ${reconnectableCount === 1 ? 'server' : 'servers'}`}
            accessibilityHint="Reconnects failed servers once without changing connected or disabled servers"
            accessibilityState={{ disabled: actionsDisabled, busy: busyServer === '*' }}
            disabled={actionsDisabled}
            onPress={() => void mutate('reconnect_all', null)}
            style={({ pressed }) => [styles.reconnectAll, { backgroundColor: colors.raised, borderColor: colors.border, opacity: actionsDisabled ? 0.35 : pressed ? 0.62 : 1 }]}
          >{busyServer === '*' ? <ActivityIndicator size="small" color={colors.blue} /> : <RefreshCw size={17} color={colors.blue} />}<Text style={[styles.reconnectAllText, { color: colors.text }]}>Reconnect unavailable servers</Text></Pressable> : null}

          {turnActive ? <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.raised, borderColor: colors.border }]}>
            <Clock3 size={17} color={colors.orange} />
            <Text style={[styles.noticeText, { color: colors.muted }]}>This is the last loaded status. Wait for Claude to finish before refreshing, enabling, disabling, or reconnecting servers.</Text>
          </View> : null}
          {actionError ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.red, borderColor: colors.red }]}>{actionError}</Text> : null}
          {loadError ? <View accessibilityRole="alert" style={[styles.inlineError, { borderColor: colors.red }]}>
            <Text style={[styles.inlineErrorText, { color: colors.red }]}>{loadError}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry loading Claude MCP servers" onPress={() => void load()} style={({ pressed }) => [styles.smallButton, { borderColor: colors.red, opacity: pressed ? 0.6 : 1 }]}><Text style={[styles.smallButtonText, { color: colors.red }]}>Retry</Text></Pressable>
          </View> : null}

          {servers.length ? <View accessibilityLabel="Configured Claude MCP servers" style={styles.serverList}>
            {servers.map(server => <McpServerRow
              key={server.name}
              server={server}
              colors={colors}
              busy={busyServer === server.name}
              disabled={actionsDisabled}
              onEnabledChange={enabled => void mutate(enabled ? 'enable' : 'disable', server.name)}
              onReconnect={() => void mutate('reconnect', server.name)}
            />)}
          </View> : <StateCard
            icon={Server}
            title={snapshot.truncated ? 'No displayable MCP servers' : 'No MCP servers configured'}
            body={snapshot.truncated
              ? 'Use Claude Code on the AgentsServer host to view the complete list.'
              : 'Add MCP servers with Claude Code on the AgentsServer host. They will appear here without exposing their configuration or credentials.'}
            color={colors.muted}
          />}
        </> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>
}

function McpServerRow({ server, colors, busy, disabled, onEnabledChange, onReconnect }: {
  server: ClaudeMcpServer
  colors: Palette
  busy: boolean
  disabled: boolean
  onEnabledChange: (enabled: boolean) => void
  onReconnect: () => void
}) {
  const effectiveStatus = server.enabled ? server.status : 'disabled'
  const status = statusPresentation(effectiveStatus, colors)
  const controlsDisabled = disabled || busy
  const reconnectDisabled = controlsDisabled || !server.enabled || server.status === 'pending'
  const metadata = [
    server.scope ? `${scopeLabel(server.scope)} scope` : null,
    server.server_info?.version ? `v${server.server_info.version}` : null,
    server.tool_count != null ? `${server.tool_count} ${server.tool_count === 1 ? 'tool' : 'tools'}` : null,
  ].filter((value): value is string => Boolean(value)).join(' · ')
  const StatusIcon = status.icon
  return <View
    testID="claude-mcp-server"
    accessibilityLabel={`${server.name}, ${status.label}${metadata ? `, ${metadata}` : ''}`}
    style={[styles.serverCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
  >
    <View style={styles.serverHeader}>
      <View style={[styles.serverIcon, { backgroundColor: colors.raised }]}><Server size={18} color={colors.blue} /></View>
      <View style={styles.serverCopy}>
        <Text selectable style={[styles.serverName, { color: colors.text }]} numberOfLines={2}>{server.name}</Text>
        {metadata ? <Text style={[styles.serverMetadata, { color: colors.muted }]} numberOfLines={2}>{metadata}</Text> : null}
      </View>
      <View accessible accessibilityRole="text" accessibilityLabel={`Status ${status.label}`} style={[styles.statusPill, { backgroundColor: colors.raised }]}>
        {effectiveStatus === 'pending' ? <ActivityIndicator size="small" color={status.color} /> : <StatusIcon size={14} color={status.color} />}
        <Text style={[styles.statusText, { color: status.color }]}>{status.label}</Text>
      </View>
    </View>
    {server.enabled && server.error ? <Text accessibilityRole="alert" style={[styles.serverError, { color: colors.red }]}>{server.error}</Text> : null}
    {effectiveStatus === 'needs-auth' ? <Text style={[styles.authHelp, { color: colors.orange }]}>Authentication is required. Open Claude Code in the AgentsDock terminal and run /mcp to authenticate this server.</Text> : null}
    <View style={[styles.serverControls, { borderTopColor: colors.border }]}>
      <View style={styles.enableCopy}>
        <Text style={[styles.enableTitle, { color: colors.text }]}>Enabled</Text>
        <Text style={[styles.enableHelp, { color: colors.muted }]}>For the current Claude session</Text>
      </View>
      {busy ? <ActivityIndicator accessibilityLabel={`Updating ${server.name}`} size="small" color={colors.blue} /> : null}
      <Switch
        testID="claude-mcp-enabled"
        accessibilityLabel={`${server.enabled ? 'Disable' : 'Enable'} MCP server ${server.name}`}
        accessibilityHint="Changes whether this MCP server is available while the current Claude session for this chat remains loaded"
        accessibilityState={{ disabled: controlsDisabled, checked: server.enabled, busy }}
        value={server.enabled}
        disabled={controlsDisabled}
        onValueChange={onEnabledChange}
      />
      <Pressable
        testID="claude-mcp-reconnect"
        accessibilityRole="button"
        accessibilityLabel={`Reconnect MCP server ${server.name}`}
        accessibilityState={{ disabled: reconnectDisabled, busy }}
        disabled={reconnectDisabled}
        onPress={onReconnect}
        style={({ pressed }) => [styles.reconnect, { borderColor: colors.border, backgroundColor: colors.raised, opacity: reconnectDisabled ? 0.35 : pressed ? 0.62 : 1 }]}
      ><RefreshCw size={15} color={colors.muted} /><Text style={[styles.reconnectText, { color: colors.text }]}>Reconnect</Text></Pressable>
    </View>
  </View>
}

function StateCard({ icon: Icon, title, body, detail, color, actionLabel, onAction }: {
  icon: LucideIcon
  title: string
  body: string
  detail?: string | null
  color: string
  actionLabel?: string
  onAction?: () => void
}) {
  const colors = usePalette()
  return <View accessibilityLiveRegion="polite" style={[styles.stateCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={[styles.stateIcon, { backgroundColor: colors.raised }]}><Icon size={22} color={color} /></View>
    <Text accessibilityRole="header" style={[styles.stateTitle, { color: colors.text }]}>{title}</Text>
    <Text style={[styles.stateBody, { color: colors.muted }]}>{body}</Text>
    {detail ? <Text style={[styles.stateDetail, { color: colors.muted }]}>{detail}</Text> : null}
    {actionLabel && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} style={({ pressed }) => [styles.stateAction, { backgroundColor: colors.blue, opacity: pressed ? 0.65 : 1 }]}><Text style={styles.stateActionText}>{actionLabel}</Text></Pressable> : null}
  </View>
}

function mcpScopeIsCurrent(
  connection: AgentServerClient,
  profileId: string,
  profileGeneration: number,
  sessionId: string,
): boolean {
  const state = useAppStore.getState()
  const session = state.sessions.find(candidate => candidate.id === sessionId)
  return client === connection
    && !connection.isDisposed
    && connection.isValidated
    && state.activeProfileId === profileId
    && state.profileGeneration === profileGeneration
    && state.selectedSessionId === sessionId
    && session?.backend === 'claude'
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
    && !state.workspaceAdopting
}

function assertMcpSnapshot(snapshot: ClaudeMcpSnapshot): void {
  const statuses = new Set(['connected', 'pending', 'failed', 'needs-auth', 'disabled', 'unknown'])
  const scopes = new Set(['user', 'project', 'local', 'claudeai', 'managed'])
  if (
    snapshot?.version !== 1
    || !Array.isArray(snapshot.servers)
    || (snapshot.generation !== null && typeof snapshot.generation !== 'string')
    || typeof snapshot.truncated !== 'boolean'
    || !snapshot.servers.every(server => server
      && typeof server.name === 'string'
      && typeof server.enabled === 'boolean'
      && statuses.has(server.status)
      && (server.error === null || typeof server.error === 'string')
      && (server.scope === null || scopes.has(server.scope))
      && (server.tool_count === null || typeof server.tool_count === 'number')
      && (server.server_info === null || (
        typeof server.server_info?.name === 'string'
        && typeof server.server_info.version === 'string'
      )))
  ) {
    throw new Error('AgentsServer returned an invalid Claude MCP response.')
  }
}

function serverErrorCode(cause: unknown): string | null {
  if (!(cause instanceof ServerError) || !cause.detail || typeof cause.detail !== 'object' || Array.isArray(cause.detail)) return null
  const code = (cause.detail as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ServerError) {
    const code = serverErrorCode(cause)
    if (code === 'claude_mcp_turn_active') return 'Wait for the active Claude turn to finish before changing MCP servers.'
    if (code === 'claude_mcp_server_not_found') return 'This MCP server is no longer configured. Refresh the panel and try again.'
    if (code === 'claude_mcp_connection_failed') return 'Claude could not connect to this MCP server. Try again.'
    if (code === 'claude_mcp_control_failed') return 'Claude could not update this MCP server. Try again.'
    if (cause.status === 404) return 'This AgentsServer does not support Claude MCP management. Update the server and reconnect.'
    if (cause.status === 409) return 'Claude MCP state changed or is currently busy. Refresh the panel and try again.'
    if (cause.status === 503) return 'Claude MCP controls are temporarily unavailable. Try again.'
    return fallback
  }
  if (cause instanceof TypeError) return 'Could not reach AgentsServer. Check the active server connection and try again.'
  return fallback
}

function scopeLabel(scope: NonNullable<ClaudeMcpServer['scope']>): string {
  return scope === 'claudeai' ? 'Claude.ai' : `${scope.slice(0, 1).toUpperCase()}${scope.slice(1)}`
}

function statusPresentation(status: ClaudeMcpServer['status'], colors: Palette): { label: string; color: string; icon: LucideIcon } {
  if (status === 'connected') return { label: 'Connected', color: colors.green, icon: CircleCheck }
  if (status === 'pending') return { label: 'Connecting', color: colors.blue, icon: Clock3 }
  if (status === 'failed') return { label: 'Failed', color: colors.red, icon: AlertTriangle }
  if (status === 'needs-auth') return { label: 'Needs auth', color: colors.orange, icon: AlertTriangle }
  if (status === 'disabled') return { label: 'Disabled', color: colors.muted, icon: CircleX }
  return { label: 'Unknown', color: colors.muted, icon: CircleHelp }
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerMark: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '900' },
  subtitle: { marginTop: 2, fontSize: 10.5 },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scroll: { flex: 1 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 14, paddingBottom: 48, gap: 10 },
  loading: { minHeight: 160, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { fontSize: 12, fontWeight: '700' },
  summary: { minHeight: 64, borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryCopy: { flex: 1, minWidth: 0, gap: 3 },
  summaryTitle: { fontSize: 13, fontWeight: '800' },
  summaryDetail: { fontSize: 10.5, lineHeight: 15 },
  notice: { minHeight: 54, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  noticeText: { flex: 1, fontSize: 10.5, lineHeight: 15 },
  reconnectAll: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  reconnectAllText: { fontSize: 11.5, fontWeight: '800' },
  error: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 10, fontSize: 11, lineHeight: 16 },
  inlineError: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineErrorText: { flex: 1, fontSize: 11, lineHeight: 15 },
  smallButton: { minWidth: 68, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  smallButtonText: { fontSize: 11.5, fontWeight: '800' },
  serverList: { gap: 9 },
  serverCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 10, gap: 8 },
  serverHeader: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 },
  serverIcon: { width: 38, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  serverCopy: { minWidth: 0, flex: 1, gap: 2 },
  serverName: { fontSize: 13, fontWeight: '800' },
  serverMetadata: { fontSize: 10, lineHeight: 14 },
  statusPill: { minHeight: 30, maxWidth: 110, borderRadius: 15, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusText: { flexShrink: 1, fontSize: 9.5, fontWeight: '800' },
  serverError: { paddingHorizontal: 3, fontSize: 10.5, lineHeight: 15 },
  authHelp: { paddingHorizontal: 3, fontSize: 10.5, lineHeight: 15 },
  serverControls: { minHeight: 54, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  enableCopy: { flex: 1, minWidth: 70, gap: 1 },
  enableTitle: { fontSize: 11.5, fontWeight: '800' },
  enableHelp: { fontSize: 9.5, lineHeight: 13 },
  reconnect: { minWidth: 102, minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  reconnectText: { fontSize: 10.5, fontWeight: '800' },
  stateCard: { minHeight: 180, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 18, alignItems: 'center', justifyContent: 'center', gap: 8 },
  stateIcon: { width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  stateTitle: { marginTop: 2, textAlign: 'center', fontSize: 15, fontWeight: '900' },
  stateBody: { maxWidth: 520, textAlign: 'center', fontSize: 11.5, lineHeight: 17 },
  stateDetail: { maxWidth: 520, textAlign: 'center', fontSize: 10.5, lineHeight: 15 },
  stateAction: { minWidth: 92, minHeight: 44, marginTop: 4, borderRadius: 7, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  stateActionText: { color: 'white', fontSize: 12, fontWeight: '800' },
})
