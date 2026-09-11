import appConfig from '../../app.json'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { buildTrackPayload, MIXPANEL_TOKEN, MIXPANEL_TRACK_URL } from './analytics-payload'
import { androidAnalyticsEnabledFromStoredPreference, getAndroidAnalyticsEnabled, setAndroidAnalyticsEnabled, trackEvent } from './analytics'

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function setPlatform(os: 'ios' | 'android'): void {
  ;(Platform as unknown as { OS: 'ios' | 'android' }).OS = os
}

// A minimal aggregate event carries only the token, an explicitly blank ID,
// time, and platform.
const minimal = buildTrackPayload('app_launched', 'android', 1_700_000_000)
assertEqual(minimal.length, 1, 'single event')
assertEqual(minimal[0].event, 'app_launched', 'event name')
assertEqual(minimal[0].properties.token, MIXPANEL_TOKEN, 'token')
assertEqual(minimal[0].properties.distinct_id, '', 'blank distinct_id')
assertEqual(minimal[0].properties.time, 1_700_000_000, 'time')
assertEqual(minimal[0].properties.platform, 'android', 'platform')

// Success/failure attributes pass through untouched and arbitrary fields do not.
const withProps = buildTrackPayload('connection_tested', 'android', 1_700_000_001, { success: false })
assertEqual(withProps[0].properties.success, false, 'success attribute')
const rejectedProps = buildTrackPayload('connection_tested', 'android', 1_700_000_002, {
  success: true,
  path: '/private/workspace',
  url: 'file:///private/workspace',
  token: 'secret',
  current_url: 'file:///private/workspace'
} as unknown as { success?: boolean })
assertEqual(
  Object.keys(rejectedProps[0].properties).sort(),
  ['distinct_id', 'platform', 'success', 'time', 'token'],
  'payload rejects non-allow-listed properties'
)

assertEqual(MIXPANEL_TRACK_URL, 'https://api.mixpanel.com/track?ip=0', 'track url disables IP geolocation')
assertEqual(appConfig.expo.ios.privacyManifests.NSPrivacyCollectedDataTypes, [], 'iOS declares no collected analytics data')
assertEqual(appConfig.expo.ios.privacyManifests.NSPrivacyTracking, false, 'iOS cross-app tracking disabled')

// Only the exact legacy denied value opts Android out. Unset or malformed old
// values get the default-on aggregate behavior.
assertEqual(androidAnalyticsEnabledFromStoredPreference(null), true, 'unset Android preference defaults on')
assertEqual(androidAnalyticsEnabledFromStoredPreference('invalid'), true, 'invalid Android preference defaults on')
assertEqual(androidAnalyticsEnabledFromStoredPreference('granted'), true, 'legacy grant remains on')
assertEqual(androidAnalyticsEnabledFromStoredPreference('denied'), false, 'explicit denial remains off')

await AsyncStorage.clear()
;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
await SecureStore.setItemAsync('agentsdock.analytics.distinct_id', 'legacy-install-id')
const requests: Array<{ input: string; body: string }> = []
let hangNextRequest = false
let abortedRequests = 0
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests.push({ input: String(input), body: String(init?.body ?? '') })
  if (hangNextRequest) {
    hangNextRequest = false
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        abortedRequests += 1
        reject(new Error('aborted'))
      }, { once: true })
    })
  }
  return { ok: true } as Response
}) as typeof fetch

async function flushAnalytics(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

// iOS performs migration cleanup but never sends a custom analytics request.
setPlatform('ios')
trackEvent('app_launched')
await flushAnalytics()
assertEqual(requests.length, 0, 'iOS sends no Mixpanel event')
assertEqual(await getAndroidAnalyticsEnabled(), false, 'analytics API is hard-disabled on iOS')
assertEqual(await SecureStore.getItemAsync('agentsdock.analytics.distinct_id'), null, 'legacy analytics ID is removed')

// Android is enabled by default and sends ID-less aggregate events.
setPlatform('android')
assertEqual(await getAndroidAnalyticsEnabled(), true, 'Android starts enabled when no choice is stored')
trackEvent('app_launched')
await flushAnalytics()
assertEqual(requests.length, 1, 'default-on Android event sent')
assertEqual(requests[0].input, MIXPANEL_TRACK_URL, 'Android event uses privacy-safe endpoint')
assertEqual(JSON.parse(requests[0].body)[0].properties.distinct_id, '', 'Android request has blank distinct_id')

// Opting out persists independently, aborts work already in flight, and blocks
// later events while preserving the legacy explicit-denial value.
hangNextRequest = true
trackEvent('terminal_opened')
await flushAnalytics()
assertEqual(requests.length, 2, 'hung Android request started while enabled')
const optOut = setAndroidAnalyticsEnabled(false)
let deadline: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    optOut,
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('opt-out waited behind analytics network I/O')), 250)
    })
  ])
} finally {
  if (deadline) clearTimeout(deadline)
}
assertEqual(abortedRequests, 1, 'Android opt-out aborts hung analytics requests')
assertEqual(await AsyncStorage.getItem('agentsdock.analytics.consent.v1'), 'denied', 'Android opt-out persists')
trackEvent('message_sent')
await flushAnalytics()
assertEqual(requests.length, 2, 'Android opt-out blocks future events')

// A stale Android preference can never bypass the platform gate after the app
// is running as iOS.
await setAndroidAnalyticsEnabled(true)
setPlatform('ios')
trackEvent('chat_opened')
await flushAnalytics()
assertEqual(requests.length, 2, 'iOS remains disabled after Android is enabled')

console.log('analytics payload regressions passed')
