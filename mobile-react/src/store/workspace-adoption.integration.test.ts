import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import type { Session, StoredProfileSettings } from '../types'

function after(milliseconds: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), milliseconds))
}

const session: Session = {
  id: 'chat-a',
  title: 'Selectable after adoption',
  backend: 'codex',
  codex_thread_id: 'thread-a',
  archived: true,
  created_at: '2026-07-20T10:00:00Z',
  updated_at: '2026-07-20T10:00:00Z',
}

let baseURL = ''
const server: Server = createServer((request, response) => {
  const path = new URL(request.url ?? '/', baseURL || 'http://127.0.0.1').pathname
  if (path === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      ok: true,
      server_identity: 'server-a',
      server_version: 'adoption-test',
      api_contract_version: 8,
      active_sessions: [],
    }))
    return
  }
  if (path === '/api/sessions') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ sessions: [session] }))
    return
  }
  if (path === '/api/runtime/catalog') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ backends: {} }))
    return
  }
  if (path === '/api/jobs') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ jobs: [] }))
    return
  }
  response.writeHead(404, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ detail: `Unhandled test endpoint: ${path}` }))
})

const originalSetInterval = globalThis.setInterval
let releasePurge: (() => void) | null = null

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  baseURL = `http://127.0.0.1:${address.port}`

  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()
  await AsyncStorage.setItem('agentsdock.react.snapshot-cache-generation', '3')

  const timestamp = '2026-07-20T10:00:00.000Z'
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'profile-a',
    profiles: [{
      id: 'profile-a',
      name: 'Alpha',
      serverURL: baseURL,
      serverIdentity: null,
      serverConfigured: false,
      credentialVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    fontScale: 1,
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))

  const cache = await import('../storage/cache')
  await SecureStore.setItemAsync(cache.profileTokenKey('profile-a', 1), 'token-a')
  await cache.saveCachedSessions('profile:profile-a', [session])
  await cache.saveWorkspacePreferences('profile:profile-a', {
    selectedSessionId: null,
    folderOrder: [],
    collapsedFolders: [],
    drafts: {},
  })

  const delayedPurge = (AsyncStorage as typeof AsyncStorage & {
    __delayNextMultiRemove(): { started: Promise<void>; release(): void }
  }).__delayNextMultiRemove()
  releasePurge = delayedPurge.release
  globalThis.setInterval = (() => 1) as unknown as typeof setInterval

  const storeModule = await import('./useAppStore')
  const { useAppStore } = storeModule
  const initialization = useAppStore.getState().initialize()
  await delayedPurge.started
  assert.equal(
    await Promise.race([initialization.then(() => 'completed' as const), after(750)]),
    'completed',
    'best-effort source deletion must not hold initialization or the selector lock',
  )

  let state = useAppStore.getState()
  assert.equal(storeModule.client.isValidated, true)
  assert.equal(state.connected, true)
  assert.equal(state.workspaceAdopting, false)
  assert.equal(state.sessions[0]?.id, session.id)

  const originalSyncSelectedSession = state.syncSelectedSession
  useAppStore.setState({ syncSelectedSession: async () => {} })
  const selection = useAppStore.getState().selectSession(session.id, state.profileGeneration)
  state = useAppStore.getState()
  assert.equal(state.selectedSessionId, session.id, 'chat selection must publish immediately while purge remains unresolved')
  await selection
  useAppStore.setState({ syncSelectedSession: originalSyncSelectedSession })

  console.log('workspace adoption interaction regression passed')
} finally {
  releasePurge?.()
  globalThis.setInterval = originalSetInterval
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
