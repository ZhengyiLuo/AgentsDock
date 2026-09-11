// AgentsDock sends a small, app-owned payload directly to Mixpanel. Do not add
// a browser analytics SDK here: SDK defaults can inject URLs, referrers, screen
// details, user-agent data, marketing fields, or DOM state that this app must
// never collect.

const MIXPANEL_TOKEN = '66b4fef625e5750d5527870f0ca96d5e'
const MIXPANEL_TRACK_URL = 'https://api.mixpanel.com/track?ip=0'
const CONSENT_STORAGE_KEY = 'agentsdock:analytics-consent:v1'
const DISTINCT_ID_STORAGE_KEY = 'agentsdock:analytics-distinct-id:v1'
const LEGACY_MIXPANEL_PERSISTENCE_KEY = `mp_${MIXPANEL_TOKEN}_mixpanel`
const LEGACY_MIXPANEL_OPT_IN_OUT_KEY = `__mp_opt_in_out_${MIXPANEL_TOKEN}`
const TRACK_TIMEOUT_MS = 10_000

export const ANALYTICS_PRIVACY_POLICY_URL = 'https://agentsdock.net/privacy.html'
export const ANALYTICS_CONSENT_CHANGED_EVENT = 'agentsdock:analytics-consent-changed'

export type AnalyticsConsentDecision = 'granted' | 'denied'
export type AnalyticsEventProps = { success?: boolean }

let runtimeDecision: AnalyticsConsentDecision | null = null
let consentRevision = 0
const inFlightRequests = new Set<AbortController>()

function removeStoredItem(key: string): void {
  try { window.localStorage.removeItem(key) } catch { /* best effort */ }
}

function clearAnalyticsIdentifier(): void {
  removeStoredItem(DISTINCT_ID_STORAGE_KEY)
}

function clearLegacyMixpanelPersistence(): void {
  removeStoredItem(LEGACY_MIXPANEL_PERSISTENCE_KEY)
  removeStoredItem(LEGACY_MIXPANEL_OPT_IN_OUT_KEY)
  try {
    document.cookie = `${LEGACY_MIXPANEL_PERSISTENCE_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`
  } catch {
    // Some packaged origins do not expose cookie storage.
  }
}

export function getAnalyticsConsentDecision(): AnalyticsConsentDecision {
  if (!runtimeDecision) {
    // CI's packaged-app smoke-test launches run the real binary with a
    // fresh, disposable user-data directory on every run, so they would
    // otherwise mint and report a brand-new anonymous install id each time.
    if (window.agentsDock?.native?.analyticsDisabled) {
      runtimeDecision = 'denied'
      return runtimeDecision
    }
    try {
      const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY)
      // Anonymous aggregate analytics is enabled by default. Preserve an
      // explicit opt-out from an earlier version, but do not interrupt new
      // users with a consent gate.
      runtimeDecision = stored === 'denied' ? 'denied' : 'granted'
    } catch {
      runtimeDecision = 'granted'
    }
  }
  return runtimeDecision
}

export function setAnalyticsConsent(enabled: boolean): void {
  runtimeDecision = enabled ? 'granted' : 'denied'
  consentRevision += 1
  try { window.localStorage.setItem(CONSENT_STORAGE_KEY, runtimeDecision) } catch { /* best effort */ }

  if (!enabled) {
    for (const controller of inFlightRequests) controller.abort()
    inFlightRequests.clear()
    clearAnalyticsIdentifier()
    clearLegacyMixpanelPersistence()
  }
  window.dispatchEvent(new CustomEvent(ANALYTICS_CONSENT_CHANGED_EVENT, { detail: { enabled } }))
}

function generateDistinctId(): string {
  try {
    if (typeof crypto === 'object' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch { /* fall through to the non-crypto path below */ }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

// Returns a stable, anonymous, per-install identifier so unique-installation and
// retention counts are possible on desktop. It is a random value with no link to
// the user's name, account, machine, or content, kept only in this app's local
// storage and deleted on opt-out. Desktop only - Android stays identifier-free
// and iOS sends no analytics at all.
function getOrCreateDistinctId(): string {
  try {
    const existing = window.localStorage.getItem(DISTINCT_ID_STORAGE_KEY)
    if (existing) return existing
  } catch { /* fall through and mint a fresh id */ }
  const fresh = generateDistinctId()
  try { window.localStorage.setItem(DISTINCT_ID_STORAGE_KEY, fresh) } catch { /* best effort; still send this session */ }
  return fresh
}

function desktopPlatform(): 'mac' | 'windows' | 'linux' | 'desktop' {
  const agent = typeof navigator === 'object' ? navigator.userAgent : ''
  if (/Mac|Macintosh|Mac OS/.test(agent)) return 'mac'
  if (/Windows/.test(agent)) return 'windows'
  if (/Linux/.test(agent)) return 'linux'
  return 'desktop'
}

function safeEventProps(props?: AnalyticsEventProps): Record<string, boolean> {
  return typeof props?.success === 'boolean' ? { success: props.success } : {}
}

/** The complete set of analytics events tracked in this app. Extend deliberately. */
export type AnalyticsEvent =
  | 'app_launched'
  | 'terminal_opened'
  | 'file_view_opened'
  | 'job_schedule_opened'
  | 'chat_created'
  | 'chats_bulk_imported'
  | 'chat_opened'
  | 'message_sent'
  | 'digest_opened'
  | 'search_opened'
  | 'open_file_clicked'
  | 'connection_tested'
  | 'server_added'
  | 'server_switched'

export function trackEvent(name: AnalyticsEvent, props?: AnalyticsEventProps): void {
  const invokedRevision = consentRevision
  if (getAnalyticsConsentDecision() !== 'granted') return
  if (invokedRevision !== consentRevision) return
  if (runtimeDecision !== 'granted') return

  const payload = [{
    event: name,
    properties: {
      token: MIXPANEL_TOKEN,
      // Anonymous, per-install identifier so unique installs and retention can be
      // measured. Created only after consent (checked above) and removed on opt-out.
      distinct_id: getOrCreateDistinctId(),
      time: Math.floor(Date.now() / 1000),
      platform: desktopPlatform(),
      ...safeEventProps(props)
    }
  }]
  const controller = new AbortController()
  inFlightRequests.add(controller)
  const clearRequestTimeout = window.clearTimeout.bind(window)
  const timeout = window.setTimeout(() => controller.abort(), TRACK_TIMEOUT_MS)
  const finish = () => {
    clearRequestTimeout(timeout)
    inFlightRequests.delete(controller)
  }
  try {
    void fetch(MIXPANEL_TRACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    }).catch(() => undefined).finally(finish)
  } catch {
    finish()
  }
}

// Clean up the old mixpanel-browser SDK state without initializing analytics or
// making a network request. The per-install identifier is intentionally kept so
// it persists across sessions - except when the user has opted out, in which
// case no identifier should linger on disk.
clearLegacyMixpanelPersistence()
if (getAnalyticsConsentDecision() === 'denied') clearAnalyticsIdentifier()
