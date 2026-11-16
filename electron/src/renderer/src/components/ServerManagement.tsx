// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight, LoaderCircle, Pencil, Plus, QrCode, Server, Trash2, Wifi } from 'lucide-react'
import type { Health, PublicServerProfile } from '@shared/types'
import { normalizeServerURL } from '@shared/server-url'
import { trackEvent, trackOperation } from '../lib/analytics'
import { useAppStore } from '../store/app-store'
import { ServerConnectionQr } from './ServerConnectionQr'
import { ServerTokenRow } from './ServerTokenRow'

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

export function ServerManagement({ addRequest = 0, manageRequest = 0, activeServerControls }: {
  addRequest?: number; manageRequest?: number; activeServerControls?: ReactNode
}) {
  useLocale()
  const profiles = useAppStore(state => state.profiles)
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const switchServer = useAppStore(state => state.switchServer)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [testedHealth, setTestedHealth] = useState<Health | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [activationError, setActivationError] = useState<{ profileId: string; message: string } | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [tokenCopy, setTokenCopy] = useState<{ profileId: string; failed: boolean } | null>(null)
  const [tokenPreviewRevisions, setTokenPreviewRevisions] = useState<Record<string, number>>({})
  const [qrProfileId, setQrProfileId] = useState<string | null>(null)
  const qrProfile = profiles.find(profile => profile.id === qrProfileId && profile.hasAccessToken)
  const testLease = useRef(0)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const revealEditor = useRef(false)

  const openEditor = (next: ServerDraft) => {
    setQrProfileId(null)
    revealEditor.current = true
    const profileId = next.profileId
    if (profileId) setExpanded(current => new Set([...current, profileId]))
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
      setExpanded(new Set())
      setQrProfileId(null)
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

  const copyToken = async (profile: PublicServerProfile) => {
    setBusy(`copy:${profile.id}`)
    setTokenCopy(null)
    try {
      await window.agentsDock.servers.copyToken(profile.id)
      setTokenCopy({ profileId: profile.id, failed: false })
    } catch {
      // Credential-store errors must not expose secret-bearing details in the UI.
      setTokenCopy({ profileId: profile.id, failed: true })
    } finally {
      setBusy(null)
    }
  }

  const beginEdit = (profile: PublicServerProfile) => {
    setTokenCopy(null)
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
    setQrProfileId(null)
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
        setExpanded(current => new Set([...current, added.id]))
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
      if (draft.profileId && (draft.accessToken || draft.clearAccessToken)) {
        const profileId = draft.profileId
        setTokenPreviewRevisions(current => ({ ...current, [profileId]: (current[profileId] ?? 0) + 1 }))
      }
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
      const health = await trackOperation('connection_tested', () => window.agentsDock.servers.testConnection({
        profileId: testedDraft.profileId ?? undefined,
        serverUrl: testedDraft.serverUrl.trim(),
        accessToken: testedDraft.clearAccessToken ? null : testedDraft.accessToken || undefined
      }), value => value.ok === true)
      if (health.ok !== true) throw new Error('Server health check reported unavailable.')
      if (request === testLease.current) setTestedHealth(health)
    } catch (error) {
      if (request === testLease.current) setTestError(errorMessage(error))
    } finally {
      if (request === testLease.current) setBusy(null)
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

  const editor = draft && <div ref={editorRef} className="server-management-editor">
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
    </div>

  return <section className="server-management" aria-label={t("ui.ServerManagement.ServerManagement.saved_servers_4bf0848")}>
    <div className="server-management-heading">
      <small>{t("ui.ServerManagement.ServerManagement.each_server_keeps_its_own_chats_drafts_fil_35087b7")}</small>
      <button type="button" className="quiet-button" disabled={Boolean(busy)} onClick={() => { invalidateTest(); openEditor(emptyDraft()) }}><Plus size={13} />{" "}{t("ui.ServerManagement.ServerManagement.add_server_1099b2a")}</button>
    </div>
    {draft && !draft.profileId && editor}
    <div className="server-management-list">
      {profiles.map(profile => {
        const current = profile.id === activeProfileId
        const open = expanded.has(profile.id)
        const panelId = `server-details-${encodeURIComponent(profile.id)}`
        const working = busy === `switch:${profile.id}` || switchingProfileId === profile.id
        const rowActivationError = activationError?.profileId === profile.id ? activationError.message : null
        return <div className={`server-management-row${current ? ' active' : ''}`} key={profile.id}>
          <button type="button" className="server-management-toggle" aria-expanded={open} aria-controls={open ? panelId : undefined}
            aria-label={t('serverProfile.detailsFor', { server: profile.name })}
            onClick={() => {
              setExpanded(current => { const next = new Set(current); if (next.has(profile.id)) next.delete(profile.id); else next.add(profile.id); return next })
              if (open && qrProfileId === profile.id) setQrProfileId(null)
              if (open && confirmRemoveId === profile.id) setConfirmRemoveId(null)
              if (open && tokenCopy?.profileId === profile.id) setTokenCopy(null)
            }}>
            <ChevronRight size={16} className="server-management-chevron" />
            <span className="server-management-title">
              <strong>{profile.name}</strong>
              <span className="server-management-url">{profile.serverUrl}</span>
            </span>
            <span className="server-management-header-status">
              <span className={`server-management-status ${profile.connectionState}`}>
                <span className={`server-connection-dot ${profile.connectionState}`} title={connectionLabel(profile)} role="img" aria-label={connectionLabel(profile)} />
                {t(`serverProfile.status.${profile.connectionState}`)}
              </span>
              {current && <span className="server-management-active">{t("ui.ServerManagement.active_9234069")}</span>}
            </span>
          </button>
          {open && <div id={panelId} className="server-management-body">
            {(profile.serverVersion || profile.serverIdentity) && <dl className="server-management-metadata">
              {profile.serverVersion && <div><dt>{t('serverProfile.version')}</dt><dd>{profile.serverVersion}</dd></div>}
              {profile.serverIdentity && <div><dt>{t('serverProfile.identity')}</dt><dd><code>{profile.serverIdentity}</code></dd></div>}
            </dl>}
            <ServerTokenRow key={`${profile.id}:${profile.serverUrl}:${tokenPreviewRevisions[profile.id] ?? 0}`}
              profile={profile} disabled={Boolean(busy)} copying={busy === `copy:${profile.id}`}
              copied={tokenCopy?.profileId === profile.id && !tokenCopy.failed}
              onCopy={() => void copyToken(profile)} />
            <div className="server-management-copy">
              {tokenCopy?.profileId === profile.id && tokenCopy.failed && <small role="status" className="server-management-error">
                {t('serverConnection.copyFailed')}
              </small>}
              {(profile.lastConnectionError || rowActivationError) && <small className={profile.connectionState === 'degraded' && !rowActivationError ? 'server-management-warning' : 'server-management-error'}>
                {rowActivationError || profile.lastConnectionError}
              </small>}
            </div>
            <div className="server-management-sharing">
              <span className="server-management-section-label">{t('serverProfile.shareConnection')}</span>
              <div className="server-management-share-actions">
              <button type="button" className="quiet-button" aria-label={t('serverConnection.qrFor', { server: profile.name })}
                aria-expanded={qrProfileId === profile.id}
                title={t('serverConnection.showQr')} disabled={!profile.hasAccessToken || Boolean(busy)} onClick={() => setQrProfileId(profile.id)}>
                <QrCode size={15} /> {t('serverProfile.showQr')}
              </button>
              </div>
            </div>
            {qrProfile?.id === profile.id && <ServerConnectionQr key={`${qrProfile.id}:${qrProfile.serverUrl}`} profile={qrProfile} onClose={() => setQrProfileId(null)} />}
            <div className="server-management-actions">
              <div className="server-management-primary-actions">
              {!current && <button type="button" className="quiet-button" aria-label={working ? t("ui.ServerManagement.switching_to_e7437c0", { "server": String(profile.name) }) : t("ui.ServerManagement.use_367b9be", { "server": String(profile.name) })} disabled={Boolean(busy) || Boolean(switchingProfileId)} onClick={() => void activate(profile.id)}>{working && <LoaderCircle className="spin" size={12} />} {working ? t("ui.ServerManagement.switching_b7b9fbf") : t('serverProfile.use')}</button>}
              <button type="button" className="quiet-button" aria-label={t("ui.ServerManagement.edit_966e044", { "server": String(profile.name) })} disabled={Boolean(busy)} onClick={() => beginEdit(profile)}><Pencil size={15} /> {t('serverProfile.edit')}</button>
              </div>
              <button
                type="button"
                className={confirmRemoveId === profile.id ? 'danger-button server-management-remove' : 'quiet-button server-management-remove'}
                aria-label={current ? t("ui.ServerManagement.cannot_remove_active_server_b699625", { "server": String(profile.name) }) : t("ui.ServerManagement.remove_6f8460e", { "filename": String(profile.name) })}
                title={current ? t("ui.ServerManagement.switch_to_another_server_before_removing_t_1ed6f7e") : t("ui.ServerManagement.remove_saved_server_cached_chats_are_prese_3fae6c2")}
                disabled={current || Boolean(busy)}
                onClick={() => void remove(profile)}
              >{working ? <LoaderCircle className="spin" size={12} /> : confirmRemoveId === profile.id ? t('serverProfile.confirmRemove') : <><Trash2 size={13} /> {t('serverProfile.remove')}</>}</button>
            </div>
            {draft?.profileId === profile.id && editor}
            {current && activeServerControls}
          </div>}
        </div>
      })}
    </div>
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
