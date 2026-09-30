import { useEffect, useState } from 'react'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SideChatActivityItem } from '@shared/side-questions'
import type { SideChatExchange } from '../lib/side-chat'
import { useReasoningDisplay } from '../lib/reasoning-display'
import { MarkdownContent } from './MarkdownContent'

function activityLabel(item?: SideChatActivityItem): string {
  const text = item?.text.split('\n').find(line => line.trim())?.replace(/^[#*\s]+|\*+$/g, '').trim()
  if (item?.kind === 'tool') return item.status === 'running' && text ? text : t('timeline.ui.working')
  if (item?.kind === 'reasoning_summary') return text || t('timeline.ui.thinkingSummary')
  if (item?.kind === 'reasoning') return t('timeline.ui.reasoningTrace')
  return t('timeline.ui.working')
}

function ActivityGroup({ items, live, expanded }: { items: SideChatActivityItem[]; live: boolean; expanded: boolean }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [live])
  const latest = items.at(-1)
  const showReasoning = live && expanded && (latest?.kind === 'reasoning' || latest?.kind === 'reasoning_summary')
  return <div className={`side-chat-activity${showReasoning ? ' has-live-reasoning' : ''}`}>
    <button type="button" className={`side-chat-activity-toggle${live ? ' is-active' : ''}${showReasoning ? ' is-expanded' : ''}`}
      title={t('timeline.ui.activityDetails')}
      aria-expanded={open} aria-label={t('timeline.ui.activityDetails')} onClick={() => setOpen(value => !value)}>
      {live ? <LoaderCircle size={12} className="spin" /> : <ChevronRight size={12} className={open ? 'is-open' : ''} />}
      <span title={live ? activityLabel(latest) : undefined}>{live ? activityLabel(latest) : t('timeline.ui.activityDetails')}</span>
    </button>
    {open ? <div className="side-chat-activity-details">{items.map(item => item.kind === 'tool'
      ? <div key={item.id} className="side-chat-tool-detail">{item.text || t('timeline.ui.working')}</div>
      : <div key={item.id} className="side-chat-reasoning"><small>{t(item.kind === 'reasoning' ? 'timeline.ui.reasoningTrace' : 'timeline.ui.thinkingSummary')}</small><MarkdownContent text={item.text} fold={false} /></div>)}</div>
      : showReasoning && items.filter(item => item.kind === 'reasoning' || item.kind === 'reasoning_summary').map(item =>
        <div key={item.id} className="side-chat-reasoning"><MarkdownContent text={item.text} fold={false} /></div>)}
  </div>
}

/** One chronological native response, with compact activity and explicit retained details. */
export function SideChatResponse({ exchange }: { exchange: SideChatExchange }) {
  const expanded = useReasoningDisplay() === 'expanded'
  const live = exchange.state === 'pending'
  const activity = exchange.activity ?? []
  const streamedAnswer = activity.filter(item => item.kind === 'answer').map(item => item.text).join('\n\n').trim()
  // Completion is authoritative if a runtime omitted its last item aggregate.
  const finalOverride = exchange.state === 'answered' && exchange.answer && exchange.answer.trim() !== streamedAnswer
  const items = finalOverride ? activity.filter(item => item.kind !== 'answer') : activity
  const groups: Array<{ id: string; activity: SideChatActivityItem[] } | { id: string; message: SideChatActivityItem }> = []
  for (const item of items) {
    if (item.kind === 'answer' || item.kind === 'commentary') {
      if (item.text) groups.push({ id: item.id, message: item })
    } else {
      const tail = groups.at(-1)
      if (tail && 'activity' in tail) tail.activity.push(item)
      else groups.push({ id: item.id, activity: [item] })
    }
  }
  const hasStreamedAnswer = items.some(item => item.kind === 'answer' && item.text)
  const last = groups.at(-1)
  const activeGroup = live && last && 'activity' in last
  return <>
    {groups.map(group => 'message' in group
      ? <div className="side-chat-assistant" key={group.id}><MarkdownContent text={group.message.text} fold={false} /></div>
      : <ActivityGroup key={group.id} items={group.activity} live={Boolean(live && group === last)} expanded={expanded} />)}
    {exchange.answer && !hasStreamedAnswer && <div className="side-chat-assistant"><MarkdownContent text={exchange.answer} fold={false} /></div>}
    {live && !activeGroup && <p className="side-chat-status" role="status"><LoaderCircle className="spin" size={13} />{items.length ? t('timeline.ui.working') : t('sideChat.answering')}</p>}
  </>
}
