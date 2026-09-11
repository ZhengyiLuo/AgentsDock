import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, Columns2, Keyboard as KeyboardIcon, Plus, Rows2, Trash2, X } from 'lucide-react-native'
import { AgentServerClientDisposedError, type AgentServerClient } from '../api/AgentServerClient'
import { scaleAppFont } from '../lib/typography'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session, TerminalWindow } from '../types'
import { Text } from './AppText'
import { TerminalViewport, type TerminalViewportHandle } from './terminal/TerminalViewport'
import { IconButton } from './ui'

interface ScopedTerminalViewProps {
  session: Session
  onClose: () => void
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  fontScale: number
}

export function TerminalView({ session, onClose }: { session: Session; onClose: () => void }) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const fontScale = useAppStore(state => state.fontScale)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  if (!connectionReady) {
    return <View collapsable={false} style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <View style={[styles.tabs, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <Text style={[styles.unavailableTitle, { color: colors.muted }]} numberOfLines={1}>Terminal unavailable</Text>
        <View style={{ flex: 1 }} />
        <IconButton icon={X} size={17} touchSize={44} label="Close terminal" testID="terminal-close" onPress={onClose} />
      </View>
      <View style={styles.unavailable}>
        <Text style={[styles.unavailableText, { color: colors.muted }]}>{connecting || switchingProfileId ? 'Verifying server identity…' : 'Reconnect this server to open its terminal.'}</Text>
      </View>
    </View>
  }
  return <ScopedTerminalView
    key={`${connectionKey}:${session.id}`}
    session={session}
    onClose={onClose}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    fontScale={fontScale}
  />
}

function ScopedTerminalView({ session, onClose, connection, connectionKey, activeProfileId, profileGeneration, fontScale }: ScopedTerminalViewProps) {
  const colors = usePalette()
  const terminal = useRef<TerminalViewportHandle>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [status, setStatus] = useState('Connecting')
  const [notice, setNotice] = useState('')
  const refresh = useCallback(async () => {
    try {
      const next = await connection.terminalWindows(session.id)
      if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) setWindows(next.windows)
    } catch (error) {
      if (connectionIsCurrent(connection, activeProfileId, profileGeneration) && !(error instanceof AgentServerClientDisposedError)) {
        // The terminal websocket may still be creating its first window.
      }
    }
  }, [activeProfileId, connection, profileGeneration, session.id])
  useEffect(() => {
    setWindows([])
    setStatus('Connecting')
    setNotice('')
    void refresh()
    return () => {
      const nativeTerminal = terminal.current
      if (nativeTerminal) void nativeTerminal.blur().catch(() => undefined)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
  }, [connectionKey, refresh])
  const socketURL = useMemo(
    () => terminalSocketURL(connection, session),
    [connection, connectionKey, session.cwd, session.id],
  )
  const action = async (name: 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'kill-window' | 'select-window', target?: string) => {
    try {
      const next = await connection.terminalAction(session.id, name, target)
      if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) setWindows(next.windows)
    } catch (error) {
      if (connectionIsCurrent(connection, activeProfileId, profileGeneration) && !(error instanceof AgentServerClientDisposedError)) {
        flash(error instanceof Error ? error.message : 'Terminal action failed')
      }
    }
  }
  const flash = (message: string) => {
    if (!connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) setNotice('')
    }, 1_200)
  }
  const copy = async () => {
    const copied = await terminal.current?.copy()
    if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) flash(copied ? 'Copied' : 'Select text to copy')
  }
  const paste = async () => {
    const pasted = await terminal.current?.paste()
    if (connectionIsCurrent(connection, activeProfileId, profileGeneration)) flash(pasted ? 'Pasted' : 'Clipboard empty')
  }
  const close = () => {
    const nativeTerminal = terminal.current
    if (nativeTerminal) void nativeTerminal.blur().catch(() => undefined)
    onClose()
  }
  return <View collapsable={false} style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
    <View
      collapsable={false}
      pointerEvents="auto"
      testID="terminal-toolbar"
      style={[styles.tabs, { backgroundColor: colors.background, borderColor: colors.border }]}
    >
      <View style={styles.status}><View style={[styles.statusDot, { backgroundColor: status === 'Connected' ? colors.green : colors.orange }]} /><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{notice || status}</Text></View>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={styles.tabScroller} contentContainerStyle={styles.tabContent}>
        {windows.map(window => <Pressable key={window.id} accessibilityRole="button" accessibilityLabel={`Terminal window ${window.name}`} accessibilityState={{ selected: window.active }} onPress={() => void action('select-window', String(window.index))} style={[styles.tab, { backgroundColor: window.active ? colors.raised : 'transparent' }]}><Text style={{ color: window.active ? colors.text : colors.muted, fontSize: 11 }} numberOfLines={1}>{window.name}</Text></Pressable>)}
        <IconButton icon={Plus} size={14} label="New window" onPress={() => void action('new-window')} />
        <IconButton icon={ChevronLeft} size={14} label="Previous window" onPress={() => void action('previous-window')} />
        <IconButton icon={ChevronRight} size={14} label="Next window" onPress={() => void action('next-window')} />
        <IconButton icon={Columns2} size={14} label="Split right" onPress={() => void action('split-right')} />
        <IconButton icon={Rows2} size={14} label="Split down" onPress={() => void action('split-down')} />
        <IconButton icon={Trash2} size={14} label="Close terminal window" onPress={() => void action('kill-window')} />
        <IconButton icon={ClipboardCopy} size={14} label="Copy selection or terminal buffer" onPress={() => void copy()} />
        <IconButton icon={ClipboardPaste} size={14} label="Paste" onPress={() => void paste()} />
      </ScrollView>
      <IconButton icon={KeyboardIcon} size={14} label="Focus terminal keyboard" onPress={() => void terminal.current?.focus()} />
      <IconButton icon={X} size={17} touchSize={44} label="Close terminal" testID="terminal-close" onPress={close} />
    </View>
    <View collapsable={false} pointerEvents="box-none" testID="terminal-platform-viewport" style={styles.terminalViewport}>
      <TerminalViewport
        key={`${connectionKey}:${session.id}`}
        ref={terminal}
        socketURL={socketURL}
        backgroundHex={colors.background}
        foregroundHex={colors.text}
        fontSize={scaleAppFont(13, fontScale)}
        style={styles.terminal}
        onStatus={event => {
          if (!connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
          const value = event.nativeEvent
          setStatus(value.status)
          if (value.message) setNotice(value.message)
          if (value.status === 'Connected') void refresh()
        }}
      />
    </View>
  </View>
}

