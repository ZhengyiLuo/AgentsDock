import { Copy } from 'lucide-react'
import type { CoordinatedServerUpdate } from '@shared/types'
import { legacyUpdateRecoveryCommand } from '@shared/server-update-recovery'
import { t } from '../lib/i18n'
import { useAppStore } from '../store/app-store'

export function LegacyUpdateRecovery({ update }: { update: CoordinatedServerUpdate }) {
  const command = legacyUpdateRecoveryCommand(update)
  if (!command) return null
  return <div className="legacy-update-recovery">
    <p>{t('coordinatedUpdate.legacyRecovery', { name: update.name })}</p>
    <code>{command}</code>
    <button type="button" className="quiet-button" onClick={() => {
      void window.agentsDock.native.writeClipboard(command).catch(error => {
        useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
      })
    }}><Copy size={13} />{t('coordinatedUpdate.copyRecovery')}</button>
  </div>
}
