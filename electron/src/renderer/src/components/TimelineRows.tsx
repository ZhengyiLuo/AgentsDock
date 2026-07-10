import { memo, useMemo, useState } from 'react'
import { AlertTriangle, Check, ChevronRight, Clock3, Code2, Copy, FileText, LoaderCircle, Pin, Sparkles, TerminalSquare, Wrench } from 'lucide-react'
import type { Event, PinnedItem } from '@shared/types'
import type { CodeReviewTarget, JobItem, MediaItem, MessageItem, RenderTimelineItem, SystemItem } from '../lib/timeline'
import { extractUnifiedDiff, isTimelineError, jobDisplayEvents, messageItemText, messageText, parseUnifiedDiff } from '../lib/timeline'
import { formatTime, titleCase } from '../lib/format'
import { MarkdownContent } from './MarkdownContent'
import { MediaGrid } from './MediaGrid'

export const TimelineRowView = memo(function TimelineRowView({ item, sessionId, onFindFile }: { item: RenderTimelineItem; sessionId: string; onFindFile: (fileId: string) => void }) {
  if (item.kind === 'message') return <div className={`turn-segment ${item.role}`}><Message item={item} sessionId={sessionId} /></div>
  if (item.kind === 'trace') return <div className="turn-segment trace-segment"><TraceDisclosure events={item.events} sessionId={sessionId} /></div>
  if (item.kind === 'media') return <MediaRow item={item} sessionId={sessionId} onFindFile={onFindFile} />
  if (item.kind === 'job') return <JobView item={item} sessionId={sessionId} />
  return <SystemView item={item} sessionId={sessionId} />
})

function MediaRow({ item, sessionId, onFindFile }: { item: MediaItem; sessionId: string; onFindFile: (fileId: string) => void }) {
  return <div className="turn-segment media-segment"><MediaGrid files={item.files} sessionId={sessionId} onFind={file => onFindFile(file.id)} /></div>
}

