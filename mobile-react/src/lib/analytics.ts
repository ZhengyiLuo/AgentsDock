import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { buildTrackPayload, MIXPANEL_TRACK_URL, type AnalyticsEvent, type AnalyticsEventProps } from './analytics-payload'

// Lightweight, dependency-free Mixpanel client for Android. The iOS app never
// sends custom analytics. Android sends explicit app-owned aggregate payloads
// directly to Mixpanel, without a persistent or generated analytics ID.
//
// Privacy note: this app handles other people's server credentials and private
// code. NEVER pass IP addresses, hostnames, access tokens, chat/message
// content, or file names/contents into trackEvent props. These events only
// signal that a UI action happened - nothing about its content.

export type { AnalyticsEvent }

export const ANALYTICS_PRIVACY_POLICY_URL = 'https://agentsdock.net/privacy.html'

// Keep the existing key so an explicit choice from earlier releases survives
// the migration. Missing and malformed values use the new Android default.
const PREFERENCE_KEY = 'agentsdock.analytics.consent.v1'
const LEGACY_DISTINCT_ID_KEY = 'agentsdock.analytics.distinct_id'
const TRACK_TIMEOUT_MS = 10_000

let androidAnalyticsEnabled: boolean | null = null
let preferenceRead: Promise<boolean> | null = null
let preferenceRevision = 0
let analyticsQueue: Promise<void> = Promise.resolve()
let preferencePersistenceQueue: Promise<void> = Promise.resolve()
let legacyIdCleanup: Promise<void> | null = null
const inFlightRequests = new Set<AbortController>()

function clearLegacyDistinctId(): Promise<void> {
  if (!legacyIdCleanup) {
    legacyIdCleanup = SecureStore.deleteItemAsync(LEGACY_DISTINCT_ID_KEY).catch(() => undefined)
  }
  return legacyIdCleanup
}

function enqueueAnalytics(operation: () => Promise<void>): Promise<void> {
  const next = analyticsQueue.then(operation, operation)
  analyticsQueue = next.catch(() => undefined)
  return next
}

export function androidAnalyticsEnabledFromStoredPreference(value: string | null): boolean {
  return value !== 'denied'
}

export async function getAndroidAnalyticsEnabled(): Promise<boolean> {
  await clearLegacyDistinctId()
  if (Platform.OS !== 'android') return false
  if (androidAnalyticsEnabled !== null) return androidAnalyticsEnabled
  if (!preferenceRead) {
    const readRevision = preferenceRevision
    preferenceRead = (async () => {
      let enabled = true
      try {
        enabled = androidAnalyticsEnabledFromStoredPreference(await AsyncStorage.getItem(PREFERENCE_KEY))
      } catch {
        // Storage failures are treated like an unset preference on Android.
      }
      if (readRevision === preferenceRevision && androidAnalyticsEnabled === null) {
        androidAnalyticsEnabled = enabled
      }
      return androidAnalyticsEnabled ?? enabled
    })()
  }
  return preferenceRead
}

export async function setAndroidAnalyticsEnabled(enabled: boolean): Promise<void> {
  if (Platform.OS !== 'android') {
    for (const controller of inFlightRequests) controller.abort()
    inFlightRequests.clear()
    await clearLegacyDistinctId()
    return
  }

  // Apply an opt-out synchronously before touching native storage. A slow or
  // unavailable SecureStore migration must never leave collection enabled.
  androidAnalyticsEnabled = enabled
  preferenceRevision += 1
  if (!enabled) {
    for (const controller of inFlightRequests) controller.abort()
    inFlightRequests.clear()
  }

  const cleanup = clearLegacyDistinctId()
  const persist = () => AsyncStorage.setItem(PREFERENCE_KEY, enabled ? 'granted' : 'denied').catch(() => undefined)
  const persisted = preferencePersistenceQueue.then(persist, persist)
  preferencePersistenceQueue = persisted.then(() => undefined, () => undefined)
  await Promise.all([cleanup, persisted])
}

/**
 * Fire-and-forget Android analytics. iOS returns before queueing or issuing a
 * request. Network failures never affect the app.
 */
export function trackEvent(name: AnalyticsEvent, props?: AnalyticsEventProps): void {
  void clearLegacyDistinctId()
  if (Platform.OS !== 'android') return

  const invokedRevision = preferenceRevision
  void enqueueAnalytics(async () => {
    try {
      if (!await getAndroidAnalyticsEnabled()) return
      if (invokedRevision !== preferenceRevision) return
      const payload = buildTrackPayload(name, 'android', Math.floor(Date.now() / 1000), props)
      const controller = new AbortController()
      inFlightRequests.add(controller)
      const timeout = setTimeout(() => controller.abort(), TRACK_TIMEOUT_MS)
      const finish = () => {
        clearTimeout(timeout)
        inFlightRequests.delete(controller)
      }
      try {
        void fetch(MIXPANEL_TRACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        }).catch(() => undefined).finally(finish)
      } catch {
        finish()
      }
    } catch {
      /* analytics is best-effort; swallow all errors */
    }
  })
}
