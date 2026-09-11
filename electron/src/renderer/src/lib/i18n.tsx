import { useSyncExternalStore } from 'react'
import { getLocale, resolveLocale, setLocale, subscribeLocale, validateLanguagePreference, type LanguagePreference, type Locale } from '@shared/i18n'

export { t } from '@shared/i18n'
export type { LanguagePreference, Locale } from '@shared/i18n'

export const LANGUAGE_STORAGE_KEY = 'agentsdock.language'
const NATIVE_STARTUP_WAIT_MS = 750
type LanguageState = { preference: LanguagePreference; systemLocale: string }
type LanguageSnapshot = { preference: LanguagePreference; saveFailed: boolean }
type LanguageBridge = {
  get(): Promise<LanguageState>
  set(preference: LanguagePreference): Promise<LanguageState>
}

let snapshot: LanguageSnapshot = { preference: 'en', saveFailed: false }
let systemLocale = 'en'
let pendingSave = false
let revision = 0
let initializePromise: Promise<void> | undefined
let stopSynchronization: (() => void) | undefined
let nativeWrites: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function bridge(): LanguageBridge | undefined {
  return window.agentsDock?.language
}

function browserLocale(): string {
  return navigator.languages?.[0] || navigator.language || 'en'
}

function readCache(): { preference: LanguagePreference; pending: boolean } {
  try {
    const value = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (validateLanguagePreference(value)) return { preference: value, pending: true }
    const parsed: unknown = JSON.parse(value || 'null')
    if (parsed && typeof parsed === 'object' && 'preference' in parsed && validateLanguagePreference(parsed.preference)) {
      return { preference: parsed.preference, pending: 'pending' in parsed && parsed.pending === true }
    }
  } catch { /* A denied or corrupt cache must not prevent application startup. */ }
  return { preference: 'en', pending: false }
}

function writeCache(): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, JSON.stringify({ preference: snapshot.preference, pending: pendingSave }))
  } catch { /* Retain the active preference in memory when storage is unavailable. */ }
}

function apply(preference: LanguagePreference, saveFailed = false): void {
  const changed = snapshot.preference !== preference || snapshot.saveFailed !== saveFailed
  snapshot = changed ? { preference, saveFailed } : snapshot
  const resolved = resolveLocale(preference, systemLocale)
  document.documentElement.lang = resolved
  setLocale(resolved)
  if (changed) for (const listener of listeners) listener()
}

function validNativeState(value: unknown): value is LanguageState {
  return Boolean(value && typeof value === 'object'
    && 'preference' in value && validateLanguagePreference(value.preference)
    && 'systemLocale' in value && typeof value.systemLocale === 'string')
}

function applyNative(value: unknown): void {
  if (!validNativeState(value)) return
  if (pendingSave && value.preference !== snapshot.preference) return
  systemLocale = value.systemLocale
  apply(value.preference)
  writeCache()
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => 'en')
}

function subscribePreference(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useLanguagePreference(): LanguageSnapshot & { setPreference: typeof setLanguagePreference } {
  useLocale()
  const value = useSyncExternalStore(subscribePreference, () => snapshot, () => snapshot)
  return { ...value, setPreference: setLanguagePreference }
}

export function setLanguagePreference(preference: LanguagePreference): Promise<void> {
  if (!validateLanguagePreference(preference)) return Promise.resolve()
  const requestRevision = ++revision
  pendingSave = true
  apply(preference)
  writeCache()
  const native = bridge()
  if (!native) return Promise.resolve()
  // Serialize writes so rapid changes cannot leave the saved native preference behind the UI.
  nativeWrites = nativeWrites.then(async () => {
    if (revision !== requestRevision) return
    try {
      const value = await native.set(preference)
      if (revision !== requestRevision) return
      if (!validNativeState(value) || value.preference !== preference) throw new Error('Invalid language preference response')
      pendingSave = false
      applyNative(value)
    } catch {
      if (revision === requestRevision) {
        apply(preference, true)
        writeCache()
      }
    }
  })
  return nativeWrites
}

export function initializeLanguage(): Promise<void> {
  if (initializePromise) return initializePromise
  systemLocale = browserLocale()
  const cached = readCache()
  pendingSave = cached.pending
  apply(cached.preference)

  const onStorage = (event: StorageEvent) => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return
    const value = readCache()
    ++revision
    pendingSave = value.pending
    apply(value.preference)
  }
  const onLanguageChange = () => {
    systemLocale = browserLocale()
    apply(snapshot.preference, snapshot.saveFailed)
    const requestRevision = revision
    void Promise.resolve().then(() => bridge()?.get()).then(value => {
      if (revision === requestRevision) applyNative(value)
    }).catch(() => { /* Browser locale still works when the native bridge is unavailable. */ })
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('languagechange', onLanguageChange)
  let unsubscribeNative: (() => void) | undefined
  try {
    unsubscribeNative = window.agentsDock?.events?.on('app:language', value => {
      if (!pendingSave) ++revision
      applyNative(value)
    })
  }
  catch { /* Older preload bridges may not expose language events. */ }
  stopSynchronization = () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('languagechange', onLanguageChange)
    unsubscribeNative?.()
  }

  const requestRevision = revision
  const native = bridge()
  const synchronize = pendingSave && native
    ? setLanguagePreference(snapshot.preference)
    : Promise.resolve().then(() => native?.get()).then(value => {
      if (revision === requestRevision) applyNative(value)
    }).catch(() => { /* Keep the cache/default if native preferences cannot be read. */ })
  initializePromise = new Promise(resolve => {
    const timer = window.setTimeout(resolve, NATIVE_STARTUP_WAIT_MS)
    void synchronize.finally(() => { window.clearTimeout(timer); resolve() })
  })
  return initializePromise
}

/** Stop window listeners on renderer teardown or hot reload. */
export function disposeLanguage(): void {
  ++revision
  stopSynchronization?.()
  stopSynchronization = undefined
  initializePromise = undefined
}