function terminalSocketURL(connection: AgentServerClient, session: Session): string {
  const endpoint = new URL(connection.url(`/api/sessions/${encodeURIComponent(session.id)}/terminal/ws`))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('columns', '100')
  endpoint.searchParams.set('rows', '30')
  if (session.cwd) endpoint.searchParams.set('cwd', session.cwd)
  const token = connection.authHeaders()['X-ZenithDock-Token'] ?? ''
  if (token) endpoint.searchParams.set('token', token)
  return endpoint.toString()
}

function connectionIsCurrent(connection: AgentServerClient, profileId: string | null, generation: number): boolean {
  const state = useAppStore.getState()
  return !connection.isDisposed
    && connection.isValidated
    && client === connection
    && state.activeProfileId === profileId
    && state.profileGeneration === generation
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tabs: { position: 'relative', zIndex: 2, flexShrink: 0, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 5, paddingVertical: 2, flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { maxWidth: 82, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 3 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  tabScroller: { flex: 1 },
  tabContent: { alignItems: 'center', gap: 4, paddingHorizontal: 2 },
  tab: { maxWidth: 120, minHeight: 44, borderRadius: 5, paddingHorizontal: 10, paddingVertical: 3, justifyContent: 'center' },
  terminalViewport: { position: 'relative', zIndex: 0, flex: 1, minHeight: 0, overflow: 'hidden' },
  terminal: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  unavailable: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  unavailableTitle: { fontSize: 11, fontWeight: '700' },
  unavailableText: { maxWidth: 320, textAlign: 'center', fontSize: 12, lineHeight: 18 },
})
