import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Check, ChevronDown, Play, Search, X } from 'lucide-react-native'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Backend, CreateJobInput, RuntimeOption, Session } from '../types'
import { BackendMark } from './BackendMark'
import { IconButton } from './ui'

export function SettingsDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = usePalette()
  const currentURL = useAppStore(state => state.serverURL)
  const currentToken = useAppStore(state => state.token)
  const connecting = useAppStore(state => state.connecting)
  const apply = useAppStore(state => state.applySettings)
  const [url, setURL] = useState(currentURL)
  const [token, setToken] = useState(currentToken)
  useEffect(() => { if (visible) { setURL(currentURL); setToken(currentToken) } }, [currentToken, currentURL, visible])
  return <Sheet visible={visible} title="Settings" onClose={onClose}>
    <Label text="Server address" /><TextInput value={url} onChangeText={setURL} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="100.x.y.z:7850" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Access token" /><TextInput value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Server token" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Text style={[styles.help, { color: colors.muted }]}>The address stays exactly as typed while editing. It is normalized only after Apply. HTTP is allowed for private LAN and Tailscale servers.</Text>
    <PrimaryButton label={connecting ? 'Connecting…' : 'Apply & reconnect'} disabled={connecting || !url.trim()} onPress={() => void apply(url, token).then(onClose)} />
  </Sheet>
}

export function NewChatDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = usePalette()
  const runtime = useAppStore(state => state.runtime)
  const health = useAppStore(state => state.health)
  const create = useAppStore(state => state.createSession)
  const [title, setTitle] = useState('New chat')
  const [folder, setFolder] = useState('General')
  const [cwd, setCwd] = useState(health?.default_cwd ?? '')
  const [backend, setBackend] = useState<Backend>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [providerId, setProviderId] = useState('')
  const models = runtime?.backends[backend]?.models ?? []
  const efforts = runtime?.backends[backend]?.efforts ?? []
  return <Sheet visible={visible} title="New chat" onClose={onClose}>
    <Label text="Name" /><TextInput value={title} onChangeText={setTitle} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Backend" /><View style={styles.segment}>{(['claude', 'codex'] as Backend[]).map(value => <Pressable key={value} onPress={() => { setBackend(value); setModel(''); setEffort('') }} style={[styles.segmentButton, { backgroundColor: backend === value ? colors.blue : colors.raised }]}><BackendMark backend={value} size={20} /><Text style={{ color: backend === value ? 'white' : colors.text, fontWeight: '700' }}>{value === 'claude' ? 'Claude' : 'Codex'}</Text></Pressable>)}</View>
    <Label text="Model" /><Select value={model} options={[{ value: '', label: runtime?.backends[backend]?.default_model || 'Server model' }, ...models]} onChange={setModel} />
    <Label text="Effort" /><Select value={effort} options={[{ value: '', label: runtime?.backends[backend]?.default_effort || 'Default' }, ...efforts]} onChange={setEffort} />
    <Label text="Folder" /><TextInput value={folder} onChangeText={setFolder} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Working directory" /><TextInput value={cwd} onChangeText={setCwd} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Resume provider session (optional)" /><TextInput value={providerId} onChangeText={setProviderId} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <PrimaryButton label={providerId.trim() ? 'Resume chat' : 'Create chat'} disabled={!title.trim()} onPress={() => void create({ title: title.trim(), folder: folder.trim() || 'General', cwd: cwd.trim(), backend, model, effort, providerId: providerId.trim() || undefined }).then(onClose)} />
  </Sheet>
}

