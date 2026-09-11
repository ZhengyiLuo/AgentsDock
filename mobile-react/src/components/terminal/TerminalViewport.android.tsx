import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { NativeSyntheticEvent } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { FIT_JS, XTERM_CSS, XTERM_JS } from '../../terminal/xtermAssets'
import type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

type CopyRequest = {
  id: number
  resolve: (copied: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export const TerminalViewport = forwardRef<TerminalViewportHandle, TerminalViewportProps>(function TerminalViewport({
  socketURL,
  backgroundHex = '#080b12',
  foregroundHex = '#f4f7fb',
  fontSize = 13,
  onStatus,
  ...viewProps
}, ref) {
  const webView = useRef<WebView>(null)
  const copySequence = useRef(0)
  const pendingCopy = useRef<CopyRequest | null>(null)
  const [webViewKey, setWebViewKey] = useState(0)
  const html = useMemo(
    () => androidTerminalHTML({ socketURL, backgroundHex, foregroundHex, fontSize }),
    [backgroundHex, fontSize, foregroundHex, socketURL],
  )

  const inject = (script: string): boolean => {
    if (!webView.current) return false
    webView.current.injectJavaScript(`${script};true;`)
    return true
  }

  useImperativeHandle(ref, () => ({
    focus: async () => inject('window.__agentsDockTerminal?.focus()'),
    blur: async () => inject('window.__agentsDockTerminal?.blur()'),
    paste: async () => {
      const text = await Clipboard.getStringAsync()
      if (!text) return false
      return inject(`window.__agentsDockTerminal?.paste(${safeInlineJSON(text)})`)
    },
    copy: () => new Promise(resolve => {
      if (pendingCopy.current) {
        clearTimeout(pendingCopy.current.timer)
        pendingCopy.current.resolve(false)
      }
      const id = ++copySequence.current
      const timer = setTimeout(() => {
        if (pendingCopy.current?.id !== id) return
        pendingCopy.current = null
        resolve(false)
      }, 900)
      pendingCopy.current = { id, resolve, timer }
      if (!inject(`window.__agentsDockTerminal?.copy(${id})`)) {
        clearTimeout(timer)
        pendingCopy.current = null
        resolve(false)
      }
    }),
  }), [])

  useEffect(() => () => {
    if (!pendingCopy.current) return
    clearTimeout(pendingCopy.current.timer)
    pendingCopy.current.resolve(false)
    pendingCopy.current = null
  }, [])

  const emitStatus = (status: TerminalConnectionStatus) => {
    onStatus?.({ nativeEvent: status } as NativeSyntheticEvent<TerminalConnectionStatus>)
  }
  const handleMessage = (event: WebViewMessageEvent) => {
    let value: { type?: string; status?: TerminalConnectionStatus['status']; name?: string; message?: string; text?: string; requestId?: number }
    try {
      value = JSON.parse(event.nativeEvent.data) as typeof value
    } catch {
      return
    }
    if (value.type === 'status' && value.status) {
      emitStatus({ status: value.status, name: value.name, message: value.message })
      return
    }
    const pending = pendingCopy.current
    if (value.type === 'copy' && pending && value.requestId === pending.id) {
      pendingCopy.current = null
      clearTimeout(pending.timer)
      if (!value.text) {
        pending.resolve(false)
        return
      }
      void Clipboard.setStringAsync(value.text).then(() => pending.resolve(true), () => pending.resolve(false))
    }
  }

  return <WebView
    {...viewProps}
    key={`${socketURL}:${webViewKey}`}
    ref={webView}
    testID="terminal-android-webview"
    source={{ html, baseUrl: 'https://agentsdock.invalid/' }}
    originWhitelist={['https://agentsdock.invalid/']}
    javaScriptEnabled
    domStorageEnabled={false}
    cacheEnabled={false}
    incognito
    mixedContentMode="always"
    setSupportMultipleWindows={false}
    javaScriptCanOpenWindowsAutomatically={false}
    scrollEnabled={false}
    overScrollMode="never"
    onShouldStartLoadWithRequest={request => request.url === 'https://agentsdock.invalid/' || request.url === 'about:blank'}
    onMessage={handleMessage}
    onError={event => emitStatus({ status: 'Error', message: event.nativeEvent.description || 'Android terminal failed to load.' })}
    onRenderProcessGone={() => {
      emitStatus({ status: 'Reconnecting', message: 'Restarting Android terminal renderer…' })
      setWebViewKey(value => value + 1)
      return true
    }}
  />
})

interface AndroidTerminalConfig {
  socketURL: string
  backgroundHex: string
  foregroundHex: string
  fontSize: number
}

export function androidTerminalHTML(config: AndroidTerminalConfig): string {
  const xterm = escapeClosingTag(XTERM_JS, 'script')
  const fit = escapeClosingTag(FIT_JS, 'script')
  const css = escapeClosingTag(XTERM_CSS, 'style')
  return `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ws: wss:; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>${css}\nhtml,body,#terminal{width:100%;height:100%;margin:0;background:${config.backgroundHex};overflow:hidden}.xterm{padding:8px;box-sizing:border-box}.xterm-viewport{overscroll-behavior:contain}</style>
  </head><body><div id="terminal"></div><script>${xterm}</script><script>${fit}</script><script>
  (() => {
    'use strict';
    const config = ${safeInlineJSON(config)};
    const post = value => window.ReactNativeWebView?.postMessage(JSON.stringify(value));
    const host = document.getElementById('terminal');
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'monospace',
      fontSize: config.fontSize,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: config.backgroundHex, foreground: config.foregroundHex, cursor: '#35df84' }
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    let socket = null;
    let reconnectTimer = null;
    let disposed = false;
    let opened = false;
    const focus = () => { term.focus(); term.textarea?.focus({ preventScroll: true }); };
    const visibleText = () => {
      const buffer = term.buffer.active;
      const start = Math.max(0, buffer.viewportY);
      const end = Math.min(buffer.length, start + term.rows);
      const lines = [];
      for (let index = start; index < end; index += 1) {
        const line = buffer.getLine(index);
        if (line) lines.push(line.translateToString(true));
      }
      return lines.join('\\n').replace(/\\s+$/, '');
    };
    const sendSize = () => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', columns: term.cols, rows: term.rows }));
    };
    const connect = () => {
      if (disposed) return;
      post({ type: 'status', status: opened ? 'Reconnecting' : 'Connecting' });
      socket = new WebSocket(config.socketURL);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => { opened = true; fit.fit(); sendSize(); };
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          try {
            const control = JSON.parse(event.data);
            if (control.type === 'ready') {
              post({ type: 'status', status: 'Connected', name: control.name, message: control.message });
              return;
            }
          } catch {}
          term.write(event.data);
        } else {
          term.write(new Uint8Array(event.data));
        }
      };
      socket.onerror = () => post({ type: 'status', status: 'Error', message: 'Terminal connection failed.' });
      socket.onclose = () => {
        if (disposed) return;
        post({ type: 'status', status: 'Reconnecting' });
        reconnectTimer = setTimeout(connect, 800);
      };
    };
    term.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(data); });
    term.onResize(sendSize);
    window.__agentsDockTerminal = {
      focus,
      blur: () => term.blur(),
      paste: text => { focus(); term.paste(String(text ?? '')); },
      copy: requestId => post({ type: 'copy', requestId, text: term.getSelection() || visibleText() })
    };
    host.addEventListener('pointerdown', focus);
    host.addEventListener('touchstart', () => requestAnimationFrame(focus), { passive: true });
    new ResizeObserver(() => { fit.fit(); sendSize(); }).observe(document.body);
    window.addEventListener('beforeunload', () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      term.dispose();
    });
    connect();
  })();
  </script></body></html>`
}

export function safeInlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeClosingTag(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}
