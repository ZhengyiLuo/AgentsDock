import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentsDockAPI } from '../shared/ipc'
import type { AppEventMap } from '../shared/types'

const api: AgentsDockAPI = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    apply: settings => ipcRenderer.invoke('settings:apply', settings)
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: input => ipcRenderer.invoke('sessions:create', input),
    resume: input => ipcRenderer.invoke('sessions:resume', input),
    update: (sessionId, patch) => ipcRenderer.invoke('sessions:update', sessionId, patch),
    remove: sessionId => ipcRenderer.invoke('sessions:remove', sessionId),
    fork: sessionId => ipcRenderer.invoke('sessions:fork', sessionId),
    reorder: (sessionId, relativeTo, placement) => ipcRenderer.invoke('sessions:reorder', sessionId, relativeTo, placement),
    markRead: (sessionId, seq) => ipcRenderer.invoke('sessions:read', sessionId, seq),
    markUnread: sessionId => ipcRenderer.invoke('sessions:unread', sessionId),
    importHistory: (sessionId, force) => ipcRenderer.invoke('sessions:import-history', sessionId, force)
  },
  timeline: {
    cached: sessionId => ipcRenderer.invoke('timeline:cached', sessionId),
    open: sessionId => ipcRenderer.invoke('timeline:open', sessionId),
    older: (sessionId, before, limit) => ipcRenderer.invoke('timeline:older', sessionId, before, limit),
    around: (sessionId, anchorSeq, limit) => ipcRenderer.invoke('timeline:around', sessionId, anchorSeq, limit),
    index: sessionId => ipcRenderer.invoke('timeline:index', sessionId),
    search: (sessionId, query, limit) => ipcRenderer.invoke('timeline:search', sessionId, query, limit),
    subscribe: (sessionId, after) => ipcRenderer.invoke('timeline:subscribe', sessionId, after),
    unsubscribe: sessionId => ipcRenderer.invoke('timeline:unsubscribe', sessionId),
    saveViewState: state => ipcRenderer.invoke('timeline:view-state:save', state),
    getViewState: sessionId => ipcRenderer.invoke('timeline:view-state:get', sessionId)
  },
  turns: {
    send: input => ipcRenderer.invoke('turns:send', input),
    stop: sessionId => ipcRenderer.invoke('turns:stop', sessionId)
  },
  queue: {
    list: sessionId => ipcRenderer.invoke('queue:list', sessionId),
    update: (sessionId, queuedId, prompt) => ipcRenderer.invoke('queue:update', sessionId, queuedId, prompt),
    remove: (sessionId, queuedId) => ipcRenderer.invoke('queue:remove', sessionId, queuedId),
    move: (sessionId, queuedId, direction) => ipcRenderer.invoke('queue:move', sessionId, queuedId, direction),
    runNow: (sessionId, queuedId) => ipcRenderer.invoke('queue:run-now', sessionId, queuedId)
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    create: input => ipcRenderer.invoke('jobs:create', input),
    update: (jobId, patch) => ipcRenderer.invoke('jobs:update', jobId, patch),
    remove: jobId => ipcRenderer.invoke('jobs:remove', jobId),
    run: jobId => ipcRenderer.invoke('jobs:run', jobId)
  },
  files: {
    choose: () => ipcRenderer.invoke('files:choose'),
    pathForFile: file => webUtils.getPathForFile(file),
    stageClipboardImage: (data, name, type) => ipcRenderer.invoke('files:stage-clipboard', data, name, type),
    upload: (sessionId, paths) => ipcRenderer.invoke('files:upload', sessionId, paths),
    list: (sessionId, offset, limit, contentPrefix) => ipcRenderer.invoke('files:list', sessionId, offset, limit, contentPrefix),
    findEvent: (sessionId, fileId) => ipcRenderer.invoke('files:event', sessionId, fileId),
    save: file => ipcRenderer.invoke('files:save', file),
    open: file => ipcRenderer.invoke('files:open', file),
    openLinked: (sessionId, target) => ipcRenderer.invoke('files:open-linked', sessionId, target),
    reveal: file => ipcRenderer.invoke('files:reveal', file),
    beginDrag: file => ipcRenderer.send('files:begin-drag', file),
    mediaURL: fileId => `agentsdock-media://file/${encodeURIComponent(fileId)}`
  },
  digest: {
    preview: input => ipcRenderer.invoke('digest:preview', input),
    send: input => ipcRenderer.invoke('digest:send', input)
  },
  runtime: { catalog: () => ipcRenderer.invoke('runtime:catalog') },
  processes: {
    list: sessionId => ipcRenderer.invoke('processes:list', sessionId),
    tail: (sessionId, path, lines) => ipcRenderer.invoke('processes:tail', sessionId, path, lines)
  },
  tmux: {
    list: (sessionId, includeAll) => ipcRenderer.invoke('tmux:list', sessionId, includeAll),
    capture: (sessionId, paneId, lines) => ipcRenderer.invoke('tmux:capture', sessionId, paneId, lines)
  },
  terminal: {
    connect: (sessionId, options) => ipcRenderer.invoke('terminal:connect', sessionId, options),
    write: (sessionId, data) => ipcRenderer.send('terminal:write', sessionId, data),
    resize: (sessionId, columns, rows) => ipcRenderer.send('terminal:resize', sessionId, columns, rows),
    disconnect: sessionId => ipcRenderer.invoke('terminal:disconnect', sessionId),
    kill: sessionId => ipcRenderer.invoke('terminal:kill', sessionId),
    windows: sessionId => ipcRenderer.invoke('terminal:windows', sessionId),
    action: (sessionId, action, target) => ipcRenderer.invoke('terminal:action', sessionId, action, target)
  },
  pins: {
    list: sessionId => ipcRenderer.invoke('pins:list', sessionId),
    put: item => ipcRenderer.invoke('pins:put', item),
    remove: (sessionId, itemId) => ipcRenderer.invoke('pins:remove', sessionId, itemId)
  },
  preferences: {
    get: (key, fallback) => ipcRenderer.invoke('preferences:get', key, fallback),
    set: (key, value) => ipcRenderer.invoke('preferences:set', key, value)
  },
  native: {
    openExternal: url => ipcRenderer.invoke('native:open-external', url),
    showItemInFolder: path => ipcRenderer.invoke('native:show-item', path),
    setBadge: count => ipcRenderer.invoke('native:set-badge', count),
    notify: (title, body, sessionId) => ipcRenderer.invoke('native:notify', title, body, sessionId),
    log: (scope, message, data) => ipcRenderer.invoke('native:log', scope, message, data),
    readClipboard: () => ipcRenderer.invoke('native:clipboard:read'),
    writeClipboard: text => ipcRenderer.invoke('native:clipboard:write', text)
  },
  events: {
    on: <K extends keyof AppEventMap>(name: K, listener: (payload: AppEventMap[K]) => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: AppEventMap[K]): void => listener(payload)
      ipcRenderer.on(name, wrapped)
      return () => ipcRenderer.removeListener(name, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agentsDock', api)
