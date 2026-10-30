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
export const ANALYTICS_BACKENDS = ['codex', 'claude', 'cursor', 'opencode', 'gemini'] as const
export type AnalyticsEventProps = { success?: boolean; backend?: typeof ANALYTICS_BACKENDS[number]; connection_kind?: 'default' | 'custom_api' }

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
  // Shared web installs its restricted bridge after module imports. Recheck
  // this boundary on every event, even if an early import cached "granted".
  // CI's disposable packaged-app smoke profiles use the same disabled flag.
  if (window.agentsDock?.native?.analyticsDisabled) {
    if (runtimeDecision !== 'denied') clearAnalyticsIdentifier()
    runtimeDecision = 'denied'
    return 'denied'
  }
  if (!runtimeDecision) {
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

const BACKEND_EVENTS = new Set<string>([
  'chat_created', 'chat_resumed', 'message_sent', 'message_queued', 'message_steered',
  'provider_connection_tested', 'provider_connection_saved', 'provider_connection_forgotten',
  'provider_default_model_saved', 'chat_agent_changed', 'chat_model_changed',
  'chat_permission_mode_changed', 'imported_chat_api_connected'
])

function safeEventProps(name: AnalyticsEvent, props?: AnalyticsEventProps): Record<string, boolean | string> {
  const safe: Record<string, boolean | string> = typeof props?.success === 'boolean' ? { success: props.success } : {}
  // A provider family is not an API endpoint, account, custom model or profile.
  // Unknown values and backend metadata on unrelated events are dropped.
  if (BACKEND_EVENTS.has(name) && props?.backend && ANALYTICS_BACKENDS.includes(props.backend)) safe.backend = props.backend
  if (name === 'message_sent' && (props?.connection_kind === 'default' || props?.connection_kind === 'custom_api')) {
    safe.connection_kind = props.connection_kind
  }
  return safe
}

/** The complete set of analytics events tracked in this app. Extend deliberately. */
export const ANALYTICS_EVENTS = [
  'app_launched',
  'terminal_opened',
  'file_view_opened',
  'job_schedule_opened',
  'scheduled_job_created',
  'scheduled_job_updated',
  'scheduled_job_deleted',
  'scheduled_job_paused',
  'scheduled_job_resumed',
  'scheduled_job_run_requested',
  'scheduled_job_run_cancelled',
  'chat_created',
  'chat_agent_changed',
  'chat_model_changed',
  'chat_permission_mode_changed',
  'imported_chat_api_connected',
  'chat_archived',
  'chat_unarchived',
  'workspace_files_opened',
  'file_open_requested',
  'language_changed',
  'chat_font_changed',
  'error_details_copied',
  'issue_report_opened',
  'server_restart_requested',
  'server_restart_reconnected',
  'chats_bulk_imported',
  'chat_resumed',
  'chat_opened',
  'chat_share_opened',
  'chat_share_snapshot_selected',
  'chat_share_interactive_selected',
  'chat_share_snapshot_created',
  'chat_share_interactive_created',
  'chat_share_revoked',
  'split_view_opened',
  'chat_forked',
  'chat_reordered',
  'team_network_opened',
  'message_sent',
  'message_queued',
  'message_steered',
  'side_chat_opened',
  'side_chat_message_submitted',
  'side_chat_stop_requested',
  'provider_settings_opened',
  'provider_connection_tested',
  'provider_connection_saved',
  'provider_connection_forgotten',
  'provider_default_model_saved',
  'goal_saved',
  'goal_cleared',
  'goal_paused',
  'goal_resumed',
  'workspace_file_saved',
  'workspace_changes_opened',
  'workspace_git_staged',
  'workspace_git_unstaged',
  'workspace_git_committed',
  'workspace_git_conflict_resolved',
  'workspace_git_continued',
  'workspace_git_aborted',
  'attachment_uploaded',
  'app_update_checked',
  'app_update_channel_changed',
  'app_update_install_requested',
  'app_update_cancelled',
  'server_update_checked',
  'server_update_requested',
  'server_update_now_requested',
  'server_update_cancelled',
  'server_update_retry_requested',
  'slash_skill_used',
  'slash_command_used',
  'builtin_slash_command_used',
  'chat_reference_sent',
  'team_reference_sent',
  'folder_created',
  'folder_deleted',
  'folder_reordered',
  'chat_moved_to_folder',
  'working_directory_changed',
  'digest_opened',
  'search_opened',
  'open_file_clicked',
  'connection_tested',
  'server_added',
  'server_switched'
] as const

export type AnalyticsEvent = typeof ANALYTICS_EVENTS[number]

/** One explicit operation, not a subscription/replay. Never serialize its input,
 * result or error; success means this request resolved, not eventual completion. */
export async function trackOperation<T>(
  name: AnalyticsEvent,
  operation: () => Promise<T>,
  succeeded: (result: T) => boolean = () => true,
  props?: Pick<AnalyticsEventProps, 'backend'>
): Promise<T> {
  try {
    const result = await operation()
    trackEvent(name, { ...props, success: succeeded(result) })
    return result
  } catch (error) {
    trackEvent(name, { ...props, success: false })
    throw error
  }
}

export function trackEvent(name: AnalyticsEvent, props?: AnalyticsEventProps): void {
  if (!ANALYTICS_EVENTS.includes(name)) return
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
      ...safeEventProps(name, props)
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
