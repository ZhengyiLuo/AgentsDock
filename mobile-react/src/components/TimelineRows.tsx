import { memo, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Clock3, Code2, Copy, Pin, Wrench } from 'lucide-react-native'
import type { TimelineRow } from '../lib/timeline'
import { isTimelineError, rowText } from '../lib/timeline'
import { formatTime, messageText } from '../lib/format'
import { scaleChatFont } from '../lib/typography'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { IconButton } from './ui'
import { MarkdownContent } from './MarkdownContent'
import { MediaGrid } from './MediaGrid'

const FOLD_AT = 5_000

export const TimelineRowView = memo(function TimelineRowView({ row, sessionId, onReview, fontScale, layoutWidth }: { row: TimelineRow; sessionId: string; onReview: (runId: string) => void; fontScale: number; layoutWidth: number }) {
  // layoutWidth deliberately participates in memo equality so recycled cells
  // are remeasured when the device rotates or an iPad split view changes size.
  void layoutWidth
  if (row.kind === 'message') return <MessageRowView row={row} sessionId={sessionId} fontScale={fontScale} />
  if (row.kind === 'trace') return <TraceRowView row={row} onReview={onReview} fontScale={fontScale} />
  if (row.kind === 'media') return <MediaRowView row={row} sessionId={sessionId} />
  if (row.kind === 'job') return <JobRowView row={row} fontScale={fontScale} />
  return <SystemRowView row={row} fontScale={fontScale} />
})

