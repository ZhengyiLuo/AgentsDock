import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { MoreHorizontal } from 'lucide-react'
import { t } from '@shared/i18n'

/** Only custom endpoints are forgettable; never signs out a machine's CLI. */
export function EndpointMenu({ disabled, scopeKey, onForget, apiKey = false }: { disabled: boolean; scopeKey: string; onForget: () => void; apiKey?: boolean }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setConfirm(false) }, [scopeKey])
  return <>
    <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" disabled={disabled} aria-label={t('connections.options')}><MoreHorizontal size={18} /></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="menu-content endpoint-menu-content" align="end" sideOffset={5}>
        <DropdownMenu.Item className="menu-item" onSelect={() => setConfirm(true)}>{t(apiKey ? 'connections.forgetKey' : 'connections.forget')}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Dialog.Root open={confirm} onOpenChange={setConfirm}><Dialog.Portal><Dialog.Overlay className="dialog-overlay endpoint-confirm-overlay" />
      <Dialog.Content className="form-dialog endpoint-confirm-dialog">
        <Dialog.Title>{t('connections.confirmForget')}</Dialog.Title>
        <Dialog.Description className="endpoint-confirm-description">{t(apiKey ? 'connections.forgetKeyHelp' : 'connections.forgetHelp')}</Dialog.Description>
        <div className="endpoint-confirm-actions">
          <button type="button" className="quiet-button" onClick={() => setConfirm(false)}>{t('connections.cancel')}</button>
          <button type="button" className="primary-button" disabled={disabled} onClick={() => { setConfirm(false); onForget() }}>{t(apiKey ? 'connections.forgetKey' : 'connections.forget')}</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </>
}
