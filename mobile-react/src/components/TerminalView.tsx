import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, Columns2, Keyboard as KeyboardIcon, Plus, Rows2, Trash2, X } from 'lucide-react-native'
import { WebView } from 'react-native-webview'
import { client } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session, TerminalWindow } from '../types'
import { FIT_JS, XTERM_CSS, XTERM_JS } from '../terminal/xtermAssets'
import { IconButton } from './ui'

export function TerminalView({ session, onClose }: { session: Session; onClose: () => void }) {
  const colors = usePalette()
  const webView = useRef<WebView>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [status, setStatus] = useState('Connecting')
  const [notice, setNotice] = useState('')
  const refresh = async () => { try { setWindows((await client.terminalWindows(session.id)).windows) } catch { /* session is created by websocket */ } }
  useEffect(() => { void refresh() }, [session.id])
  const html = useMemo(() => terminalHTML(session, colors.background, colors.text), [colors.background, colors.text, session])
  const action = async (name: 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'kill-window') => {
    try { setWindows((await client.terminalAction(session.id, name)).windows) } catch { /* status remains visible in terminal */ }
  }
  const runTerminalJS = (script: string) => webView.current?.injectJavaScript(`${script};true;`)
  const flash = (message: string) => {
    setNotice(message)
    setTimeout(() => setNotice(''), 1_200)
  }
  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    if (!text) { flash('Clipboard empty'); return }
    runTerminalJS(`window.__agentsDockTerminal?.paste(${JSON.stringify(text)})`)
    flash('Pasted')
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
        <IconButton icon={ClipboardCopy} size={14} label="Copy selection or visible terminal" onPress={() => runTerminalJS('window.__agentsDockTerminal?.copy()')} />
        <IconButton icon={ClipboardPaste} size={14} label="Paste" onPress={() => void paste()} />
      </ScrollView>
      <IconButton icon={KeyboardIcon} size={14} label="Focus terminal keyboard" onPress={() => runTerminalJS('window.__agentsDockTerminal?.focus()')} />
      <IconButton icon={X} size={14} label="Close terminal" onPress={onClose} />
    </View>
    <WebView
      ref={webView}
      source={{ html }}
      style={{ flex: 1, backgroundColor: colors.background }}
      originWhitelist={['*']}
      javaScriptEnabled
      keyboardDisplayRequiresUserAction={false}
      scrollEnabled={false}
      onMessage={event => {
        try {
          const value = JSON.parse(event.nativeEvent.data) as { type?: string; name?: string; text?: string }
          if (value.type === 'ready') { setStatus('Connected'); void refresh() }
          else if (value.type === 'closed') setStatus('Reconnecting')
          else if (value.type === 'error') setStatus('Error')
          else if (value.type === 'copy' && value.text) { void Clipboard.setStringAsync(value.text); flash('Copied') }
        } catch { /* ignore */ }
      }}
    />
  </View>
}

function terminalHTML(session: Session, background: string, foreground: string): string {
  const endpoint = new URL(client.url(`/api/sessions/${encodeURIComponent(session.id)}/terminal/ws`))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('columns', '100')
  endpoint.searchParams.set('rows', '30')
  if (session.cwd) endpoint.searchParams.set('cwd', session.cwd)
  const token = useAppToken()
  if (token) endpoint.searchParams.set('token', token)
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>${XTERM_CSS}\nhtml,body,#terminal{width:100%;height:100%;margin:0;background:${background};overflow:hidden}.xterm{padding:8px;box-sizing:border-box}</style></head><body><div id="terminal"></div><script>${XTERM_JS}</script><script>${FIT_JS}</script><script>
  const host = document.getElementById('terminal');
  const term = new Terminal({cursorBlink:true,fontFamily:'Menlo, monospace',fontSize:13,scrollback:10000,theme:{background:${JSON.stringify(background)},foreground:${JSON.stringify(foreground)},cursor:'#35df84'},allowProposedApi:true});
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(host); fit.fit();
  function focusTerminal(){ term.focus(); if(term.textarea) term.textarea.focus({preventScroll:true}); }
  function visibleText(){ const buffer=term.buffer.active; const start=Math.max(0,buffer.viewportY); const end=Math.min(buffer.length,start+term.rows); const lines=[]; for(let index=start;index<end;index++){ const line=buffer.getLine(index); if(line) lines.push(line.translateToString(true)); } return lines.join('\\n').replace(/\\s+$/,''); }
  let ws; let timer; function connect(){ ws=new WebSocket(${JSON.stringify(endpoint.toString())}); ws.binaryType='arraybuffer'; ws.onopen=()=>{fit.fit();ws.send(JSON.stringify({type:'resize',columns:term.cols,rows:term.rows}))}; ws.onmessage=e=>{if(typeof e.data==='string'){try{const c=JSON.parse(e.data);if(c.type==='ready'){window.ReactNativeWebView.postMessage(JSON.stringify(c));return}}catch{} term.write(e.data)}else term.write(new Uint8Array(e.data))}; ws.onclose=()=>{window.ReactNativeWebView.postMessage(JSON.stringify({type:'closed'}));timer=setTimeout(connect,800)}; ws.onerror=()=>window.ReactNativeWebView.postMessage(JSON.stringify({type:'error'}));}
  term.onData(data=>{if(ws&&ws.readyState===1)ws.send(data)}); term.onResize(size=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'resize',columns:size.cols,rows:size.rows}))});
  window.__agentsDockTerminal={focus:focusTerminal,paste:text=>{focusTerminal();term.paste(String(text??''));},copy:()=>{const text=term.getSelection()||visibleText();window.ReactNativeWebView.postMessage(JSON.stringify({type:'copy',text}))}};
  host.addEventListener('pointerdown',focusTerminal); host.addEventListener('touchstart',()=>requestAnimationFrame(focusTerminal),{passive:true});
  new ResizeObserver(()=>fit.fit()).observe(document.body); connect();
  </script></body></html>`
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
})
