import { useCallback, useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { ArrowUp, Info, LoaderCircle, Square } from 'lucide-react'
import { t } from '@shared/i18n'
import { sideQuestionLimit, sideQuestionsAvailable, type SideQuestionScope } from '@shared/side-questions'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { SideChatController } from '../lib/side-chat'
import { useAppStore } from '../store/app-store'
import { MarkdownContent } from './MarkdownContent'
import './SideQuestionPanel.css'

export function SideQuestionPanel({ session, scope, controller, active = true, focusVersion = 0, autoFocus = true, onFocusHandled }: {
  session: Session; scope: SideQuestionScope; controller: SideChatController; active?: boolean; focusVersion?: number; autoFocus?: boolean; onFocusHandled?: () => void
}) {
  useLocale()
  const subscribe = useCallback((listener: () => void) => controller.subscribe(scope, session.id, listener), [controller, scope.profileId, scope.profileGeneration, session.id])
  const getSnapshot = useCallback(() => controller.snapshot(scope, session.id), [controller, scope.profileId, scope.profileGeneration, session.id])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const health = useAppStore(state => state.health)
  const connected = useAppStore(state => state.connected)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const history = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const inputId = useId()
  const supported = !window.agentsDock.sharedChat && Boolean(window.agentsDock.sideQuestions) && sideQuestionsAvailable(health, session.backend)
  const ready = supported && connected && !switchingProfileId && Boolean(scope.profileId)
  const limit = sideQuestionLimit(health)
  const length = Array.from(snapshot.draft.trim()).length
  useEffect(() => {
    if (!active || !ready || (!autoFocus && !focusVersion)) return
    textarea.current?.focus({ preventScroll: true })
    if (!autoFocus) textarea.current?.closest('.side-chat-composer')?.scrollIntoView({ block: 'nearest' })
    onFocusHandled?.()
  }, [active, focusVersion, session.id, scope.profileId, scope.profileGeneration, ready, autoFocus, onFocusHandled])
  useEffect(() => {
    const element = history.current
    if (element && active && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [active, snapshot.exchanges])

  return <section className="side-chat" aria-label={t('sideChat.title')} data-session-id={session.id}>
    <div className="side-chat-context"><span>{t('sideChat.about', { title: session.title })}</span>
      <details><summary aria-label={t('sideChat.contextInfo')}><Info size={13} /></summary>
        <p>{t('sideQuestion.context')}{snapshot.contextNote && <><br />{snapshot.contextNote}</>}</p>
      </details>
    </div>
    <div className="side-chat-history" ref={history} role="log" aria-label={t('sideChat.messages')} aria-live="polite"
      onScroll={event => { const element = event.currentTarget; stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48 }}>
      {!snapshot.exchanges.length && <p className="side-chat-empty">{t('sideChat.empty')}</p>}
      {snapshot.exchanges.map(exchange => <div className="side-chat-exchange" key={exchange.id}>
        <div className="side-chat-user">{exchange.question}</div>
        {exchange.answer && <div className="side-chat-assistant"><MarkdownContent text={exchange.answer} fold={false} /></div>}
        {exchange.state === 'pending' && <p className="side-chat-status" role="status"><LoaderCircle className="spin" size={13} />{t('sideChat.answering')}</p>}
        {exchange.state === 'cancelled' && <p className="side-chat-status">{t('sideChat.cancelled')}</p>}
        {exchange.state === 'error' && <p className="side-chat-error" role="alert">{sideQuestionError(exchange.error)}</p>}
      </div>)}
    </div>
    <div className="side-chat-bottom">
      {!supported && <p className="side-chat-note" role="status">{t('sideQuestion.unsupported')}</p>}
      {supported && !ready && <p className="side-chat-note" role="status">{t('sideQuestion.connect')}</p>}
      {snapshot.historyOmitted && <p className="side-chat-note">{t('sideChat.historyOmitted')}</p>}
      {snapshot.error && <p className="side-chat-error" role="alert">{sideQuestionError(snapshot.error)}</p>}
      {supported && <form className="side-chat-composer" onSubmit={event => { event.preventDefault(); stickToBottom.current = true; void controller.send(scope, session) }}>
        <label className="visually-hidden" htmlFor={inputId}>{t('sideChat.message')}</label>
        <textarea id={inputId} ref={textarea} value={snapshot.draft} rows={3} disabled={!ready}
          placeholder={t('sideChat.placeholder')} onChange={event => controller.setDraft(scope, session.id, event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault(); stickToBottom.current = true; void controller.send(scope, session)
            }
          }} />
        <div className="side-chat-composer-actions">
          <span className={length > limit ? 'side-chat-error' : 'side-chat-count'}>{length > limit ? t('sideQuestion.limit', { count: length, limit }) : ''}</span>
          {snapshot.pending
            ? <button type="button" className="side-chat-send" aria-label={t('sideChat.cancel')} title={t('sideChat.cancel')}
              onClick={() => { void controller.cancel(scope, session.id) }}><Square size={12} fill="currentColor" /></button>
            : <button type="submit" className="side-chat-send" aria-label={t('sideChat.send')} title={t('sideChat.send')}
              disabled={!ready || !length || length > limit}><ArrowUp size={16} /></button>}
        </div>
      </form>}
      <p className="side-chat-note side-chat-footnote">{t('sideChat.footnote')}</p>
    </div>
  </section>
}

export function sideQuestionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/side_question_history_unsupported/.test(message)) return t('sideChat.historyUnsupported')
  if (/side_question_cancel_failed/.test(message)) return t('sideQuestion.cancelFailed')
  if (/side_question_unsupported|side_question_http_(?:404|405|501)/.test(message)) return t('sideQuestion.unsupported')
  if (/side_question_http_(?:401|403)/.test(message)) return t('sideQuestion.unauthorized')
  if (/side_question_http_409/.test(message)) return t('sideQuestion.unavailableContext')
  if (/side_question_http_429/.test(message)) return t('sideQuestion.busy')
  if (/side_question_http_503/.test(message)) return t('sideQuestion.providerUnavailable')
  if (/side_question_http_504|side_question_timeout|timeout|timed out/i.test(message)) return t('sideQuestion.timeout')
  return t('sideQuestion.failed')
}
