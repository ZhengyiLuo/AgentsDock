// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, LoaderCircle, Pencil, Plus, Server, Trash2, Wifi } from 'lucide-react'
import type { Health, PublicServerProfile } from '@shared/types'
import { normalizeServerURL } from '@shared/server-url'
import { trackEvent } from '../lib/analytics'
import { useAppStore } from '../store/app-store'

interface ServerDraft {
  profileId: string | null
  name: string
  serverUrl: string
  accessToken: string
  clearAccessToken: boolean
  resetServerIdentity: boolean
}

const emptyDraft = (): ServerDraft => ({
  profileId: null,
  name: '',
  serverUrl: '',
  accessToken: '',
  clearAccessToken: false,
  resetServerIdentity: false
})

export function ServerManagement({ addRequest = 0, manageRequest = 0 }: { addRequest?: number; manageRequest?: number }) {
  useLocale()
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const switchServer = useAppStore(state => state.switchServer)
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [testedHealth, setTestedHealth] = useState<Health | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [activationError, setActivationError] = useState<{ profileId: string; message: string } | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const testLease = useRef(0)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const revealEditor = useRef(false)

  const openEditor = (next: ServerDraft) => {
    revealEditor.current = true
    setDraft(next)
  }

  const editedProfile = useMemo(
    () => profiles.find(profile => profile.id === draft?.profileId) ?? null,
    [draft?.profileId, profiles, getLocale()]
  )
  const duplicateTestProfile = useMemo(
    () => testedHealth?.server_identity
      ? profiles.find(profile => profile.serverIdentity === testedHealth.server_identity) ?? null
      : null,
    [profiles, testedHealth?.server_identity, getLocale()]
  )

  useEffect(() => {
    if (addRequest > 0) {
      testLease.current += 1
      setBusy(null)
      openEditor(emptyDraft())
      setTestedHealth(null)
      setTestError(null)
    }
  }, [addRequest])
  useEffect(() => {
    if (manageRequest > 0) {
      testLease.current += 1
      setBusy(null)
      setDraft(null)
      setTestedHealth(null)
      setTestError(null)
    }
  }, [manageRequest])
  useEffect(() => {
    if (!draft || !revealEditor.current) return
    revealEditor.current = false
    editorRef.current?.scrollIntoView?.({ block: 'nearest' })
    nameInputRef.current?.focus({ preventScroll: true })
  }, [draft])

  const beginEdit = (profile: PublicServerProfile) => {
    openEditor({
      profileId: profile.id,
      name: profile.name,
      serverUrl: profile.serverUrl,
      accessToken: '',
      clearAccessToken: false,
      resetServerIdentity: false
    })
    setTestedHealth(null)
    setTestError(null)
    setConfirmRemoveId(null)
  }

  const refreshProfiles = async () => {
    const next = await window.agentsDock.servers.list()
    useAppStore.setState({ profiles: next })
    return next
  }

  const invalidateTest = () => {
    testLease.current += 1
    setTestedHealth(null)
    setTestError(null)
    if (busy === 'test') setBusy(null)
  }

  const updateDraft = (patch: Partial<ServerDraft>, invalidatesConnectionTest = false) => {
    if (invalidatesConnectionTest) invalidateTest()
    setDraft(current => current ? { ...current, ...patch } : current)
  }

  const save = async () => {
    if (!draft?.serverUrl.trim()) return
    let addAttempted = false
    let addCompleted = false
    if (!draft.profileId && !testedHealth?.ok) {
      const detail = 'Test this connection successfully before adding the server.'
      setTestError(detail)
      useAppStore.getState().setError(detail)
      return
    }
    testLease.current += 1
    setBusy('save')
    setTestError(null)
    try {
      if (draft.profileId) {
        if (!editedProfile) throw new Error('This server profile no longer exists.')
        const name = draft.name.trim() || editedProfile.name
        const serverUrl = normalizeServerURL(draft.serverUrl)
        const accessToken = draft.clearAccessToken ? null : draft.accessToken || undefined
        const patch = {
          ...(name !== editedProfile.name ? { name } : {}),
          ...(serverUrl !== editedProfile.serverUrl ? { serverUrl } : {}),
          ...(accessToken !== undefined ? { accessToken } : {}),
          ...(draft.resetServerIdentity ? { resetServerIdentity: true } : {})
        }
        const connectionChanged = patch.serverUrl !== undefined || patch.accessToken !== undefined || patch.resetServerIdentity
        const current = useAppStore.getState()
        if (current.switchingProfileId) throw new Error('Wait for the current server switch to finish, then save again.')
        if (draft.profileId === current.activeProfileId && connectionChanged) {
          const generation = current.profileGeneration
          const switched = await switchServer(draft.profileId, true, patch)
          const reopened = useAppStore.getState()
          if (!switched || reopened.activeProfileId !== draft.profileId || reopened.profileGeneration <= generation) {
            throw new Error('The updated server could not be reopened safely.')
          }
        } else {
          if (Object.keys(patch).length) await window.agentsDock.servers.update(draft.profileId, patch)
          await refreshProfiles()
        }
      } else {
        if (duplicateTestProfile) {
          const switched = await switchServer(duplicateTestProfile.id)
          if (!switched || useAppStore.getState().activeProfileId !== duplicateTestProfile.id) {
            throw new Error(`AgentsDock could not activate the existing “${duplicateTestProfile.name}” profile.`)
          }
          setDraft(null)
          setTestedHealth(null)
          return
        }
        addAttempted = true
        const added = await window.agentsDock.servers.add({
          name: draft.name.trim() || undefined,
          serverUrl: draft.serverUrl.trim(),
          accessToken: draft.accessToken || undefined,
          serverIdentity: testedHealth?.server_identity ?? null,
          serverSetupComplete: true
        })
        addCompleted = true
        trackEvent('server_added', { success: true })
        await refreshProfiles()
        setDraft(current => current ? { ...current, profileId: added.id } : current)
        const switched = await switchServer(added.id)
        if (!switched || useAppStore.getState().activeProfileId !== added.id) throw new Error(`“${added.name}” was saved, but AgentsDock could not switch to it.`)
      }
      setDraft(null)
      setTestedHealth(null)
    } catch (error) {
      if (addAttempted && !addCompleted) trackEvent('server_added', { success: false })
      const detail = errorMessage(error)
      setTestError(detail)
      useAppStore.getState().setError(detail)
    } finally {
      setBusy(null)
    }
  }

  const testConnection = async () => {
    if (!draft?.serverUrl.trim()) return
    const request = ++testLease.current
    const testedDraft = { ...draft }
    setBusy('test')
    setTestedHealth(null)
    setTestError(null)
    try {
      const health = await window.agentsDock.servers.testConnection({
        profileId: testedDraft.profileId ?? undefined,
        serverUrl: testedDraft.serverUrl.trim(),
        accessToken: testedDraft.clearAccessToken ? null : testedDraft.accessToken || undefined
      })
      if (health.ok !== true) throw new Error('Server health check reported unavailable.')
      trackEvent('connection_tested', { success: true })
      if (request === testLease.current) setTestedHealth(health)
    } catch (error) {
      trackEvent('connection_tested', { success: false })
      if (request === testLease.current) setTestError(errorMessage(error))
    } finally {
      if (request === testLease.current) setBusy(null)
    }
  }

  const move = async (profileId: string, direction: -1 | 1) => {
    const index = profiles.findIndex(profile => profile.id === profileId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= profiles.length) return
    const order = profiles.map(profile => profile.id)
    ;[order[index], order[target]] = [order[target], order[index]]
    setBusy(`move:${profileId}`)
    try {
      const next = await window.agentsDock.servers.reorder(order)
      useAppStore.setState({ profiles: next })
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const activate = async (profileId: string) => {
    if (profileId === activeProfileId || switchingProfileId) return
    setActivationError(null)
    setBusy(`switch:${profileId}`)
    try {
      const switched = await switchServer(profileId)
      if (!switched || useAppStore.getState().activeProfileId !== profileId) throw new Error('The requested server was not activated.')
      trackEvent('server_switched', { success: true })
      useAppStore.getState().setModal('settings', false)
      useAppStore.getState().setModal('appSettings', false)
    } catch (error) {
      trackEvent('server_switched', { success: false })
      const detail = errorMessage(error)
      setActivationError({ profileId, message: detail })
      useAppStore.getState().setError(detail)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (profile: PublicServerProfile) => {
    if (profile.id === activeProfileId) return
    if (confirmRemoveId !== profile.id) {
      setConfirmRemoveId(profile.id)
      return
    }
    setBusy(`remove:${profile.id}`)
    try {
      await window.agentsDock.servers.remove(profile.id)
      await refreshProfiles()
      if (draft?.profileId === profile.id) setDraft(null)
      setConfirmRemoveId(null)
    } catch (error) {
      useAppStore.getState().setError(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  return <section className="server-management" aria-label={t("ui.ServerManagement.ServerManagement.saved_servers_4bf0848")}>
    <div className="server-management-heading">
      <div><strong>{t("ui.ServerManagement.ServerManagement.servers_68d7beb")}</strong><small>{t("ui.ServerManagement.ServerManagement.each_server_keeps_its_own_chats_drafts_fil_35087b7")}</small></div>
      <button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => { invalidateTest(); openEditor(emptyDraft()) }}><Plus size={13} />{" "}{t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</button>
    </div>
    <div className="server-management-list">
      {profiles.map((profile, index) => {
        const current = profile.id === activeProfileId
        const working = busy === `switch:${profile.id}` || switchingProfileId === profile.id
        const rowActivationError = activationError?.profileId === profile.id ? activationError.message : null
        const details = [profile.serverIdentity ? t("ui.ServerManagement.identity_96fbbb0", { "id": String(profile.serverIdentity) }) : '', profile.serverVersion ? `AgentsServer ${profile.serverVersion}` : ''].filter(Boolean).join(' · ')
        return <div className={`server-management-row${current ? ' active' : ''}`} key={profile.id}>
          <span className={`server-connection-dot ${profile.connectionState}`} title={connectionLabel(profile)} role="img" aria-label={connectionLabel(profile)} />
          <div className="server-management-copy">
            <strong>{profile.name}{current && <span>{t("ui.ServerManagement.active_9234069")}</span>}</strong>
            <small>{profile.serverUrl}</small>
            {(details || profile.lastConnectionError || rowActivationError) && <small className={rowActivationError || profile.lastConnectionError ? profile.connectionState === 'degraded' && !rowActivationError ? 'server-management-warning' : 'server-management-error' : ''}>
              {rowActivationError || profile.lastConnectionError || details}
            </small>}
          </div>
          <div className="server-management-actions">
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.move_up_0bca820", { "server": String(profile.name) })} disabled={index === 0 || Boolean(busy)} onClick={() => void move(profile.id, -1)}><ArrowUp size={13} /></button>
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.move_down_c5ebfeb", { "server": String(profile.name) })} disabled={index === profiles.length - 1 || Boolean(busy)} onClick={() => void move(profile.id, 1)}><ArrowDown size={13} /></button>
            {!current && <button type="button" className="quiet-button" aria-label={working ? t("ui.ServerManagement.switching_to_e7437c0", { "server": String(profile.name) }) : t("ui.ServerManagement.use_367b9be", { "server": String(profile.name) })} disabled={Boolean(busy) || Boolean(switchingProfileId)} onClick={() => void activate(profile.id)}>{working && <LoaderCircle className="spin" size={12} />} {working ? t("ui.ServerManagement.switching_b7b9fbf") : t("ui.ServerManagement.use_c36d819")}</button>}
            <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.edit_966e044", { "server": String(profile.name) })} disabled={Boolean(busy)} onClick={() => beginEdit(profile)}><Pencil size={13} /></button>
            <button
              type="button"
              className={confirmRemoveId === profile.id ? 'danger-button compact' : 'icon-button'}
              aria-label={current ? t("ui.ServerManagement.cannot_remove_active_server_b699625", { "server": String(profile.name) }) : t("ui.ServerManagement.remove_6f8460e", { "filename": String(profile.name) })}
              title={current ? t("ui.ServerManagement.switch_to_another_server_before_removing_t_1ed6f7e") : t("ui.ServerManagement.remove_saved_server_cached_chats_are_prese_3fae6c2")}
              disabled={current || Boolean(busy)}
              onClick={() => void remove(profile)}
            >{working ? <LoaderCircle className="spin" size={12} /> : confirmRemoveId === profile.id ? 'Confirm' : <Trash2 size={13} />}</button>
          </div>
        </div>
      })}
    </div>
    {draft && <div ref={editorRef} className="server-management-editor">
      <div className="server-management-editor-heading">
        <div><strong>{draft.profileId ? t("ui.ServerManagement.ServerManagement.edit_966e044", { "server": String(editedProfile?.name || 'server') }) : t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</strong><small>{t("ui.ServerManagement.ServerManagement.connection_credentials_stay_in_this_mac_s__d4f7858")}</small></div>
        <button type="button" className="icon-button" aria-label={t("ui.ServerManagement.ServerManagement.close_server_editor_0b6523b")} disabled={Boolean(busy)} onClick={() => { invalidateTest(); setDraft(null) }}><XIcon /></button>
      </div>
      {!draft.profileId && <button type="button" className="server-setup-guide" disabled={Boolean(busy)} onClick={() => {
        useAppStore.getState().setModal('settings', false)
        useAppStore.getState().setModal('appSettings', false)
        window.dispatchEvent(new CustomEvent('agentsdock:server-setup', { detail: { mode: 'add' } }))
      }}><span className="server-setup-icon"><Server size={18} /></span><span><strong>{t("ui.ServerManagement.ServerManagement.guided_server_install_0a80c52")}</strong><small>{t("ui.ServerManagement.ServerManagement.install_locally_or_over_ssh_then_add_and_s_c53b5e4")}</small></span></button>}
      <label><span>{t('serverProfile.nameOnThisMac')}</span><input ref={nameInputRef} value={draft.name} onChange={event => updateDraft({ name: event.target.value })} placeholder={t("ui.ServerManagement.ServerManagement.production_home_mac_lab_b241246")} title={t('serverProfile.localNameHint')} /></label>
      <label><span>{t("ui.ServerManagement.ServerManagement.server_url_22f5ebc")}</span><div className="input-with-icon"><Server size={14} /><input value={draft.serverUrl} onChange={event => updateDraft({ serverUrl: event.target.value }, true)} placeholder="server.example.com:7850" autoCapitalize="none" autoCorrect="off" /></div></label>
      <label><span>{t("ui.ServerManagement.ServerManagement.access_token_9a911b0")}</span><input type="password" value={draft.accessToken} disabled={draft.clearAccessToken} onChange={event => updateDraft({ accessToken: event.target.value }, true)} placeholder={editedProfile?.hasAccessToken ? t("ui.ServerManagement.ServerManagement.leave_blank_to_keep_saved_token_ac74a50") : t("ui.ServerManagement.ServerManagement.token_from_agentsserver_9741e8c")} autoComplete="off" /></label>
      {editedProfile?.hasAccessToken && <label className="checkbox-row"><input type="checkbox" checked={draft.clearAccessToken} onChange={event => updateDraft({ clearAccessToken: event.target.checked, accessToken: '' }, true)} />{t("ui.ServerManagement.ServerManagement.remove_saved_access_token_fd2be83")}</label>}
      {editedProfile?.serverIdentity && editedProfile.lastConnectionError?.includes('Server identity changed') && <label className="checkbox-row server-identity-confirm"><input type="checkbox" checked={draft.resetServerIdentity} onChange={event => updateDraft({ resetServerIdentity: event.target.checked }, true)} />{t("ui.ServerManagement.ServerManagement.i_confirm_this_url_may_establish_a_new_ser_9c3f4d1")}</label>}
      {(testedHealth || testError) && <div className={`server-management-test ${testError ? 'error' : 'success'}`} role="status">
        {testError ? <><Wifi size={14} /><span>{testError}</span></> : duplicateTestProfile ? <><Check size={14} /><span>Already saved as “{duplicateTestProfile.name}”</span></> : <><Check size={14} /><span>{t("ui.ServerManagement.ServerManagement.connected_2296556")}{testedHealth?.server_identity ? ` · ${testedHealth.server_identity}` : ''}</span></>}
      </div>}
      <footer>
        <button type="button" className="quiet-button" disabled={Boolean(busy) || !draft.serverUrl.trim()} onClick={() => void testConnection()}>{busy === 'test' ? <LoaderCircle className="spin" size={13} /> : <Wifi size={13} />}{" "}{t("ui.ServerManagement.ServerManagement.test_connection_5bcf311")}</button>
        <span className="dialog-spacer" />
        <button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => { invalidateTest(); setDraft(null) }}>{t("ui.ServerManagement.ServerManagement.cancel_19766ed")}</button>
        <button type="button" className="primary-button" disabled={Boolean(busy) || !draft.serverUrl.trim() || !draft.profileId && !testedHealth?.ok} onClick={() => void save()}>{busy === 'save' && <LoaderCircle className="spin" size={13} />} {draft.profileId ? t("ui.ServerManagement.ServerManagement.save_1509f56") : duplicateTestProfile ? t("ui.ServerManagement.ServerManagement.use_367b9be", { "server": String(duplicateTestProfile.name) }) : t("ui.ServerManagement.ServerManagement.add_switch_90143f7")}</button>
      </footer>
    </div>}
  </section>
}

function XIcon() {
  useLocale()
  return <span aria-hidden="true">×</span>
}

function connectionLabel(profile: PublicServerProfile): string {
  if (profile.lastConnectionError && /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|access token|bad token|invalid token)\b/i.test(profile.lastConnectionError)) {
    return t("ui.ServerManagement.connectionLabel.authentication_required_097678f", { "detail": String(profile.lastConnectionError) })
  }
  const label = profile.connectionState.charAt(0).toUpperCase() + profile.connectionState.slice(1)
  return profile.lastConnectionError ? `${label}: ${profile.lastConnectionError}` : label
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
