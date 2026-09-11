import * as SecureStore from 'expo-secure-store'
import type { AnalyticsEvent, AnalyticsEventProps } from './analytics-events'

export type { AnalyticsEvent }

const LEGACY_DISTINCT_ID_KEY = 'agentsdock.analytics.distinct_id'
let legacyIdCleanup: Promise<void> | null = null

function clearLegacyDistinctId(): Promise<void> {
  if (!legacyIdCleanup) {
    legacyIdCleanup = SecureStore.deleteItemAsync(LEGACY_DISTINCT_ID_KEY).catch(() => undefined)
  }
  return legacyIdCleanup
}

/**
 * iOS and iPadOS do not collect or transmit custom usage events. Keep the
 * one-time cleanup until upgrades from the old consent builds have aged out.
 */
export function trackEvent(_name: AnalyticsEvent, _props?: AnalyticsEventProps): void {
  void clearLegacyDistinctId()
}
