import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { t } from '@shared/i18n'
import { useAppStore } from '../store/app-store'
import { useLocale } from '../lib/i18n'
import type { CustomModelBackend } from '@shared/custom-models'

/** Discovery only runs after an explicit click; editing and idle never fetch. */
export function CodexModelDiscovery({ menu = false, sessionId, backend = 'codex' }: { menu?: boolean; sessionId?: string; backend?: CustomModelBackend }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestRef = useRef(0)
  useEffect(() => {
    requestRef.current += 1
    setLoading(false)
    setFailed(false)
    return () => { requestRef.current += 1 }
  }, [profileId, profileGeneration, sessionId, backend])
  const refresh = async () => {
    if (!profileId || loading) return
    const request = ++requestRef.current
    setLoading(true)
    setFailed(false)
    try {
      if (window.agentsDock.customModels) {
        const result = await window.agentsDock.customModels.read({ profileId, profileGeneration }, backend, sessionId)
        if (result.discovery_status === 'unavailable' || result.discovery_status === 'authentication_failed') throw new Error('Model discovery unavailable')
      } else if (backend === 'codex') await window.agentsDock.codex.providerModels({ profileId, profileGeneration }, sessionId)
      else throw new Error('Update required')
    } catch {
      if (requestRef.current === request) setFailed(true)
    } finally {
      if (requestRef.current === request) setLoading(false)
    }
  }
  const content = <>{loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{t(loading ? 'codexProvider.refreshingModels' : 'codexProvider.refreshModels')}</>
  return <>
    {menu ? <DropdownMenu.Item className="menu-item" disabled={loading || !profileId} onSelect={event => { event.preventDefault(); void refresh() }}>{content}</DropdownMenu.Item>
      : <button type="button" className="quiet-button" disabled={loading || !profileId} onClick={() => { void refresh() }}>{content}</button>}
    {failed && <small className={menu ? 'menu-label' : 'schedule-validation error'} role="alert">{t('codexProvider.discoveryFailed')}</small>}
  </>
}
