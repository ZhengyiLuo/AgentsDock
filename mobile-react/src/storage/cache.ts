import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import type { PinnedItem, Session, Snapshot } from '../types'
import { normalizeServerURL } from '../lib/format'
import { CHAT_FONT_SCALE_DEFAULT, clampChatFontScale } from '../lib/typography'

const SETTINGS_KEY = 'agentsdock.react.settings.v1'
const TOKEN_KEY = 'agentsdock.react.access-token'
const TOKEN_FALLBACK_KEY = 'agentsdock.react.access-token.simulator-fallback'
const SESSION_LIMIT = 28
const EVENT_LIMIT = 720

export interface StoredSettings {
  serverURL: string
  selectedSessionId?: string | null
  folderOrder?: string[]
  fontScale: number
}

export async function loadSettings(): Promise<StoredSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StoredSettings>
      return {
        serverURL: typeof parsed.serverURL === 'string' ? parsed.serverURL : 'http://127.0.0.1:7850',
        selectedSessionId: parsed.selectedSessionId ?? null,
        folderOrder: Array.isArray(parsed.folderOrder) ? parsed.folderOrder : [],
        fontScale: clampChatFontScale(parsed.fontScale),
      }
    }
  } catch { /* a corrupt preference must not block startup */ }
  return { serverURL: 'http://127.0.0.1:7850', selectedSessionId: null, folderOrder: [], fontScale: CHAT_FONT_SCALE_DEFAULT }
}

export async function saveSettings(value: StoredSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({
    ...value,
    serverURL: normalizeServerURL(value.serverURL),
    fontScale: clampChatFontScale(value.fontScale),
  }))
}

export async function loadToken(): Promise<string> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_KEY)
    if (token !== null) return token
  } catch { /* unsigned simulator builds do not have Keychain entitlements */ }
  try { return await AsyncStorage.getItem(TOKEN_FALLBACK_KEY) ?? '' }
  catch { return '' }
}

export async function saveToken(token: string): Promise<void> {
  try {
    if (token) await SecureStore.setItemAsync(TOKEN_KEY, token)
    else await SecureStore.deleteItemAsync(TOKEN_KEY)
    await AsyncStorage.removeItem(TOKEN_FALLBACK_KEY)
  } catch {
    if (token) await AsyncStorage.setItem(TOKEN_FALLBACK_KEY, token)
    else await AsyncStorage.removeItem(TOKEN_FALLBACK_KEY)
  }
}

function namespace(serverURL: string): string { return encodeURIComponent(normalizeServerURL(serverURL).toLowerCase()) }
function sessionsKey(serverURL: string): string { return `agentsdock.react.sessions.${namespace(serverURL)}` }
function snapshotKey(serverURL: string, sessionId: string): string { return `agentsdock.react.snapshot.${namespace(serverURL)}.${sessionId}` }
function recentKey(serverURL: string): string { return `agentsdock.react.recent.${namespace(serverURL)}` }
function pinsKey(serverURL: string): string { return `agentsdock.react.pins.${namespace(serverURL)}` }

export async function loadCachedSessions(serverURL: string): Promise<Session[]> {
  try { return JSON.parse(await AsyncStorage.getItem(sessionsKey(serverURL)) ?? '[]') as Session[] }
  catch { return [] }
}

export async function saveCachedSessions(serverURL: string, sessions: Session[]): Promise<void> {
  await AsyncStorage.setItem(sessionsKey(serverURL), JSON.stringify(sessions))
}

export async function loadSnapshot(serverURL: string, sessionId: string): Promise<Snapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(snapshotKey(serverURL, sessionId))
    return raw ? JSON.parse(raw) as Snapshot : null
  } catch { return null }
}

export async function saveSnapshot(serverURL: string, snapshot: Snapshot): Promise<void> {
  if (snapshot.session.archived) return
  const compact: Snapshot = { ...snapshot, events: snapshot.events.slice(-EVENT_LIMIT), cachedAt: Date.now() }
  await AsyncStorage.setItem(snapshotKey(serverURL, snapshot.session.id), JSON.stringify(compact))
  let recent: string[] = []
  try { recent = JSON.parse(await AsyncStorage.getItem(recentKey(serverURL)) ?? '[]') as string[] } catch { /* reset */ }
  recent = [snapshot.session.id, ...recent.filter(id => id !== snapshot.session.id)]
  const evicted = recent.slice(SESSION_LIMIT)
  await AsyncStorage.setItem(recentKey(serverURL), JSON.stringify(recent.slice(0, SESSION_LIMIT)))
  await Promise.all(evicted.map(id => AsyncStorage.removeItem(snapshotKey(serverURL, id))))
}

export async function removeSnapshot(serverURL: string, sessionId: string): Promise<void> {
  await AsyncStorage.removeItem(snapshotKey(serverURL, sessionId))
}

export async function loadPins(serverURL: string): Promise<PinnedItem[]> {
  try { return JSON.parse(await AsyncStorage.getItem(pinsKey(serverURL)) ?? '[]') as PinnedItem[] }
  catch { return [] }
}
export async function savePins(serverURL: string, pins: PinnedItem[]): Promise<void> {
  await AsyncStorage.setItem(pinsKey(serverURL), JSON.stringify(pins))
}
