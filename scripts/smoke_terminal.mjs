#!/usr/bin/env node

import process from 'node:process'
import { randomUUID } from 'node:crypto'

const baseURL = (process.env.AGENTSDOCK_SERVER_URL || 'http://127.0.0.1:7850').replace(/\/$/, '')
const token = process.env.AGENTSDOCK_TOKEN || ''
const cwd = process.env.AGENTSDOCK_TERMINAL_CWD || process.env.HOME || '/tmp'
const marker = `PTY_${randomUUID().replaceAll('-', '')}`
let sessionId = null

async function request(path, init = {}) {
  const headers = new Headers(init.headers)
  if (token) headers.set('X-ZenithDock-Token', token)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${baseURL}${path}`, { ...init, headers })
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}

function openTerminal(id) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseURL}/api/sessions/${encodeURIComponent(id)}/terminal/ws`)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('columns', '100')
    url.searchParams.set('rows', '30')
    if (token) url.searchParams.set('token', token)
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const decoder = new TextDecoder()
    let output = ''
    const waiters = new Set()
    const append = value => {
      output += value
      for (const waiter of [...waiters]) {
        if (output.includes(waiter.text)) {
          clearTimeout(waiter.timer)
          waiters.delete(waiter)
          waiter.resolve()
        }
      }
    }
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        const control = JSON.parse(event.data)
        if (control.type === 'ready') {
          resolve({
            socket,
            send: text => socket.send(new TextEncoder().encode(text)),
            waitFor(text, timeout = 10_000) {
              if (output.includes(text)) return Promise.resolve()
              return new Promise((waitResolve, waitReject) => {
                const waiter = {
                  text,
                  resolve: waitResolve,
                  timer: setTimeout(() => {
                    waiters.delete(waiter)
                    waitReject(new Error(`Timed out waiting for terminal output: ${text}`))
                  }, timeout)
                }
                waiters.add(waiter)
              })
            }
          })
        } else if (control.type === 'error') {
          reject(new Error(control.message || 'Terminal server error'))
        }
        return
      }
      append(decoder.decode(new Uint8Array(event.data), { stream: true }))
    })
    socket.addEventListener('error', () => reject(new Error('Terminal WebSocket failed')))
    socket.addEventListener('close', event => {
      if (!event.wasClean && event.code !== 1000) reject(new Error(`Terminal closed: ${event.code} ${event.reason}`))
    })
  })
}

function closeSocket(socket) {
  return new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve()
    socket.addEventListener('close', () => resolve(), { once: true })
    socket.close(1000)
  })
}

try {
  const created = await request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: `Terminal smoke ${new Date().toISOString()}`,
      folder: 'Terminal smoke',
      cwd,
      backend: 'codex'
    })
  })
  sessionId = created.session.id

  const first = await openTerminal(sessionId)
  first.send(`export AGENTSDOCK_TERMINAL_SMOKE=${marker}; printf 'attached\\n'\r`)
  await first.waitFor('attached')
  await closeSocket(first.socket)

  const second = await openTerminal(sessionId)
  second.send(`printf '%s\\n' "$AGENTSDOCK_TERMINAL_SMOKE"\r`)
  await second.waitFor(marker)
  await closeSocket(second.socket)

  const localSelection = await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/windows`)
  if (localSelection.mouse_enabled !== false) throw new Error('New terminal did not default to local text selection')
  const mouseCapture = await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'toggle-mouse' })
  })
  if (mouseCapture.mouse_enabled !== true) throw new Error('Tmux mouse capture did not enable')
  const selectionRestored = await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'toggle-mouse' })
  })
  if (selectionRestored.mouse_enabled !== false) throw new Error('Local text selection did not restore')

  await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'new-window' })
  })
  const split = await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'split-right' })
  })
  if (split.windows.length !== 2 || !split.windows.some(window => window.active && window.panes === 2)) {
    throw new Error(`Unexpected tmux window state: ${JSON.stringify(split.windows)}`)
  }
  const activeWindow = split.windows.find(window => window.active)
  const afterClose = await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
    method: 'POST',
    body: JSON.stringify({ action: 'kill-window', target: String(activeWindow.index) })
  })
  if (afterClose.windows.length !== 1) {
    throw new Error(`Tmux window did not close: ${JSON.stringify(afterClose.windows)}`)
  }
  let finalWindowProtected = false
  try {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'kill-window', target: String(afterClose.windows[0].index) })
    })
  } catch (error) {
    finalWindowProtected = String(error).includes('409')
  }
  if (!finalWindowProtected) throw new Error('The final tmux window was not protected')

  console.log('Terminal smoke passed: attach, persistent state, local selection, mouse toggle, reattach, window close, final-window guard, split pane')
} finally {
  if (sessionId) {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}/terminal`, { method: 'DELETE' }).catch(() => {})
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
  }
}