export function SearchDialog({ visible, sessionId, onClose }: { visible: boolean; sessionId?: string; onClose: () => void }) {
  const colors = usePalette()
  const sessions = useAppStore(state => state.sessions)
  const results = useAppStore(state => state.searchResults)
  const busy = useAppStore(state => state.searchBusy)
  const search = useAppStore(state => state.search)
  const select = useAppStore(state => state.selectSession)
  const clear = useAppStore(state => state.clearSearch)
  const [query, setQuery] = useState('')
  useEffect(() => { const timer = setTimeout(() => { if (query.trim()) void search(query, sessionId); else clear() }, 230); return () => clearTimeout(timer) }, [clear, query, search, sessionId])
  const nameMatches = useMemo(() => sessionId ? [] : sessions.filter(value => value.title.toLowerCase().includes(query.trim().toLowerCase())), [query, sessionId, sessions])
  const resultRows = results.filter(result => !nameMatches.some(session => session.id === result.session_id))
  const open = (id: string) => { void select(id); onClose() }
  return <Sheet visible={visible} title={sessionId ? 'Find in chat' : 'Search'} onClose={onClose} wide>
    <View style={[styles.searchBox, { backgroundColor: colors.raised, borderColor: colors.border }]}><Search size={16} color={colors.muted} /><TextInput autoFocus value={query} onChangeText={setQuery} placeholder="Search names and complete chat history" placeholderTextColor={colors.muted} style={{ flex: 1, color: colors.text, fontSize: 14 }} />{busy ? <ActivityIndicator size="small" color={colors.blue} /> : null}</View>
    <ScrollView style={{ maxHeight: 500 }} keyboardShouldPersistTaps="handled">
      {nameMatches.map(session => <SearchResult key={`name:${session.id}`} title={session.title} subtitle="Chat name" onPress={() => open(session.id)} />)}
      {resultRows.map(result => <SearchResult key={`${result.session_id}:${result.event_id}`} title={sessions.find(value => value.id === result.session_id)?.title ?? 'Chat'} subtitle={result.snippet} onPress={() => open(result.session_id)} />)}
      {query.trim() && !busy && !nameMatches.length && !resultRows.length ? <Text style={[styles.empty, { color: colors.muted }]}>No matches</Text> : null}
    </ScrollView>
  </Sheet>
}

export function DigestDialog({ visible, source, onClose }: { visible: boolean; source: Session | null; onClose: () => void }) {
  const colors = usePalette()
  const allSessions = useAppStore(state => state.sessions)
  const sessions = useMemo(() => allSessions.filter(value => !value.archived && value.id !== source?.id), [allSessions, source?.id])
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('balanced')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  if (!source) return null
  const generate = async () => { if (!target) return; setBusy(true); try { setPreview(await client.previewDigest(source.id, target, detail, prompt)) } finally { setBusy(false) } }
  const send = async () => { if (!target) return; setBusy(true); try { await client.sendDigest(source.id, target, detail, prompt); onClose() } finally { setBusy(false) } }
  return <Sheet visible={visible} title="Create digest" onClose={onClose} wide>
    <Label text="Target chat" /><Select value={target} options={[{ value: '', label: 'Choose chat' }, ...sessions.map(value => ({ value: value.id, label: value.title }))]} onChange={setTarget} />
    <Label text="Detail" /><Select value={detail} options={[{ value: 'concise', label: 'Concise' }, { value: 'balanced', label: 'Balanced' }, { value: 'detailed', label: 'Detailed' }]} onChange={setDetail} />
    <Label text="Prompt for source agent" /><TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="What should the digest emphasize?" placeholderTextColor={colors.muted} style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    {preview ? <ScrollView style={[styles.preview, { backgroundColor: colors.raised }]}><Text selectable style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{preview}</Text></ScrollView> : null}
    <View style={styles.buttonRow}><SecondaryButton label={busy ? 'Working…' : 'Preview'} disabled={busy || !target} onPress={() => void generate()} /><PrimaryButton label={busy ? 'Working…' : 'Send to chat'} disabled={busy || !target} onPress={() => void send()} /></View>
  </Sheet>
}

