import * as Popover from '@radix-ui/react-popover'
import { MessageCircleQuestion, Trash2, X } from 'lucide-react'
import { useId, useRef } from 'react'
import { t } from '@shared/i18n'
import type { SideQuestionScope } from '@shared/side-questions'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { SideChatController } from '../lib/side-chat'
import { useTransientClose } from '../lib/transient-close'
import { SideQuestionPanel } from './SideQuestionPanel'

export function SideChatPopover({ session, scope, controller, open, focusVersion, onOpenChange }: {
  session: Session; scope: SideQuestionScope; controller: SideChatController
  open: boolean; focusVersion: number; onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const titleId = useId()
  const content = useRef<HTMLDivElement>(null)
  useTransientClose(open, () => onOpenChange(false))
  if (window.agentsDock.sharedChat || !['codex', 'claude'].includes(session.backend)) return null
  return <div className="side-chat-anchor">
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" className={`icon-button side-chat-trigger${open ? ' active' : ''}`}
          aria-label={t('sideChat.title')} title={t('sideChat.title')}><MessageCircleQuestion size={18} /></button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content ref={content} className="side-chat-popover" side="top" align="end" sideOffset={8} collisionPadding={12}
          aria-labelledby={titleId} onOpenAutoFocus={event => {
            // The conversation input owns autofocus; do not focus Clear instead.
            const input = content.current?.querySelector<HTMLTextAreaElement>('textarea')
            if (input && !input.disabled) { event.preventDefault(); input.focus({ preventScroll: true }) }
          }}>
          <header className="side-chat-heading">
            <h3 id={titleId}><MessageCircleQuestion size={16} />{t('sideChat.title')}</h3>
            <button type="button" className="icon-button" aria-label={t('sideChat.clear')} title={t('sideChat.clear')}
              onClick={() => controller.clear(scope, session.id)}><Trash2 size={15} /></button>
            <Popover.Close asChild><button type="button" className="icon-button" aria-label={t('sideChat.close')} title={t('sideChat.close')}><X size={16} /></button></Popover.Close>
          </header>
          <SideQuestionPanel session={session} scope={scope} controller={controller} focusVersion={focusVersion} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
}
