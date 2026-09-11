// Pure, dependency-free Mixpanel payload logic. Kept separate from analytics.ts
// (which imports react-native + native storage) so it can be unit-tested in
// plain Node without native modules.

export const MIXPANEL_TOKEN = '66b4fef625e5750d5527870f0ca96d5e'
// `ip=0` prevents Mixpanel from deriving and retaining geolocation properties
// from the request's source IP address.
export const MIXPANEL_TRACK_URL = 'https://api.mixpanel.com/track?ip=0'

/** The complete set of analytics events tracked on mobile. Mirrors the desktop app. */
export type AnalyticsEvent =
  | 'app_launched'
  | 'terminal_opened'
  | 'file_view_opened'
  | 'job_schedule_opened'
  | 'chat_created'
  | 'chat_opened'
  | 'message_sent'
  | 'digest_opened'
  | 'search_opened'
  | 'open_file_clicked'
  | 'connection_tested'
  | 'server_added'
  | 'server_switched'

export type AnalyticsEventProps = { success?: boolean }

/**
 * Builds the exact JSON array Mixpanel's /track endpoint expects. Pure and
 * argument-driven (no Platform/Date access) so it is deterministic and testable.
 */
export function buildTrackPayload(
  name: AnalyticsEvent,
  platform: string,
  timeSeconds: number,
  props?: AnalyticsEventProps
): Array<{ event: string; properties: Record<string, unknown> }> {
  return [
    {
      event: name,
      properties: {
        token: MIXPANEL_TOKEN,
        distinct_id: '',
        time: timeSeconds,
        platform,
        ...(typeof props?.success === 'boolean' ? { success: props.success } : {})
      }
    }
  ]
}