export function JobDialog({ visible, session: session, onClose }: { visible: boolean; session: Session | null; onClose: () => void }) {
  const colors = usePalette()
  const create = useAppStore(state => state.createJob)
  const [title, setTitle] = useState('Status check')
  const [prompt, setPrompt] = useState('Check the current status and report meaningful changes.')
  const [interval, setIntervalValue] = useState('3600')
  const [loop, setLoop] = useState(true)
  const [maxRuns, setMaxRuns] = useState('1')
  const [start, setStart] = useState('')
  if (!session) return null
  const submit = async () => {
    const body: CreateJobInput = { session_id: session.id, title: title.trim(), prompt: prompt.trim(), interval_seconds: Math.max(60, Number(interval) || 3600), first_run_at: start.trim() || null, loop, max_runs: loop ? null : Math.max(1, Number(maxRuns) || 1), enabled: true, backend: session.backend, model: session.model, effort: session.effort }
    await create(body); onClose()
  }
  return <Sheet visible={visible} title="Schedule job" onClose={onClose} wide>
    <Label text="Title" /><TextInput value={title} onChangeText={setTitle} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text="Prompt" /><TextInput value={prompt} onChangeText={setPrompt} multiline style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text="Interval"><View style={styles.presetRow}>{[300, 900, 3600, 21600, 86400].map(value => <Pressable key={value} onPress={() => setIntervalValue(String(value))} style={[styles.preset, { backgroundColor: interval === String(value) ? colors.blue : colors.raised }]}><Text style={{ color: interval === String(value) ? 'white' : colors.text, fontSize: 11 }}>{value < 3600 ? `${value / 60}m` : value < 86400 ? `${value / 3600}h` : '1d'}</Text></Pressable>)}</View></Label>
    <TextInput value={interval} onChangeText={setIntervalValue} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text="First run (ISO, optional)" /><TextInput value={start} onChangeText={setStart} autoCapitalize="none" placeholder="2026-07-11T18:00:00-07:00" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <View style={styles.toggle}><Text style={{ color: colors.text, flex: 1 }}>Loop forever</Text><Switch value={loop} onValueChange={setLoop} /></View>
    {!loop ? <><Label text="Number of runs" /><TextInput value={maxRuns} onChangeText={setMaxRuns} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /></> : null}
    <PrimaryButton label="Schedule" disabled={!title.trim() || !prompt.trim()} onPress={() => void submit()} />
  </Sheet>
}

export function ProcessDialog({ visible, sessionId, onClose }: { visible: boolean; sessionId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const inspect = useAppStore(state => state.inspectProcesses)
  const snapshot = useAppStore(state => sessionId ? state.processes[sessionId] : undefined)
  useEffect(() => { if (visible && sessionId) void inspect(sessionId) }, [inspect, sessionId, visible])
  return <Sheet visible={visible} title="Live processes" onClose={onClose} wide>
    <ScrollView style={{ maxHeight: 560 }}>{snapshot?.processes.length ? snapshot.processes.map(process => <View key={process.pid} style={[styles.process, { backgroundColor: colors.raised }]}><View style={[styles.processDot, { backgroundColor: colors.green }]} /><View style={{ flex: 1 }}><Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'Menlo' }}>{process.command || process.args}</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{process.cwd} · pid {process.pid} · CPU {process.cpu_percent ?? 0}% · {Math.round((process.rss_kb ?? 0) / 1024)} MB</Text></View></View>) : <Text style={[styles.empty, { color: colors.muted }]}>No live processes for this chat.</Text>}{snapshot?.stdout_tail?.text ? <Text selectable style={[styles.log, { color: colors.text, backgroundColor: '#090b0e' }]}>{snapshot.stdout_tail.text}</Text> : null}</ScrollView>
    <SecondaryButton label="Refresh" onPress={() => sessionId && void inspect(sessionId)} />
  </Sheet>
}

