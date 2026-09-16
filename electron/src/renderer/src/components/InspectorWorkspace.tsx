import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MessageCircleQuestion, MoreHorizontal, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SideQuestionScope } from '@shared/side-questions'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { SideChatController } from '../lib/side-chat'
import { Inspector } from './Inspector'
import { SideQuestionPanel } from './SideQuestionPanel'

export type InspectorWorkspaceTab = 'details' | 'sidechat' | 'review'
export function InspectorWorkspace({ session, scope, controller, tab, onTabChange, onHide, focusVersion, review, visible }: {
  session: Session | null; scope: SideQuestionScope; controller: SideChatController; tab: InspectorWorkspaceTab
  onTabChange: (tab: InspectorWorkspaceTab) => void; onHide: () => void; focusVersion: number; review?: ReactNode; visible: boolean
}) {
  useLocale()
  const id = useId()
  const sideChatAvailable = !window.agentsDock.sharedChat && (session?.backend === 'codex' || session?.backend === 'claude')
  const selectedTab = tab === 'review' && !review || tab === 'sidechat' && !sideChatAvailable ? 'details' : tab
  const tabs: InspectorWorkspaceTab[] = ['details', ...(sideChatAvailable ? ['sidechat' as const] : []), ...(review ? ['review' as const] : [])]
  return <aside className="inspector inspector-workspace">
    <div className="inspector-drag-region" />
    <header className="inspector-workspace-header">
      <div className="inspector-workspace-tabs" role="tablist" aria-label={t('sideChat.panelViews')}>
        {tabs.map(value => <button type="button" role="tab" key={value} id={`${id}-${value}-tab`}
          aria-controls={`${id}-${value}-panel`} aria-selected={selectedTab === value} tabIndex={selectedTab === value ? 0 : -1}
          onClick={() => onTabChange(value)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const index = tabs.indexOf(value)
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)!
              : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
            onTabChange(next)
            document.getElementById(`${id}-${next}-tab`)?.focus()
          }}>{value === 'sidechat' && <MessageCircleQuestion size={13} />}{t(value === 'details' ? 'sideChat.details' : value === 'review' ? 'sideChat.review' : 'sideChat.title')}</button>)}
      </div>
      {selectedTab === 'sidechat' && session && <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild><button type="button" className="icon-button" aria-label={t('sideChat.actions')}><MoreHorizontal size={15} /></button></DropdownMenu.Trigger>
        <DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item className="menu-item" onSelect={() => controller.clear(scope, session.id)}>{t('sideChat.clear')}</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal>
      </DropdownMenu.Root>}
      <button type="button" className="icon-button" aria-label={t('sideChat.hide')} title={t('sideChat.hide')} onClick={onHide}><X size={15} /></button>
    </header>
    {selectedTab === 'details' && <div className="inspector-workspace-content" role="tabpanel" id={`${id}-details-panel`} aria-labelledby={`${id}-details-tab`}>
      <InspectorDetails scope={scope} sessionId={session?.id ?? ''} controller={controller} />
    </div>}
    {sideChatAvailable && session && <div className="inspector-workspace-content" role="tabpanel" id={`${id}-sidechat-panel`} aria-labelledby={`${id}-sidechat-tab`} hidden={selectedTab !== 'sidechat'}>
      <SideQuestionPanel key={JSON.stringify([scope.profileId, scope.profileGeneration, session.id])} session={session} scope={scope} controller={controller}
        active={visible && selectedTab === 'sidechat'} focusVersion={focusVersion} />
    </div>}
    {review && selectedTab === 'review' && <div className="inspector-workspace-content" role="tabpanel" id={`${id}-review-panel`} aria-labelledby={`${id}-review-tab`}>{review}</div>}
  </aside>
}

function InspectorDetails({ scope, sessionId, controller }: { scope: SideQuestionScope; sessionId: string; controller: SideChatController }) {
  const host = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = host.current?.querySelector<HTMLElement>('.inspector-scroll')
    if (!element) return
    element.scrollTop = controller.detailsScroll(scope, sessionId)
    return () => controller.saveDetailsScroll(scope, sessionId, element.scrollTop)
  }, [scope.profileId, scope.profileGeneration, sessionId, controller])
  return <div className="inspector-details-host" ref={host}><Inspector /></div>
}
