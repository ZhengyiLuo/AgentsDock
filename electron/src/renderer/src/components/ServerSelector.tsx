// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, LoaderCircle, Plus, Settings } from 'lucide-react'
import type { PublicServerProfile, ServerConnectionState } from '@shared/types'
import { trackEvent } from '../lib/analytics'
import { useAppStore } from '../store/app-store'
import { ShortcutTooltip } from './ShortcutTooltip'

export const ADD_SERVER_EVENT = 'agentsdock:add-server'
export const MANAGE_SERVERS_EVENT = 'agentsdock:manage-servers'

export function ServerSelector() {
  useLocale()
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const healthVersion = useAppStore(state => state.health?.server_version)
  const healthIdentity = useAppStore(state => state.health?.server_identity)
  const switchServer = useAppStore(state => state.switchServer)
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0] ?? null
  const switchingProfile = profiles.find(profile => profile.id === switchingProfileId) ?? null
  const activeHost = active ? profileHostSubtitle(active) : null
  const activeVersion = ((!switchingProfileId && active?.id === activeProfileId && active?.serverIdentity && active.serverIdentity === healthIdentity
    ? healthVersion : null) || active?.serverVersion)?.trim() || null

  const chooseProfile = (profileId: string) => {
    if (profileId === activeProfileId || profileId === switchingProfileId) return
    void Promise.resolve(switchServer(profileId)).then(switched => {
      if (!switched || useAppStore.getState().activeProfileId !== profileId) return
      trackEvent('server_switched', { success: true })
    }).catch(error => {
      trackEvent('server_switched', { success: false })
      useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
    })
  }
  const openServerSettings = () => {
    window.dispatchEvent(new CustomEvent('agentsdock:app-settings-section', { detail: 'server' }))
    useAppStore.getState().setModal('appSettings', true)
  }
  const addServer = () => {
    window.dispatchEvent(new Event(ADD_SERVER_EVENT))
    openServerSettings()
  }
  const manageServers = () => {
    window.dispatchEvent(new Event(MANAGE_SERVERS_EVENT))
    openServerSettings()
  }

  return <>
    <DropdownMenu.Root>
      <ShortcutTooltip label={t("ui.ServerSelector.ServerSelector.switch_server_6fb2a18")} shortcut={['previousServer', 'nextServer']} side="right"><DropdownMenu.Trigger className="server-selector-trigger" disabled={Boolean(switchingProfileId)} aria-label={switchingProfile
        ? t("ui.ServerSelector.ServerSelector.switching_to_please_wait_4563ec6", { "server": String(switchingProfile.name) })
        : active
          ? t("ui.ServerSelector.ServerSelector.choose_agentsserver_35d4c4a", { "server": String(active.name), "state": String(profileConnectionLabel(active)), "unread": active.cachedUnreadCount ? t('ui.server.unreadSuffix', { count: active.cachedUnreadCount }) : '' })
          : t("ui.ServerSelector.ServerSelector.choose_agentsserver_6c6e836")}>
        <ConnectionDot state={active?.connectionState ?? 'cached'} label={active ? profileConnectionLabel(active) : undefined} />
        <span className="server-selector-copy">
          <strong>{active?.name || t("ui.ServerSelector.ServerSelector.choose_server_389e87e")}</strong>
          {(activeHost || activeVersion) && <small className="server-selector-metadata">
            {activeHost && <span className="server-selector-host" title={activeHost}>{activeHost}</span>}
            {activeVersion && <span className="server-selector-version" title={`AgentsServer v${activeVersion}`}>v{activeVersion}</span>}
          </small>}
        </span>
        {active && active.cachedUnreadCount > 0 && <UnreadBadge count={active.cachedUnreadCount} />}
        {switchingProfileId ? <LoaderCircle className="spin server-selector-spinner" size={13} /> : <ChevronDown size={13} />}
      </DropdownMenu.Trigger></ShortcutTooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu-content server-selector-menu" align="start" sideOffset={5} collisionPadding={10}>
          <DropdownMenu.Label className="menu-label">{t("ui.ServerSelector.ServerSelector.servers_68d7beb")}</DropdownMenu.Label>
          {profiles.map(profile => {
            const current = profile.id === activeProfileId
            const switching = profile.id === switchingProfileId
            const host = profileHostSubtitle(profile)
            return <DropdownMenu.Item
              className={`server-profile-item${current ? ' active' : ''}${switching ? ' switching' : ''}`}
              key={profile.id}
              onSelect={() => chooseProfile(profile.id)}
              aria-current={current ? 'true' : undefined}
            >
              <ConnectionDot state={switching ? 'connecting' : profile.connectionState} label={switching ? t("ui.ServerSelector.connecting_d403c68") : profileConnectionLabel(profile)} />
              <span className="server-profile-copy">
                <strong>{profile.name}</strong>
                {host && <small>{host}</small>}
              </span>
              {profile.cachedUnreadCount > 0 && <UnreadBadge count={profile.cachedUnreadCount} />}
              {switching ? <LoaderCircle className="spin server-profile-mark" size={13} /> : current ? <Check className="server-profile-mark" size={14} /> : null}
            </DropdownMenu.Item>
          })}
          {!profiles.length && <DropdownMenu.Label className="server-selector-empty">{t("ui.ServerSelector.ServerSelector.no_saved_servers_b03b0d0")}</DropdownMenu.Label>}
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" onSelect={addServer}><Plus size={14} />{t("ui.ServerSelector.ServerSelector.add_server_da8993e")}</DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={manageServers}><Settings size={14} />{t("ui.ServerSelector.ServerSelector.server_settings_f2c21fe")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {switchingProfile && <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{t("ui.ServerSelector.ServerSelector.switching_to_please_wait_4563ec6", { server: switchingProfile.name })}</span>}
  </>
}