function Message({ item, sessionId }: { item: MessageItem; sessionId: string }) {
  const { event, events, role, files } = item
  const primary = events[0] ?? event
  const text = messageItemText(item)
  const [copied, setCopied] = useState(false)
  const pin = async () => {
    const pinned: PinnedItem = {
      id: `message:${primary.id}`, sessionId, kind: 'message', eventId: primary.id,
      title: role === 'user' ? 'You' : 'Assistant', body: text, subtitle: formatTime(event.ts), createdAt: Date.now()
    }
    await window.agentsDock.pins.put(pinned)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  const copy = async () => { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }
  return (
    <div className={`message-row ${role}`} data-event-id={primary.id} data-event-count={events.length}>
      <div className="message-surface">
        <header>
          <span>{role === 'user' ? 'You' : primary.purpose === 'handoff_digest' ? 'Digest' : 'Assistant'}</span>
          <time>{formatTime(event.ts)}</time>
          <button title="Pin" onClick={() => void pin()}><Pin size={12} /></button>
          <button title="Copy full message" onClick={() => void copy()}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>
        </header>
        <div className="message-parts">
          {events.map(part => <MarkdownContent key={part.id} text={messageText(part)} files={files} sessionId={sessionId} />)}
        </div>
      </div>
    </div>
  )
}

function TraceDisclosure({ events, sessionId }: { events: Event[]; sessionId: string }) {
  const [open, setOpen] = useState(false)
  const tools = events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished')
  const thoughts = events.filter(event => event.type === 'reasoning_summary')
  const canonicalDiff = [...events].reverse().find(event => event.type === 'code_diff' && event.run_id)
  const diff = useMemo(() => extractUnifiedDiff(events), [events])
  const legacyFiles = useMemo(() => parseUnifiedDiff(diff), [diff])
  const diffFiles = canonicalDiff?.diff_files ?? legacyFiles
  const diffFileCount = canonicalDiff?.files_changed ?? diffFiles.length
  const additions = canonicalDiff?.additions ?? legacyFiles.reduce((sum, file) => sum + file.additions, 0)
  const deletions = canonicalDiff?.deletions ?? legacyFiles.reduce((sum, file) => sum + file.deletions, 0)
  const openReview = () => {
    const target: CodeReviewTarget = {
      sessionId,
      runId: canonicalDiff?.run_id,
      source: canonicalDiff ? null : diff,
      files: canonicalDiff?.diff_files,
      additions,
      deletions
    }
    window.dispatchEvent(new CustomEvent<CodeReviewTarget>('agentsdock:review-diff', { detail: target }))
  }
  const headline = thoughts.at(-1)?.text?.split('\n')[0]?.replace(/^\*\*|\*\*$/g, '') || toolHeadline(tools.at(-1))
  return (
    <div className={`trace ${open ? 'open' : ''}`}>
      <button className="trace-summary" onClick={() => setOpen(value => !value)}>
        <ChevronRight size={14} /><Code2 size={14} /><strong>{tools.length ? `Ran ${Math.ceil(tools.length / 2)} tools` : 'Reasoning trace'}</strong><small>{thoughts.length ? `${thoughts.length} thought${thoughts.length === 1 ? '' : 's'}` : ''}</small><span>{headline}</span>
      </button>
      {open && <div className="trace-details">
        {thoughts.map(event => <div className="trace-thought" key={event.id}><Sparkles size={13} /><MarkdownContent text={event.text || ''} sessionId={sessionId} compact fold={false} /></div>)}
        {tools.map(event => <ToolEvent key={event.id} event={event} />)}
      </div>}
      {diffFileCount > 0 && <CodeChangesCard fileCount={diffFileCount} additions={additions} deletions={deletions} onOpen={openReview} />}
    </div>
  )
}

function ToolEvent({ event }: { event: Event }) {
  const text = event.type === 'tool_started' ? JSON.stringify(event.tool?.input ?? {}, null, 2) : event.output || event.message || ''
  return <details className="tool-event"><summary><Wrench size={13} /><strong>{event.tool?.name || (event.type === 'tool_started' ? 'Tool started' : 'Tool result')}</strong><small>{event.exit_code === 0 ? 'Success' : event.exit_code != null ? `Exit ${event.exit_code}` : ''}</small></summary><pre>{text.slice(0, 12000)}</pre></details>
}

function SystemView({ item, sessionId }: { item: SystemItem; sessionId: string }) {
  const event = item.event
  const error = isTimelineError(event)
  const digest = event.type.startsWith('handoff_digest_')
  const generating = event.type === 'handoff_digest_started'
  const icon = error ? <AlertTriangle size={15} /> : generating ? <LoaderCircle className="spin" size={15} /> : digest ? <Sparkles size={15} /> : <TerminalSquare size={15} />
  const text = messageText(event) || titleCase(event.type)
  return <article className={`system-row ${error ? 'error' : digest ? 'digest' : ''}`} data-event-id={event.id}><span className="system-icon">{icon}</span><div><header><strong>{titleCase(event.type)}</strong><time>{formatTime(event.ts)}</time><button title="Pin" onClick={() => void pinSystem(event, sessionId)}><Pin size={12} /></button></header><MarkdownContent text={text} sessionId={sessionId} compact /></div></article>
}

function JobView({ item, sessionId }: { item: JobItem; sessionId: string }) {
  const [open, setOpen] = useState(false)
  const updates = useMemo(() => jobDisplayEvents(item.events), [item.events])
  const latest = updates.at(-1) ?? item.latest
  const latestText = messageText(latest) || 'Scheduled job started. Waiting for agent output.'
  const previous = updates.slice(0, -1)
  const visiblePrevious = previous.slice(-6).reverse()
  const runCount = new Set(item.events.map(event => event.run_id).filter(Boolean)).size
  const codeDiff = [...item.events].reverse().find(event => event.type === 'code_diff' && event.run_id)
  const files = deduplicateFiles(item.events
    .filter(event => !latest.run_id || event.run_id === latest.run_id)
    .flatMap(event => [event.artifact, event.file].filter((file): file is NonNullable<typeof file> => Boolean(file))))
  const openReview = () => {
    if (!codeDiff?.run_id) return
    const target: CodeReviewTarget = {
      sessionId,
      runId: codeDiff.run_id,
      files: codeDiff.diff_files,
      additions: codeDiff.additions,
      deletions: codeDiff.deletions
    }
    window.dispatchEvent(new CustomEvent<CodeReviewTarget>('agentsdock:review-diff', { detail: target }))
  }
  return <article className="job-row"><button className="job-summary" onClick={() => setOpen(value => !value)}><Clock3 size={15} /><span><strong>Latest Job Status</strong><small>{item.title} · {runCount || updates.length} run{(runCount || updates.length) === 1 ? '' : 's'} · {formatTime(latest.ts)}</small></span><ChevronRight size={14} /></button><div className="job-latest"><MarkdownContent text={latestText} files={files} sessionId={sessionId} />{files.length > 0 && <MediaGrid files={files} sessionId={sessionId} compact />}{(codeDiff?.files_changed ?? codeDiff?.diff_files?.length ?? 0) > 0 ? <CodeChangesCard fileCount={codeDiff?.files_changed ?? codeDiff?.diff_files?.length ?? 0} additions={codeDiff?.additions ?? 0} deletions={codeDiff?.deletions ?? 0} onOpen={openReview} /> : null}</div>{open && previous.length > 0 && <div className="job-history">{previous.length > visiblePrevious.length && <p>{previous.length - visiblePrevious.length} earlier runs hidden</p>}{visiblePrevious.map(event => <details key={event.id}><summary>{formatTime(event.ts)} · {titleCase(event.type)}</summary><MarkdownContent text={messageText(event)} sessionId={sessionId} compact /></details>)}</div>}</article>
}

function CodeChangesCard({ fileCount, additions, deletions, onOpen }: { fileCount: number; additions: number; deletions: number; onOpen: () => void }) {
  return <button className="changes-card" onClick={onOpen}><FileText size={17} /><span><strong>Edited {fileCount} file{fileCount === 1 ? '' : 's'}</strong><small><b>+{additions}</b> <i>-{deletions}</i></small></span><span className="review-label">Review</span></button>
}

function deduplicateFiles<T extends { id: string }>(files: T[]): T[] {
  return [...new Map(files.map(file => [file.id, file])).values()]
}

async function pinSystem(event: Event, sessionId: string) {
  const text = messageText(event)
  await window.agentsDock.pins.put({ id: `message:${event.id}`, sessionId, kind: 'message', eventId: event.id, title: titleCase(event.type), body: text, subtitle: formatTime(event.ts), createdAt: Date.now() })
  window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
}

function toolHeadline(event?: Event): string {
  if (!event) return ''
  const command = event.tool?.input && typeof event.tool.input === 'object' && !Array.isArray(event.tool.input) && 'command' in event.tool.input ? String(event.tool.input.command) : ''
  return command || event.tool?.name || ''
}
