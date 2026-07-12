import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, Columns2, Keyboard as KeyboardIcon, Plus, Rows2, Trash2, X } from 'lucide-react-native'
import {
  AgentsDockNativeTerminal,
  type AgentsDockNativeTerminalHandle,
} from 'agentsdock-native-terminal'
import { client } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session, TerminalWindow } from '../types'
import { IconButton } from './ui'

export function TerminalView({ session, onClose }: { session: Session; onClose: () => void }) {
  const colors = usePalette()
  const terminal = useRef<AgentsDockNativeTerminalHandle>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [status, setStatus] = useState('Connecting')
  const [notice, setNotice] = useState('')
  const refresh = async () => { try { setWindows((await client.terminalWindows(session.id)).windows) } catch { /* session is created by websocket */ } }
  useEffect(() => { void refresh() }, [session.id])
  const socketURL = useMemo(() => terminalSocketURL(session), [session.cwd, session.id])
  const action = async (name: 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'kill-window') => {
    try { setWindows((await client.terminalAction(session.id, name)).windows) } catch { /* status remains visible in terminal */ }
  }
  const flash = (message: string) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 1_200)
  }
  const copy = async () => {
    const copied = await terminal.current?.copy()
    flash(copied ? 'Copied' : 'Select text to copy')
  }
  const paste = async () => {
    const pasted = await terminal.current?.paste()
    flash(pasted ? 'Pasted' : 'Clipboard empty')
  }
  return <View style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}> 
    <View style={[styles.tabs, { borderColor: colors.border }]}> 
      <View style={styles.status}><View style={[styles.statusDot, { backgroundColor: status === 'Connected' ? colors.green : colors.orange }]} /><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{notice || status}</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroller} contentContainerStyle={styles.tabContent}>
        {windows.map(window => <Pressable key={window.id} onPress={() => void client.terminalAction(session.id, 'select-window', String(window.index)).then(value => setWindows(value.windows))} style={[styles.tab, { backgroundColor: window.active ? colors.raised : 'transparent' }]}><Text style={{ color: window.active ? colors.text : colors.muted, fontSize: 11 }} numberOfLines={1}>{window.name}</Text></Pressable>)}
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
      <IconButton icon={X} size={14} label="Close terminal" onPress={onClose} />
    </View>
    <AgentsDockNativeTerminal
      key={session.id}
      ref={terminal}
      socketURL={socketURL}
      backgroundHex={colors.background}
      foregroundHex={colors.text}
      style={styles.terminal}
      onStatus={event => {
        const value = event.nativeEvent
        setStatus(value.status)
        if (value.status === 'Connected') void refresh()
      }}
    />
  </View>
}

function terminalSocketURL(session: Session): string {
  const endpoint = new URL(client.url(`/api/sessions/${encodeURIComponent(session.id)}/terminal/ws`))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('columns', '100')
  endpoint.searchParams.set('rows', '30')
  if (session.cwd) endpoint.searchParams.set('cwd', session.cwd)
  const token = useAppToken()
  if (token) endpoint.searchParams.set('token', token)
  return endpoint.toString()
}

function useAppToken(): string {
  // The URL is assembled synchronously from the configured singleton. authHeaders
  // is the only public token-bearing representation and never writes to the DOM.
  return client.authHeaders()['X-ZenithDock-Token'] ?? ''
}

const styles = StyleSheet.create({
  root: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  tabs: { height: 44, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 5, flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { maxWidth: 82, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 3 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  tabScroller: { flex: 1 },
  tabContent: { alignItems: 'center', gap: 4, paddingHorizontal: 2 },
  tab: { maxWidth: 120, height: 30, borderRadius: 5, paddingHorizontal: 10, justifyContent: 'center' },
  terminal: { flex: 1 },
})
