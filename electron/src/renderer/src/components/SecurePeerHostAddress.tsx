import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { LoaderCircle, Pencil } from 'lucide-react'
import { normalizeSecurePeerEndpoint, type SecurePeerControlStatus, type SecurePeerPairing, type SecurePeerProfileScope } from '@shared/secure-peer'
import type { TeamHubStatus } from '@shared/team-hub'
import { t, useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'

function selectionKey(state = useAppStore.getState()): string {
  return JSON.stringify([state.activeProfileId, state.profileGeneration, state.switchingProfileId,
    state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity])
}

function sameScope(control: SecurePeerControlStatus, scope: SecurePeerProfileScope): boolean {
  return control.profileId === scope.profileId && control.profileGeneration === scope.profileGeneration
    && control.serverIdentity === scope.serverIdentity
}

function scopeSelected(scope: SecurePeerProfileScope): boolean {
  const app = useAppStore.getState()
  if (app.switchingProfileId) return false
  if (!app.activeProfileId) return true
  const profile = app.profiles.find(candidate => candidate.id === app.activeProfileId)
  return app.activeProfileId === scope.profileId && app.profileGeneration === scope.profileGeneration
    && (!profile?.serverIdentity || profile.serverIdentity === scope.serverIdentity)
}

/** Local control status remains available when the remote Team Hub is offline. */
export function TeamNetworkHostAddressAction({ status, onUpdated }: {
  status: TeamHubStatus
  onUpdated: () => Promise<void> | void
}) {
  const selected = useAppStore(selectionKey)
  const context = JSON.stringify([status.profileId, status.profileGeneration, status.serverIdentity, status.generation,
    status.connectionId, status.hostServerIdentity, status.hubIdentity, selected])
  const currentContext = useRef(context)
  currentContext.current = context
  const [snapshot, setSnapshot] = useState<{ context: string; control: SecurePeerControlStatus } | null>(null)
  useEffect(() => {
    if (!status.serverIdentity || status.designatedHost) return
    const scope = { profileId: status.profileId, profileGeneration: status.profileGeneration, serverIdentity: status.serverIdentity }
    if (!scopeSelected(scope)) return
    let active = true
    void window.agentsDock.teamHub.securePeerStatus(scope).then(control => {
      if (active && currentContext.current === context && selectionKey() === selected && sameScope(control, scope)) {
        setSnapshot({ context, control })
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [context, status.designatedHost])
  const control = snapshot?.context === context ? snapshot.control : null
  const connectionId = status.connectionId ?? control?.activeConnectionId
  const pairing = control?.pairings.find(candidate => candidate.direction === 'outgoing'
    && candidate.trustState === 'approved' && candidate.connectionId === connectionId
    && (!status.hostServerIdentity || candidate.hostServerIdentity === status.hostServerIdentity)
    && (!status.hubIdentity || candidate.hubIdentity === status.hubIdentity))
  if (!control || !pairing) return null
  return <SecurePeerHostAddressAction control={control} pairing={pairing} onUpdated={next => {
    if (currentContext.current !== context || selectionKey() !== selected) return
    setSnapshot({ context, control: next })
    return onUpdated()
  }} />
}

interface EndpointEdit {
  context: string
  selection: string
  scope: SecurePeerProfileScope
  serverInstanceId: string
  pairing: SecurePeerPairing
  available: boolean
}

/** The same editor is used for the current host and explicitly saved connections. */
export function SecurePeerHostAddressAction({ control, pairing, disabled = false, onUpdated }: {
  control: SecurePeerControlStatus
  pairing: SecurePeerPairing
  disabled?: boolean
  onUpdated: (control: SecurePeerControlStatus) => Promise<void> | void
}) {
  useLocale()
  const selected = useAppStore(selectionKey)
  const context = JSON.stringify([control.profileId, control.profileGeneration, control.serverIdentity,
    control.serverInstanceId, pairing.connectionId, pairing.hostServerIdentity, pairing.hubIdentity,
    pairing.hostCaFingerprint, pairing.remoteEndpoint, selected])
  const currentContext = useRef(context)
  currentContext.current = context
  const mounted = useRef(true)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const inFlight = useRef(false)
  const [edit, setEdit] = useState<EndpointEdit | null>(null)
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reset identity-bound state before the new connection's button can be
  // used. A passive mount reset can otherwise erase the first click.
  useLayoutEffect(() => {
    setEdit(null)
    setError(null)
    setSaving(false)
    inFlight.current = false
  }, [context])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const eligible = pairing.direction === 'outgoing' && pairing.trustState === 'approved'
    && Boolean(pairing.connectionId && pairing.hostServerIdentity && pairing.hubIdentity && control.serverInstanceId)
    && scopeSelected(control)
  if (!eligible) return null
  const open = () => {
    if (disabled || inFlight.current || !scopeSelected(control)) return
    setEdit({ context, selection: selectionKey(),
      scope: { profileId: control.profileId, profileGeneration: control.profileGeneration, serverIdentity: control.serverIdentity },
      serverInstanceId: control.serverInstanceId, pairing: { ...pairing }, available: control.endpointUpdateAvailable === true })
    setAddress(pairing.remoteEndpoint)
    setError(null)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!edit || !edit.available || inFlight.current || disabled || currentContext.current !== edit.context
      || selectionKey() !== edit.selection || !scopeSelected(edit.scope)) return
    let endpoint: string
    try { endpoint = normalizeSecurePeerEndpoint(address.trim()).endpoint } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('teamNetwork.peer.endpointInvalid'))
      return
    }
    if (endpoint === edit.pairing.remoteEndpoint) {
      setError(t('teamNetwork.peer.endpointUnchanged'))
      return
    }
    const snapshot = edit
    const active = () => mounted.current && currentContext.current === snapshot.context && selectionKey() === snapshot.selection
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      const next = await window.agentsDock.teamHub.updateSecurePeerConnectionEndpoint(snapshot.scope, {
        connectionId: snapshot.pairing.connectionId!,
        expectedHostServerIdentity: snapshot.pairing.hostServerIdentity,
        expectedHubIdentity: snapshot.pairing.hubIdentity!,
        expectedServerInstanceId: snapshot.serverInstanceId,
        expectedRemoteEndpoint: snapshot.pairing.remoteEndpoint,
        host: endpoint,
        confirmed: true
      })
      if (!active()) return
      const updated = next.pairings.find(candidate => candidate.connectionId === snapshot.pairing.connectionId)
      if (!sameScope(next, snapshot.scope) || next.serverInstanceId !== snapshot.serverInstanceId
        || updated?.direction !== 'outgoing' || updated.trustState !== 'approved'
        || updated.hostServerIdentity !== snapshot.pairing.hostServerIdentity
        || updated.hubIdentity !== snapshot.pairing.hubIdentity
        || updated.hostCaFingerprint !== snapshot.pairing.hostCaFingerprint
        || updated.remoteEndpoint !== endpoint) throw new Error(t('teamNetwork.peer.endpointResponseMismatch'))
      setEdit(null)
      await onUpdated(next)
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : t('teamNetwork.peer.endpointFailed'))
    } finally {
      if (active()) { inFlight.current = false; setSaving(false) }
    }
  }
  const visibleEdit = edit?.context === context ? edit : null
  return <>
    <button ref={trigger} type="button" className="quiet-button" disabled={disabled || saving} onClick={open}
      title={t('teamNetwork.peer.currentHostAddress', { address: pairing.remoteEndpoint })}>
      <Pencil size={14} />{t('teamNetwork.peer.changeHostAddress')}
    </button>
    {visibleEdit && <Dialog.Root open onOpenChange={value => { if (!value && !inFlight.current) setEdit(null) }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog" aria-busy={saving}
        onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus() }}
        onEscapeKeyDown={event => { if (saving) event.preventDefault() }}
        onPointerDownOutside={event => { if (saving) event.preventDefault() }}>
        <header><div><Dialog.Title>{t('teamNetwork.peer.changeHostAddress')}</Dialog.Title>
          <Dialog.Description>{t('teamNetwork.peer.changeHostAddressDescription', { name: pairing.peerDisplayName })}</Dialog.Description>
        </div></header>
        <form className="form-dialog-body dialog-form" onSubmit={event => void save(event)}>
          <label>{t('teamNetwork.peer.hostAddress')}<input required autoComplete="off" autoCapitalize="none" spellCheck={false}
            placeholder="100.64.0.1:7851" value={address} disabled={saving}
            onChange={event => setAddress(event.currentTarget.value)} /></label>
          {visibleEdit && !visibleEdit.available && <p className="error-text" role="alert">{t('teamNetwork.peer.endpointUpdateRequired')}</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
          <footer><button type="button" className="quiet-button" disabled={saving} onClick={() => setEdit(null)}>{t('teamNetwork.peer.cancel')}</button>
            <button type="submit" className="primary-button" disabled={saving || !visibleEdit?.available || !address.trim()}>
              {saving && <LoaderCircle size={14} className="spin" />}{t(saving ? 'teamNetwork.peer.savingHostAddress' : 'teamNetwork.shell.save')}
            </button></footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
    </Dialog.Root>}
  </>
}
