import * as Popover from '@radix-ui/react-popover'
import { LoaderCircle, MessageCircleQuestion, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { t } from '@shared/i18n'
import { sideChatMultipleAvailable, sideChatSyncAvailable, type SideQuestionScope } from '@shared/side-questions'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { SideChatController } from '../lib/side-chat'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { SideQuestionPanel } from './SideQuestionPanel'

export function SideChatPopover({ session, scope, controller, open, focusVersion, onOpenChange }: {
  session: Session; scope: SideQuestionScope; controller: SideChatController
  open: boolean; focusVersion: number; onOpenChange: (open: boolean) => void
}) {
  useLocale()
  const titleId = useId()
  const content = useRef<HTMLDivElement>(null)
  const health = useAppStore(state => state.health)
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
            <SideChatClearButton session={session} scope={scope} controller={controller} />
            <Popover.Close asChild><button type="button" className="icon-button" aria-label={t('sideChat.close')} title={t('sideChat.close')}><X size={16} /></button></Popover.Close>
          </header>
          {sideChatMultipleAvailable(health) && <SideChatTabs session={session} scope={scope} controller={controller} />}
          <SideQuestionPanel session={session} scope={scope} controller={controller} focusVersion={focusVersion} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
}

function SideChatClearButton({ session, scope, controller }: { session: Session; scope: SideQuestionScope; controller: SideChatController }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(scope, session.id, listener), [controller, scope.profileId, scope.profileGeneration, scope.serverIdentity, session.id])
  const getSnapshot = useCallback(() => controller.snapshot(scope, session.id), [controller, scope.profileId, scope.profileGeneration, scope.serverIdentity, session.id])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const health = useAppStore(state => state.health)
  const loading = sideChatSyncAvailable(health) && snapshot.revision === undefined
  return <button type="button" className="icon-button" aria-label={t('sideChat.clear')}
    disabled={loading} title={t(loading ? 'sideChat.syncing' : 'sideChat.clear')}
    onClick={() => controller.clear(scope, session.id)}><Trash2 size={15} /></button>
}

function SideChatTabs({ session, scope, controller }: { session: Session; scope: SideQuestionScope; controller: SideChatController }) {
  const subscribe = useCallback((listener: () => void) => controller.subscribe(scope, session.id, listener), [controller, scope.profileId, scope.profileGeneration, scope.serverIdentity, session.id])
  const getSnapshot = useCallback(() => controller.tabs(scope, session.id), [controller, scope.profileId, scope.profileGeneration, scope.serverIdentity, session.id])
  const tabs = useSyncExternalStore(subscribe, getSnapshot)
  const tabList = useRef<HTMLDivElement>(null)
  const online = useAppStore(state => state.connected && !state.switchingProfileId)
  useLayoutEffect(() => {
    const list = tabList.current
    const selected = list?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
    if (!list || !selected) return
    if (selected.offsetLeft < list.scrollLeft) list.scrollLeft = selected.offsetLeft
    else if (selected.offsetLeft + selected.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = selected.offsetLeft + selected.offsetWidth - list.clientWidth
  }, [tabs.selectedId])
  return <>
    <div className="side-chat-tabs-row">
      <div ref={tabList} className="side-chat-tabs" role="tablist" aria-label={t('sideChat.conversations')} onKeyDown={event => {
        const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!direction && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const index = tabs.chats.findIndex(chat => chat.sideChatId === tabs.selectedId)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.chats.length - 1 : (index + direction + tabs.chats.length) % tabs.chats.length
        controller.select(scope, session.id, tabs.chats[next].sideChatId)
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {tabs.chats.map((chat, index) => <button key={chat.sideChatId} type="button" role="tab"
          className="side-chat-tab" aria-selected={chat.sideChatId === tabs.selectedId} tabIndex={chat.sideChatId === tabs.selectedId ? 0 : -1}
          aria-label={t('sideChat.numbered', { number: index + 1 })}
          title={chat.exchanges[0]?.question ?? t('sideChat.numbered', { number: index + 1 })}
          onClick={() => controller.select(scope, session.id, chat.sideChatId)}>
          <span>{t('sideChat.numbered', { number: index + 1 })}</span>
          {chat.pending && <span role="status" aria-label={t('sideChat.running')}><LoaderCircle size={12} className="side-chat-tab-running" /></span>}
        </button>)}
      </div>
      <button type="button" className="icon-button side-chat-new" aria-label={t('sideChat.new')} title={t('sideChat.new')}
        disabled={!online || tabs.creating || !tabs.chats.some(chat => chat.revision !== undefined)}
        onClick={() => { void controller.create(scope, session.id) }}><Plus size={16} /></button>
    </div>
    {tabs.error && <div className="side-chat-tabs-error" role="alert"><span>{t('sideChat.syncFailed')}</span>
      <button type="button" className="quiet-button" onClick={() => { void controller.refresh(scope, session.id) }}>{t('timeline.ui.retry')}</button></div>}
  </>
}
