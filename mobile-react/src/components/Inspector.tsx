import { useEffect, useMemo, useState } from 'react'
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Archive, ChevronDown, Copy, FileText, GitFork, Pause, Pencil, Pin, Play, Plus, RefreshCw, Search, SquareTerminal, Trash2, X } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Backend, RuntimeOption } from '../types'
import { BackendMark } from './BackendMark'
import { MediaGrid } from './MediaGrid'
import { IconButton, SectionHeader } from './ui'

export function Inspector({ sessionId, onDigest, onJob, onTerminal, onProcesses, onTmux }: { sessionId: string; onDigest: () => void; onJob: (jobId?: string) => void; onTerminal: () => void; onProcesses: () => void; onTmux: () => void }) {
  const colors = usePalette()
  const session = useAppStore(state => state.sessions.find(value => value.id === sessionId))
  const snapshot = useAppStore(state => state.snapshots[sessionId])
  const runtime = useAppStore(state => state.runtime)
  const allJobs = useAppStore(state => state.jobs)
  const allPins = useAppStore(state => state.pins)
  const jobs = useMemo(() => allJobs.filter(value => value.session_id === sessionId), [allJobs, sessionId])
  const pins = useMemo(() => allPins.filter(value => value.sessionId === sessionId), [allPins, sessionId])
  const update = useAppStore(state => state.updateSession)
  const fork = useAppStore(state => state.forkSession)
  const remove = useAppStore(state => state.deleteSession)
  const removePin = useAppStore(state => state.removePin)
  const runJob = useAppStore(state => state.runJob)
  const updateJob = useAppStore(state => state.updateJob)
  const refreshJobs = useAppStore(state => state.refreshJobs)
  const deleteJob = useAppStore(state => state.deleteJob)
  const refreshFiles = useAppStore(state => state.refreshFiles)
  const [title, setTitle] = useState(session?.title ?? '')
  const [folder, setFolder] = useState(session?.folder ?? 'General')
  const [cwd, setCwd] = useState(session?.cwd ?? '')
  const [mediaOpen, setMediaOpen] = useState(false)
  const [pinPreviewId, setPinPreviewId] = useState<string | null>(null)
  useEffect(() => { setTitle(session?.title ?? ''); setFolder(session?.folder ?? 'General'); setCwd(session?.cwd ?? '') }, [session?.cwd, session?.folder, session?.title])
  useEffect(() => { void refreshJobs() }, [refreshJobs, sessionId])
  if (!session) return null
  const locked = Boolean(session.session_id || session.claude_session_id || session.codex_thread_id)
  const catalog = runtime?.backends[session.backend]
  const modelOptions = withDefault(catalog?.models ?? [], catalog?.default_model, 'Server model')
  const effortOptions = withDefault(catalog?.efforts ?? [], catalog?.default_effort, 'Default')
  return <ScrollView style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border }]} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title="Session" />
      <Field label="Name"><TextInput value={title} onChangeText={setTitle} onBlur={() => { const clean = title.trim(); if (clean && clean !== session.title) void update(sessionId, { title: clean }) }} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
      <Field label="Backend"><View style={styles.segment}>{(['claude', 'codex'] as Backend[]).map(backend => <Pressable key={backend} disabled={locked} onPress={() => void update(sessionId, { backend })} style={[styles.segmentButton, { backgroundColor: session.backend === backend ? colors.blue : colors.surface, opacity: locked && session.backend !== backend ? 0.35 : 1 }]}><BackendMark backend={backend} size={18} /><Text style={{ color: session.backend === backend ? 'white' : colors.text, fontSize: 12, fontWeight: '700' }}>{backend === 'claude' ? 'Claude' : 'Codex'}</Text></Pressable>)}</View></Field>
      <Field label="Model"><ChoiceField value={session.model ?? ''} options={modelOptions} onChange={model => void update(sessionId, { model })} /></Field>
      <Field label="Effort"><ChoiceField value={session.effort ?? ''} options={effortOptions} onChange={effort => void update(sessionId, { effort })} /></Field>
      <Field label="Folder"><TextInput value={folder} onChangeText={setFolder} onBlur={() => void update(sessionId, { folder: folder.trim() || 'General' })} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
      <Field label="Working directory"><TextInput value={cwd} onChangeText={setCwd} onBlur={() => void update(sessionId, { cwd: cwd.trim() })} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
    </View>

    <View style={styles.commandGrid}>
      <Command icon={GitFork} label="Fork" onPress={() => void fork(sessionId)} />
      <Command icon={FileText} label="Digest" onPress={onDigest} />
      <Command icon={Pin} label={session.pinned ? 'Unpin' : 'Pin'} onPress={() => void update(sessionId, { pinned: !session.pinned })} />
      <Command icon={Archive} label={session.archived ? 'Unarchive' : 'Archive'} onPress={() => void update(sessionId, { archived: !session.archived })} />
      <Command icon={SquareTerminal} label="Terminal" onPress={onTerminal} />
      <Command icon={Search} label="Processes" onPress={onProcesses} />
      <Command icon={SquareTerminal} label="Tmux panes" onPress={onTmux} />
      <Command icon={Trash2} label="Delete" destructive onPress={() => Alert.alert('Delete chat?', 'This removes the chat from the server.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void remove(sessionId) }])} />
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title={`Pinned ${pins.length}`} />
      {pins.length ? pins.map(pin => <View key={pin.id} style={styles.pinRow}><Pressable onPress={() => setPinPreviewId(pin.id)} style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{pin.title}</Text>{pin.body ? <Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={2}>{pin.body}</Text> : <Text style={{ color: colors.muted, fontSize: 10 }}>Pinned file</Text>}</Pressable><IconButton icon={X} size={13} onPress={() => void removePin(pin.id)} label="Unpin" /></View>) : <Text style={[styles.hint, { color: colors.muted }]}>Pin important messages or files from the timeline.</Text>}
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title="Run" />
      <View style={styles.stats}><Stat label="Events" value={snapshot?.total ?? snapshot?.events.length ?? 0} /><Stat label="Files" value={snapshot?.filesTotal ?? snapshot?.files.length ?? 0} /><Stat label="Queued" value={snapshot?.queuedTurns.length ?? 0} /><Stat label="Jobs" value={jobs.length} /></View>
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <Pressable onPress={() => setMediaOpen(value => !value)} style={styles.disclosure}><SectionHeader title={`Media & files ${snapshot?.files.length ?? 0}/${snapshot?.filesTotal ?? 0}`} /><ChevronDown size={15} color={colors.muted} /></Pressable>
      {mediaOpen && snapshot?.files.length ? <><MediaGrid files={[...snapshot.files].reverse()} sessionId={sessionId} compact /><Pressable onPress={() => void refreshFiles(sessionId, true)} style={[styles.loadMore, { backgroundColor: colors.surface }]}><Text style={{ color: colors.muted, fontSize: 11 }}>Load more</Text></Pressable></> : null}
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title={`Jobs ${jobs.length}`} trailing={<View style={styles.headerActions}><IconButton icon={RefreshCw} size={15} onPress={() => void refreshJobs()} label="Refresh jobs" /><Pressable accessibilityRole="button" accessibilityLabel="Schedule job" testID="schedule-job" onPress={() => onJob()} style={[styles.scheduleJob, { backgroundColor: colors.surface }]}><Plus size={14} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 10, fontWeight: '800' }}>Schedule</Text></Pressable></View>} />
      {!jobs.length ? <Text style={[styles.hint, { color: colors.muted }]}>No scheduled jobs for this chat.</Text> : null}
      {jobs.map(job => <View key={job.id} style={[styles.jobRow, { opacity: job.enabled === false ? 0.62 : 1 }]}><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{job.title}</Text><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={2}>{job.loop ? `Every ${formatInterval(job.interval_seconds)}` : `Run ${job.max_runs ?? 1} time${job.max_runs === 1 ? '' : 's'}`} · {job.run_count ?? 0} runs{job.enabled === false ? ' · paused' : nextRunLabel(job.next_run_at_iso)}</Text></View><IconButton icon={Pencil} size={14} onPress={() => onJob(job.id)} label="Edit job" /><IconButton icon={job.enabled === false ? Play : Pause} size={14} onPress={() => void updateJob(job.id, { enabled: job.enabled === false })} label={job.enabled === false ? 'Enable job' : 'Pause job'} /><IconButton icon={Play} size={14} onPress={() => void runJob(job.id)} label="Run now" /><IconButton icon={Trash2} size={14} onPress={() => Alert.alert('Delete job?', `“${job.title}” will stop running.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => void deleteJob(job.id) }])} label="Delete job" /></View>)}
    </View>
    <Modal visible={pinPreviewId != null} transparent animationType="fade" onRequestClose={() => setPinPreviewId(null)}><Pressable style={styles.modalBackdrop} onPress={() => setPinPreviewId(null)}><Pressable style={[styles.pinPreview, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => {}}>{(() => { const pin = pins.find(value => value.id === pinPreviewId); const file = pin?.fileId ? snapshot?.files.find(value => value.id === pin.fileId) : null; return <><View style={styles.pinPreviewHeader}><Text style={[styles.pinPreviewTitle, { color: colors.text }]} numberOfLines={2}>{pin?.title ?? 'Pinned item'}</Text>{pin?.body ? <IconButton icon={Copy} size={15} onPress={() => void Clipboard.setStringAsync(pin.body ?? '')} label="Copy full text" /> : null}<IconButton icon={X} size={15} onPress={() => setPinPreviewId(null)} label="Close" /></View>{pin?.body ? <ScrollView style={{ maxHeight: 480 }}><Text selectable style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{pin.body}</Text></ScrollView> : file ? <MediaGrid files={[file]} sessionId={sessionId} /> : <Text style={{ color: colors.muted }}>This file is not in the loaded media page yet.</Text>}</> })()}</Pressable></Pressable></Modal>
  </ScrollView>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { const colors = usePalette(); return <View style={styles.field}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={{ flex: 1 }}>{children}</View></View> }
function Stat({ label, value }: { label: string; value: number }) { const colors = usePalette(); return <View style={styles.stat}><Text style={{ color: colors.muted, fontSize: 10 }}>{label}</Text><Text style={{ color: colors.text, fontSize: 14, fontWeight: '800' }}>{value.toLocaleString()}</Text></View> }
function Command({ icon: Icon, label, onPress, destructive }: { icon: typeof Pin; label: string; onPress: () => void; destructive?: boolean }) { const colors = usePalette(); return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.command, { backgroundColor: colors.raised, opacity: pressed ? 0.65 : 1 }]}><Icon size={15} color={destructive ? colors.red : colors.muted} /><Text style={{ color: destructive ? colors.red : colors.text, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable> }

function ChoiceField({ value, options, onChange }: { value: string; options: RuntimeOption[]; onChange: (value: string) => void }) {
  const colors = usePalette(); const [open, setOpen] = useState(false); const selected = options.find(option => option.value === value) ?? options[0]
  return <><Pressable onPress={() => setOpen(true)} style={[styles.choice, { borderColor: colors.border, backgroundColor: colors.surface }]}><Text style={{ flex: 1, color: colors.text, fontSize: 12 }} numberOfLines={1}>{selected?.label ?? (value || 'Default')}</Text><ChevronDown size={14} color={colors.muted} /></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}><View style={[styles.choiceMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}>{options.map(option => <Pressable key={option.value || '__default'} onPress={() => { onChange(option.value); setOpen(false) }} style={[styles.choiceOption, { backgroundColor: option.value === value ? colors.raised : 'transparent' }]}><Text style={{ color: colors.text }}>{option.label}</Text></Pressable>)}</View></Pressable></Modal></>
}
function withDefault(options: RuntimeOption[], defaultValue?: string | null, label = 'Default'): RuntimeOption[] { const fallback = defaultValue ? `${label} (${defaultValue})` : label; return options.some(option => option.value === '') ? options.map(option => option.value ? option : { ...option, label: fallback }) : [{ value: '', label: fallback }, ...options] }
function formatInterval(seconds: number): string { if (seconds % 86400 === 0) return `${seconds / 86400}d`; if (seconds % 3600 === 0) return `${seconds / 3600}h`; if (seconds % 60 === 0) return `${seconds / 60}m`; return `${seconds}s` }
function nextRunLabel(value?: string | null): string { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : ` · next ${date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` }

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 290, borderLeftWidth: StyleSheet.hairlineWidth }, content: { padding: 10, gap: 8, paddingBottom: 30 },
  card: { borderRadius: 7, padding: 8, gap: 7 }, field: { flexDirection: 'row', gap: 8, alignItems: 'center' }, label: { width: 70, fontSize: 10, fontWeight: '700' },
  input: { height: 32, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 8, fontSize: 12 }, segment: { flexDirection: 'row', gap: 4 }, segmentButton: { minHeight: 32, borderRadius: 5, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 5 },
  choice: { minHeight: 32, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center' },
  commandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 }, command: { minWidth: '30%', minHeight: 36, borderRadius: 6, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6 },
  hint: { fontSize: 10, paddingHorizontal: 5, paddingBottom: 5 }, pinRow: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 5 },
  stats: { flexDirection: 'row', flexWrap: 'wrap' }, stat: { width: '50%', padding: 7 }, disclosure: { flexDirection: 'row', alignItems: 'center' }, loadMore: { minHeight: 34, borderRadius: 5, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  jobRow: { minHeight: 45, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  headerActions: { flexDirection: 'row', alignItems: 'center' }, scheduleJob: { minHeight: 30, borderRadius: 5, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
  modalBackdrop: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 30 }, choiceMenu: { width: '100%', maxWidth: 380, maxHeight: '70%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 6 }, choiceOption: { minHeight: 42, borderRadius: 5, paddingHorizontal: 12, justifyContent: 'center' },
  pinPreview: { width: '100%', maxWidth: 680, maxHeight: '78%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 }, pinPreviewHeader: { minHeight: 38, flexDirection: 'row', alignItems: 'center' }, pinPreviewTitle: { flex: 1, fontSize: 14, fontWeight: '800' },
})
