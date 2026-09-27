import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Dialog from '@radix-ui/react-dialog'
import { MoreHorizontal } from 'lucide-react'
import { t } from '@shared/i18n'

/** Only custom endpoints are forgettable; never signs out a machine's CLI. */
export function EndpointMenu({ disabled, scopeKey, onForget }: { disabled: boolean; scopeKey: string; onForget: () => void }) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setConfirm(false) }, [scopeKey])
  return <>
    <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" disabled={disabled} aria-label={t('connections.options')}><MoreHorizontal size={18} /></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end" sideOffset={5}>
        <DropdownMenu.Item className="menu-item" onSelect={() => setConfirm(true)}>{t('connections.forget')}</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <Dialog.Root open={confirm} onOpenChange={setConfirm}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog">
        <header><Dialog.Title>{t('connections.confirmForget')}</Dialog.Title></header>
        <div className="form-dialog-body"><Dialog.Description>{t('connections.forgetHelp')}</Dialog.Description>
          <div className="codex-auth-settings-actions">
            <button type="button" className="quiet-button" onClick={() => setConfirm(false)}>{t('connections.cancel')}</button>
            <button type="button" className="primary-button" disabled={disabled} onClick={() => { setConfirm(false); onForget() }}>{t('connections.forget')}</button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </>
}
