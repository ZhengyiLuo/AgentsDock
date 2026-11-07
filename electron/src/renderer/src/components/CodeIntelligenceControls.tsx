import { useState } from 'react'
import { t, useLocale } from '../lib/i18n'
import type { useEditorCodeIntelligence } from '../lib/code-intelligence-editor'
import './CodeIntelligenceControls.css'

export function CodeIntelligenceControls({ intelligence }: { intelligence: ReturnType<typeof useEditorCodeIntelligence> }) {
  useLocale()
  const [setupOpen, setSetupOpen] = useState(false)
  if (!intelligence.enabled) return null
  return <>
    <div className="code-intelligence-toolbar">
      <span role="status" className="code-intelligence-status" title={intelligence.message || t('codeIntelligence.completionHint')}>
        {intelligence.phase === 'ready' ? t('codeIntelligence.ready')
          : intelligence.phase === 'connecting' ? t('codeIntelligence.connecting') : t('codeIntelligence.unavailable')}
      </span>
      {intelligence.phase === 'ready' && <>
        <button type="button" className="quiet-button" disabled={intelligence.finding}
          title={`${t('codeIntelligence.definition')} (F12)`} onClick={() => intelligence.navigate('definition')}>{t('codeIntelligence.definition')}</button>
        <button type="button" className="quiet-button" disabled={intelligence.finding}
          title={`${t('codeIntelligence.references')} (Shift+F12)`} onClick={() => intelligence.navigate('references')}>{t('codeIntelligence.references')}</button>
      </>}
      {intelligence.phase === 'unavailable' && <>
        <button type="button" className="quiet-button" aria-expanded={setupOpen} onClick={() => setSetupOpen(value => !value)}>{t('codeIntelligence.setup')}</button>
        <button type="button" className="quiet-button" onClick={intelligence.retry}>{t('codeIntelligence.retry')}</button>
      </>}
    </div>
    {setupOpen && intelligence.phase === 'unavailable' && <div className="code-intelligence-setup" role="region" aria-label={t('codeIntelligence.setupTitle')}>
      <span>{intelligence.message || t('codeIntelligence.unavailableLanguage')}</span>
      {intelligence.installHint && <code>{intelligence.installHint}</code>}
    </div>}
    {(intelligence.finding || intelligence.locations !== null || intelligence.navigationError) && <div className="code-intelligence-locations" role="region" aria-label={t('codeIntelligence.locations')}>
      <div className="code-intelligence-locations-heading">
        <span role="status">{intelligence.finding ? t('codeIntelligence.finding')
          : intelligence.navigationError || (intelligence.locations?.length ? t('codeIntelligence.chooseLocation') : t('codeIntelligence.noLocations'))}</span>
        <button type="button" className="quiet-button" aria-label={t('codeIntelligence.closeLocations')} onClick={intelligence.closeLocations}>×</button>
      </div>
      {intelligence.locations?.map(location => <button type="button" className="code-intelligence-location"
        aria-label={`${location.path} ${location.line}:${location.column}`}
        key={`${location.path}:${location.line}:${location.column}`} onClick={() => intelligence.openLocation(location)}>
        <span>{location.path}</span><span>{location.line}:{location.column}</span>
      </button>)}
      {intelligence.locations?.length === 200 && <span className="code-intelligence-result-limit">{t('codeIntelligence.moreLocations')}</span>}
    </div>}
  </>
}
