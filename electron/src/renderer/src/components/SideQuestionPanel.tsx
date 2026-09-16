import { useEffect, useId, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { LoaderCircle, X } from 'lucide-react'
import { t } from '@shared/i18n'
import { sideQuestionLimit, sideQuestionsAvailable, type SideQuestionAnswer, type SideQuestionScope } from '@shared/side-questions'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { MarkdownContent } from './MarkdownContent'
import './SideQuestionPanel.css'

export function SideQuestionPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  useTransientClose(true, onClose)
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog side-question-panel">
        <header>
          <div>
            <Dialog.Title>{t('sideQuestion.title')}</Dialog.Title>
            <Dialog.Description>{t('sideQuestion.description')}</Dialog.Description>
            <p className="side-question-session">{session.title}</p>
          </div>
          <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t('sideQuestion.close')}><X size={16} /></button></Dialog.Close>
        </header>
        <SideQuestionBody key={JSON.stringify([profileId, profileGeneration, session.id])}
          session={session} scope={{ profileId: profileId ?? '', profileGeneration }} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function SideQuestionBody({ session, scope }: { session: Session; scope: SideQuestionScope }) {
  const health = useAppStore(state => state.health)
  const connected = useAppStore(state => state.connected)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<SideQuestionAnswer | null>(null)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const requestRef = useRef<string | null>(null)
  const interactionRevision = useRef(0)
  const mounted = useRef(false)
  const questionId = useId()
  const limit = sideQuestionLimit(health)
  const questionLength = Array.from(question.trim()).length
  const api = window.agentsDock.sideQuestions
  const supported = !window.agentsDock.sharedChat && sideQuestionsAvailable(health, session.backend) && Boolean(api)
  const ready = connected && !switchingProfileId && Boolean(scope.profileId)

  const scopeIsCurrent = () => {
    const state = useAppStore.getState()
    return mounted.current && state.activeProfileId === scope.profileId
      && state.profileGeneration === scope.profileGeneration && !state.switchingProfileId
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const requestId = requestRef.current
      requestRef.current = null
      if (requestId) void api?.cancel(scope, session.id, requestId).catch(() => undefined)
    }
  }, [])

  // Retire promptly when a profile switch begins, even before the new profile
  // arrives. The old request's answer can never enter the new pane.
  useEffect(() => {
    if (!switchingProfileId) return
    const requestId = requestRef.current
    requestRef.current = null
    setPending(false)
    if (requestId) void api?.cancel(scope, session.id, requestId).catch(() => undefined)
  }, [switchingProfileId])

  const ask = async () => {
    if (!api || !supported || !ready || requestRef.current || !questionLength || questionLength > limit) return
    const requestId = crypto.randomUUID()
    interactionRevision.current += 1
    requestRef.current = requestId
    setPending(true)
    setAnswer(null)
    setError('')
    setStatus('')
    try {
      const result = await api.ask(scope, session.id, { request_id: requestId, question: question.trim() })
      if (!scopeIsCurrent() || requestRef.current !== requestId) return
      if (result.request_id !== requestId || result.session_id !== session.id || result.backend !== session.backend) {
        throw new Error('side_question_invalid_response')
      }
      setAnswer(result)
    } catch (cause) {
      if (scopeIsCurrent() && requestRef.current === requestId) setError(sideQuestionError(cause))
    } finally {
      if (scopeIsCurrent() && requestRef.current === requestId) {
        requestRef.current = null
        setPending(false)
      }
    }
  }

  const cancel = async () => {
    const requestId = requestRef.current
    if (!api || !requestId) return
    const cancellationRevision = ++interactionRevision.current
    requestRef.current = null
    setPending(false)
    setStatus(t('sideQuestion.cancelled'))
    try { await api.cancel(scope, session.id, requestId) }
    catch {
      if (scopeIsCurrent() && interactionRevision.current === cancellationRevision) {
        setStatus('')
        setError(t('sideQuestion.cancelFailed'))
      }
    }
  }

  if (!supported) return <div className="side-question-body"><p className="side-question-note" role="status">{t('sideQuestion.unsupported')}</p></div>

  return <form className="side-question-body" onSubmit={event => { event.preventDefault(); void ask() }}>
    <p className="side-question-note">{t('sideQuestion.context')}</p>
    {!ready && <p className="side-question-note" role="status">{t('sideQuestion.connect')}</p>}
    <label htmlFor={questionId}>{t('sideQuestion.question')}</label>
    <textarea id={questionId} value={question} rows={3} autoFocus disabled={pending || !ready}
      placeholder={t('sideQuestion.placeholder')} onChange={event => setQuestion(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void ask() } }} />
    <div className="side-question-actions">
      <small className={questionLength > limit ? 'side-question-error' : ''}>{t('sideQuestion.limit', { count: questionLength, limit })}</small>
      {pending
        ? <button type="button" className="quiet-button" onClick={() => { void cancel() }}>{t('sideQuestion.cancel')}</button>
        : <button type="submit" className="primary-button" disabled={!ready || !questionLength || questionLength > limit}>{t('sideQuestion.ask')}</button>}
    </div>
    {pending && <p className="side-question-progress" role="status"><LoaderCircle className="spin" size={14} />{t('sideQuestion.waiting')}</p>}
    {status && <p className="side-question-note" role="status">{status}</p>}
    {error && <p className="side-question-error" role="alert">{error}</p>}
    {answer && <section className="side-question-answer" aria-label={t('sideQuestion.answer')}>
      <h3>{t('sideQuestion.answer')}</h3>
      <MarkdownContent text={answer.answer} fold={false} />
      {answer.context_note && <p className="side-question-note">{answer.context_note}</p>}
    </section>}
  </form>
}

function sideQuestionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/side_question_unsupported|side_question_http_(?:404|405|501)/.test(message)) return t('sideQuestion.unsupported')
  if (/side_question_http_(?:401|403)/.test(message)) return t('sideQuestion.unauthorized')
  if (/side_question_http_409/.test(message)) return t('sideQuestion.unavailableContext')
  if (/side_question_http_429/.test(message)) return t('sideQuestion.busy')
  if (/side_question_http_503/.test(message)) return t('sideQuestion.providerUnavailable')
  if (/side_question_timeout|timeout|timed out/i.test(message)) return t('sideQuestion.timeout')
  return t('sideQuestion.failed')
}