function MessageRowView({ row, sessionId, fontScale }: { row: Extract<TimelineRow, { kind: 'message' }>; sessionId: string; fontScale: number }) {
  const colors = usePalette()
  const pin = useAppStore(state => state.pinMessage)
  const removePin = useAppStore(state => state.removePin)
  const pinned = useAppStore(state => state.pins.some(value => value.id === `message:${row.events.at(-1)?.id}`))
  const full = useMemo(() => rowText(row), [row])
  const [expanded, setExpanded] = useState(false)
  const folded = full.length > FOLD_AT && !expanded
  const visible = folded ? `${full.slice(0, FOLD_AT).trimEnd()}\n\n…` : full
  const event = row.events.at(-1)!
  return (
    <View style={[styles.messageWrap, row.role === 'user' && styles.userAlign]}>
      <View style={[styles.message, row.role === 'user' ? { backgroundColor: colors.user, borderColor: colors.green } : { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.metaRow}>
          <Text style={[styles.author, { color: colors.muted }]}>{row.role === 'user' ? 'You' : 'Assistant'}</Text>
          <Text style={[styles.time, { color: colors.muted }]}>{formatTime(event.ts)}</Text>
          <IconButton icon={Pin} size={13} selected={pinned} label={pinned ? 'Unpin message' : 'Pin message'} onPress={() => void (pinned ? removePin(`message:${event.id}`) : pin(sessionId, event, full))} />
          <IconButton icon={Copy} size={13} label="Copy full text" onPress={() => void Clipboard.setStringAsync(full)} />
        </View>
        <MarkdownContent value={visible} fontScale={fontScale} />
        {folded ? (
          <Pressable onPress={() => setExpanded(true)} style={[styles.fold, { borderColor: colors.blue, backgroundColor: colors.raised }]}>
            <Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700' }}>{full.length - FOLD_AT} characters hidden · Show full text</Text>
          </Pressable>
        ) : full.length > FOLD_AT ? (
          <Pressable onPress={() => setExpanded(false)} style={styles.collapse}><Text style={{ color: colors.muted, fontSize: 12 }}>Collapse</Text></Pressable>
        ) : null}
        {row.files.length ? <MediaGrid files={row.files} sessionId={sessionId} /> : null}
      </View>
    </View>
  )
}

function TraceRowView({ row, onReview, fontScale }: { row: Extract<TimelineRow, { kind: 'trace' }>; onReview: (runId: string) => void; fontScale: number }) {
  const colors = usePalette()
  const [open, setOpen] = useState(false)
  const tools = row.events.filter(event => event.type === 'tool_started' || event.type === 'tool_finished')
  const thoughts = row.events.filter(event => event.type === 'reasoning_summary')
  const hasDiff = row.events.some(event => event.type === 'code_diff')
  return (
    <View style={styles.traceWrap}>
      <Pressable onPress={() => setOpen(value => !value)} style={[styles.traceHeader, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        {open ? <ChevronDown size={15} color={colors.muted} /> : <ChevronRight size={15} color={colors.muted} />}
        <Code2 size={14} color={colors.muted} />
        <Text style={[styles.traceTitle, { color: colors.text }]}>Trace</Text>
        <Text style={[styles.traceMeta, { color: colors.muted }]}>{tools.length} tools · {thoughts.length} thoughts</Text>
        {hasDiff && row.runId ? <Pressable onPress={() => onReview(row.runId!)} style={[styles.review, { backgroundColor: colors.surface }]}><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Review</Text></Pressable> : null}
      </Pressable>
      {open ? <View style={[styles.traceBody, { borderColor: colors.border }]}>
        {row.events.filter(event => event.type !== 'raw_event').map(event => (
          <View key={event.id} style={styles.traceEvent}>
            {event.type.includes('tool') ? <Wrench size={13} color={colors.orange} /> : <Code2 size={13} color={colors.blue} />}
            <View style={{ flex: 1 }}><Text style={[styles.traceEventType, { color: colors.muted }]}>{event.tool?.name || event.type.replaceAll('_', ' ')}</Text>{messageText(event).trim() ? <Text selectable style={[styles.traceText, { color: colors.text, fontSize: scaleChatFont(12, fontScale), lineHeight: scaleChatFont(17, fontScale) }]}>{messageText(event)}</Text> : null}</View>
          </View>
        ))}
      </View> : null}
    </View>
  )
}

function MediaRowView({ row, sessionId }: { row: Extract<TimelineRow, { kind: 'media' }>; sessionId: string }) {
  const colors = usePalette()
  return <View style={[styles.mediaRow, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={[styles.mediaTitle, { color: colors.text }]}>Files & media <Text style={{ color: colors.muted }}>{row.files.length}</Text></Text><MediaGrid files={row.files} sessionId={sessionId} /></View>
}

function JobRowView({ row, fontScale }: { row: Extract<TimelineRow, { kind: 'job' }>; fontScale: number }) {
  const colors = usePalette()
  const [open, setOpen] = useState(false)
  const latest = row.events.at(-1)!
  return <Pressable onPress={() => setOpen(value => !value)} style={[styles.job, { borderColor: colors.orange, backgroundColor: `${colors.orange}18` }]}>
    <View style={styles.jobHeader}><Clock3 size={16} color={colors.orange} /><Text style={[styles.jobTitle, { color: colors.text }]}>{row.title}</Text><Text style={[styles.time, { color: colors.muted }]}>{row.events.length} updates · {formatTime(latest.ts)}</Text>{open ? <ChevronDown size={15} color={colors.muted} /> : <ChevronRight size={15} color={colors.muted} />}</View>
    <Text selectable style={[styles.jobText, { color: colors.text, fontSize: scaleChatFont(14, fontScale), lineHeight: scaleChatFont(20, fontScale) }]} numberOfLines={open ? undefined : 3}>{open ? row.events.map(messageText).filter(Boolean).join('\n\n') : messageText(latest) || `Scheduled job ${latest.type.replaceAll('_', ' ')}`}</Text>
  </Pressable>
}

function SystemRowView({ row, fontScale }: { row: Extract<TimelineRow, { kind: 'system' }>; fontScale: number }) {
  const colors = usePalette()
  const error = isTimelineError(row.event)
  const text = messageText(row.event) || row.event.type.replaceAll('_', ' ')
  return <View style={[styles.system, { backgroundColor: error ? `${colors.red}18` : colors.surface, borderColor: error ? colors.red : colors.border }]}>
    {error ? <AlertTriangle size={16} color={colors.red} /> : <Check size={16} color={colors.blue} />}
    <View style={{ flex: 1 }}><Text style={[styles.systemTitle, { color: error ? colors.red : colors.muted }]}>{row.event.type.replaceAll('_', ' ')}</Text><Text selectable style={[styles.systemText, { color: error ? colors.red : colors.text, fontSize: scaleChatFont(13.5, fontScale), lineHeight: scaleChatFont(19, fontScale) }]}>{text}</Text></View>
  </View>
}

const styles = StyleSheet.create({
  messageWrap: { width: '100%', paddingHorizontal: 14 }, userAlign: { alignItems: 'flex-end' },
  message: { width: '100%', maxWidth: 940, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 12 },
  metaRow: { height: 26, flexDirection: 'row', alignItems: 'center', gap: 4 }, author: { fontSize: 10, fontWeight: '700' }, time: { fontSize: 10, marginRight: 'auto' },
  fold: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth }, collapse: { alignSelf: 'flex-start', paddingVertical: 5 },
  traceWrap: { paddingHorizontal: 14 }, traceHeader: { minHeight: 48, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
  traceTitle: { fontSize: 12, fontWeight: '700' }, traceMeta: { fontSize: 11, flex: 1 }, review: { borderRadius: 5, paddingHorizontal: 8, paddingVertical: 5 },
  traceBody: { marginHorizontal: 8, borderLeftWidth: StyleSheet.hairlineWidth, paddingVertical: 8, paddingLeft: 11, gap: 9 }, traceEvent: { flexDirection: 'row', gap: 8 }, traceEventType: { fontSize: 10, fontWeight: '700', textTransform: 'capitalize' }, traceText: { fontSize: 12, fontFamily: 'Menlo', lineHeight: 17, marginTop: 3 },
  mediaRow: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 10 }, mediaTitle: { fontSize: 12, fontWeight: '800' },
  job: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 }, jobHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 }, jobTitle: { flex: 1, fontSize: 12, fontWeight: '800' }, jobText: { fontSize: 14, lineHeight: 20 },
  system: { marginHorizontal: 14, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 12, flexDirection: 'row', gap: 10 }, systemTitle: { fontSize: 10, fontWeight: '800', textTransform: 'capitalize' }, systemText: { fontSize: 13.5, lineHeight: 19, marginTop: 4 },
})
