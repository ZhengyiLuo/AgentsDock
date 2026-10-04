// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, LoaderCircle, Shield, X } from 'lucide-react'
import type { OpenCodePermissionMode, Session } from '@shared/types'
import { opencodeBackendAvailable, opencodeBackendUnavailableReason } from '@shared/runtime-catalog'
import { normalizeOpenCodePermissionMode } from '@shared/opencode-permissions'
import {
  OPENCODE_PERMISSION_MODE_HELP,
  OPENCODE_PERMISSION_MODE_LABELS,
  supportedOpenCodePermissionModes
} from '../lib/opencode-permission-copy'
import { queueOpenCodePermissionUpdate } from '../lib/opencode-permission-updates'
import { useAppStore } from '../store/app-store'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function OpenCodePermissionMenu({
  session,
  running,
  open: controlledOpen,
  onOpenChange
}: {
  session: Session
  running: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  useLocale()
  const [internalOpen, setInternalOpen] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [mode, setMode] = useState<OpenCodePermissionMode>(() => permissionMode(session))
  const modeRef = useRef(mode)
  const saveEpoch = useRef(0)
  const mounted = useRef(true)
  const health = useAppStore(state => state.health)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const permissionModes = supportedOpenCodePermissionModes(catalog?.backends?.opencode?.permission_modes ?? health?.capabilities?.opencode_backend?.permission_modes)
  const available = opencodeBackendAvailable(health, catalog) && permissionModes.length > 0
  const unavailableReason = opencodeBackendUnavailableReason(health, catalog)
  const controlsDisabled = !available || running || saveState === 'saving'
  const label = OPENCODE_PERMISSION_MODE_LABELS[mode]
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    saveEpoch.current += 1
    setOpen(false)
    setSaveState('idle')
    setSaveError(null)
    const next = permissionMode(session)
    modeRef.current = next
    setMode(next)
  }, [session.id])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      saveEpoch.current += 1
    }
  }, [])

  useEffect(() => {
    if (saveState === 'saving') return
    const next = permissionMode(session)
    modeRef.current = next
    setMode(next)
  }, [saveState, session.opencode_permission_mode])

  useEffect(() => {
    if (saveState !== 'saved') return
    const timer = window.setTimeout(() => setSaveState('idle'), 1_400)
    return () => window.clearTimeout(timer)
  }, [saveState])

  const apply = (next: OpenCodePermissionMode) => {
    if (controlsDisabled || !permissionModes.includes(next) || next === modeRef.current) return
    modeRef.current = next
    setMode(next)
    const epoch = ++saveEpoch.current
    setSaveState('saving')
    setSaveError(null)
    void queueOpenCodePermissionUpdate(session.id, { opencode_permission_mode: next })
      .then(() => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        setSaveState('saved')
      })
      .catch(cause => {
        if (!mounted.current || epoch !== saveEpoch.current) return
        const updated = useAppStore.getState().sessions.find(candidate => candidate.id === session.id)
        const fallback = permissionMode(updated ?? session)
        modeRef.current = fallback
        setMode(fallback)
        setSaveState('error')
        setSaveError(errorMessage(cause))
      })
  }

  return <Popover.Root open={available && open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button
        type="button"
        className={`codex-permission-chip${available ? '' : ' unavailable'}`}
        aria-label={t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.opencode_permissions_dda1918", { "label": String(label) })}
        title={available ? t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.opencode_permissions_dda1918", { "label": String(label) }) : unavailableReason ?? t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.opencode_permissions_are_unavailable_4bcf0cc")}
        disabled={!available}
      >
        <Shield size={14} aria-hidden="true" />
        <span className="codex-permission-primary">{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        className="codex-permission-popover"
        side="top"
        align="start"
        sideOffset={8}
        aria-labelledby="opencode-permission-title"
        aria-describedby="opencode-permission-description opencode-permission-context-reset"
      >
        <header>
          <span className="codex-permission-popover-icon"><Shield size={16} aria-hidden="true" /></span>
          <div>
            <h3 id="opencode-permission-title">{t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.opencode_permissions_e31718f")}</h3>
            <p id="opencode-permission-description">{t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.applies_to_future_turns_in_this_chat_95b5680")}</p>
          </div>
          <div className="codex-permission-popover-actions">
            <span className={`codex-permission-save-state ${saveState}`} role="status" aria-live="polite">
              {saveState === 'saving' && <><LoaderCircle className="spin" size={12} />{" "}{t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.saving_096b736")}</>}
              {saveState === 'saved' && <><Check size={12} />{" "}{t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.saved_b5c120b")}</>}
              {saveState === 'error' && t('opencode.permissions.notSaved')}
            </span>
            <Popover.Close asChild>
              <button type="button" className="codex-permission-popover-close" aria-label={t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.close_opencode_permissions_69244be")} title={t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.close_7d9eb7a")}>
                <X size={14} aria-hidden="true" />
              </button>
            </Popover.Close>
          </div>
        </header>
        <div className="codex-permission-fields claude-permission-fields">
          <label>
            <span>{t("ui.OpenCodePermissionMenu.OpenCodePermissionMenu.permission_mode_c7a8e6d")}</span>
            <select
              value={mode}
              disabled={controlsDisabled}
              onChange={event => apply(event.target.value as OpenCodePermissionMode)}
            >
              {permissionModes.map(value =>
                <option key={value} value={value}>{OPENCODE_PERMISSION_MODE_LABELS[value]}</option>
              )}
            </select>
          </label>
        </div>
        <p className="codex-permission-hint">{OPENCODE_PERMISSION_MODE_HELP[mode]}</p>
        <p id="opencode-permission-context-reset" className="codex-permission-hint">{t('opencode.permissions.contextReset')}</p>
        {running && <p className="codex-permission-hint">{t('opencode.permissions.waitUntilIdle')}</p>}
        {saveError && <p className="codex-permission-error" role="alert">{saveError}</p>}
        <Popover.Arrow className="codex-permission-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}

function permissionMode(session: Session): OpenCodePermissionMode {
  return normalizeOpenCodePermissionMode(session.opencode_permission_mode)
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}