function ConnectionDot({ state, label = connectionStateLabel(state) }: { state: ServerConnectionState; label?: string }) {
  useLocale()
  return <span className={`server-connection-dot ${state}`} title={label} role="img" aria-label={label} />
}

function UnreadBadge({ count }: { count: number }) {
  useLocale()
  const label = count > 99 ? '99+' : String(count)
  return <span className="server-unread-badge" aria-label={t(count === 1 ? 'ui.server.unreadOne' : 'ui.server.unreadMany', { count })}>{label}</span>
}

export function profileHostSubtitle(profile: Pick<PublicServerProfile, 'name' | 'serverUrl' | 'serverIdentity'>): string | null {
  const host = serverProfileHost(profile.serverUrl)
  if (!host) return null
  const normalizedHost = host.toLocaleLowerCase()
  if (profile.name.trim().toLocaleLowerCase() === normalizedHost) return null
  if (profile.serverIdentity?.trim().toLocaleLowerCase() === normalizedHost) return null
  return host
}

export function serverProfileHost(serverUrl: string): string | null {
  try { return new URL(serverUrl).host || null } catch { return null }
}

export function connectionStateLabel(state: ServerConnectionState): string {
  if (state === 'online') return t("ui.ServerSelector.connectionStateLabel.online_0d21bd5")
  if (state === 'degraded') return t("ui.ServerSelector.connectionStateLabel.degraded_a8494c1")
  if (state === 'connecting') return t("ui.ServerSelector.connectionStateLabel.connecting_d403c68")
  if (state === 'retrying') return t("ui.ServerSelector.connectionStateLabel.retrying_f8fe6f8")
  if (state === 'offline') return t("ui.ServerSelector.connectionStateLabel.offline_a179478")
  return t("ui.ServerSelector.connectionStateLabel.cached_a251c18")
}

function profileConnectionLabel(profile: PublicServerProfile): string {
  if (profile.lastConnectionError && /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|access token|bad token|invalid token)\b/i.test(profile.lastConnectionError)) {
    return t("ui.ServerSelector.profileConnectionLabel.authentication_required_732c522")
  }
  if (profile.connectionState === 'degraded' && profile.lastConnectionError) return t("ui.ServerSelector.profileConnectionLabel.degraded_b6e4a5f", { "detail": String(profile.lastConnectionError) })
  return connectionStateLabel(profile.connectionState)
}
