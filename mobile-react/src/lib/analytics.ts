import type { AnalyticsEvent, AnalyticsEventProps } from './analytics-events'

export type { AnalyticsEvent }

// Safe fallback for TypeScript, web, and non-native tooling. Native Android and
// iOS builds resolve analytics.android.ts and analytics.ios.ts respectively.
export function trackEvent(_name: AnalyticsEvent, _props?: AnalyticsEventProps): void {}

export function androidAnalyticsEnabledFromStoredPreference(value: string | null): boolean {
  return value !== 'denied'
}

export async function getAndroidAnalyticsEnabled(): Promise<boolean> {
  return false
}

export async function setAndroidAnalyticsEnabled(_enabled: boolean): Promise<void> {}