function Sheet({ visible, title, onClose, children, wide }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const colors = usePalette()
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={styles.backdrop}><View style={[styles.sheet, wide && styles.sheetWide, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.sheetHeader}><Text style={[styles.sheetTitle, { color: colors.text }]}>{title}</Text><IconButton icon={X} onPress={onClose} label="Close" /></View><ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">{children}</ScrollView></View></View></Modal>
}
function Label({ text, children }: { text: string; children?: React.ReactNode }) { const colors = usePalette(); return <View style={styles.labelRow}><Text style={[styles.label, { color: colors.muted }]}>{text}</Text>{children}</View> }
function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) { const colors = usePalette(); return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primary, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={styles.primaryText}>{label}</Text></Pressable> }
function SecondaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) { const colors = usePalette(); return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondary, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={{ color: colors.text, fontWeight: '700' }}>{label}</Text></Pressable> }
function SearchResult({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) { const colors = usePalette(); return <Pressable onPress={onPress} style={[styles.result, { borderColor: colors.border }]}><Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>{title}</Text><Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }} numberOfLines={3}>{subtitle}</Text></Pressable> }

function Select({ value, options, onChange }: { value: string; options: RuntimeOption[]; onChange: (value: string) => void }) {
  const colors = usePalette(); const [open, setOpen] = useState(false); const deduped = options.filter((option, index) => options.findIndex(value => value.value === option.value) === index); const selected = deduped.find(option => option.value === value) ?? deduped[0]
  return <><Pressable onPress={() => setOpen(true)} style={[styles.select, { backgroundColor: colors.raised, borderColor: colors.border }]}><Text style={{ color: colors.text, flex: 1 }}>{selected?.label ?? 'Choose'}</Text><ChevronDown size={15} color={colors.muted} /></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><Pressable style={styles.backdrop} onPress={() => setOpen(false)}><View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}><ScrollView>{deduped.map(option => <Pressable key={option.value || '__default'} onPress={() => { onChange(option.value); setOpen(false) }} style={[styles.option, { backgroundColor: value === option.value ? colors.raised : 'transparent' }]}>{value === option.value ? <Check size={15} color={colors.blue} /> : <View style={{ width: 15 }} />}<Text style={{ color: colors.text }}>{option.label}</Text></Pressable>)}</ScrollView></View></Pressable></Modal></>
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 18 }, sheet: { width: '100%', maxWidth: 520, maxHeight: '88%', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }, sheetWide: { maxWidth: 760 },
  sheetHeader: { height: 53, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' }, sheetTitle: { flex: 1, fontSize: 16, fontWeight: '800' }, sheetBody: { paddingHorizontal: 16, paddingBottom: 18, gap: 8 },
  labelRow: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }, label: { fontSize: 11, fontWeight: '700' }, help: { fontSize: 11, lineHeight: 16 },
  input: { height: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, fontSize: 14 }, textarea: { minHeight: 110, maxHeight: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 10, fontSize: 14, textAlignVertical: 'top' },
  segment: { flexDirection: 'row', gap: 6 }, segmentButton: { flex: 1, minHeight: 40, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primary: { minHeight: 43, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, primaryText: { color: 'white', fontWeight: '800' }, secondary: { minHeight: 43, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 7 },
  select: { minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' }, menu: { width: '100%', maxWidth: 440, maxHeight: '70%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 6 }, option: { minHeight: 42, borderRadius: 5, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchBox: { height: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, result: { minHeight: 58, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth }, empty: { padding: 24, textAlign: 'center' },
  preview: { maxHeight: 280, borderRadius: 6, padding: 10 }, presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 }, preset: { minWidth: 42, minHeight: 29, borderRadius: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 }, toggle: { minHeight: 42, flexDirection: 'row', alignItems: 'center' },
  process: { minHeight: 58, borderRadius: 6, padding: 9, marginBottom: 6, flexDirection: 'row', gap: 8 }, processDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 }, log: { padding: 10, borderRadius: 6, fontFamily: 'Menlo', fontSize: 11, lineHeight: 16 },
})
