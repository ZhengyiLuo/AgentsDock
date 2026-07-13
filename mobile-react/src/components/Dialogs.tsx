import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { Check, ChevronDown, Copy, Minus, Plus, Search, SquareTerminal, X } from 'lucide-react-native'
import { CHAT_FONT_SCALE_MAX, CHAT_FONT_SCALE_MIN, CHAT_FONT_SCALE_STEP, scaleChatFont } from '../lib/typography'
import { orderedSessionSections } from '../lib/session-order'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Backend, CreateJobInput, RuntimeOption, Session, UpdateJobInput } from '../types'
import { BackendMark } from './BackendMark'
import { IconButton } from './ui'

export function SettingsDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const colors = usePalette()
  const currentURL = useAppStore(state => state.serverURL)
  const currentToken = useAppStore(state => state.token)
  const connecting = useAppStore(state => state.connecting)
  const fontScale = useAppStore(state => state.fontScale)
  const apply = useAppStore(state => state.applySettings)
  const setFontScale = useAppStore(state => state.setFontScale)
  const [url, setURL] = useState(currentURL)
  const [token, setToken] = useState(currentToken)
  useEffect(() => { if (visible) { setURL(currentURL); setToken(currentToken) } }, [currentToken, currentURL, visible])
  return <Sheet visible={visible} title="Settings" onClose={onClose}>
    <Label text="Server address" /><TextInput testID="settings-server-url" accessibilityLabel="Server address" value={url} onChangeText={setURL} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="100.x.y.z:7850" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Label text="Access token" /><TextInput testID="settings-access-token" accessibilityLabel="Access token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Server token" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]} />
    <Text style={[styles.help, { color: colors.muted }]}>The address stays exactly as typed while editing. It is normalized only after Apply. HTTP is allowed for private LAN and Tailscale servers.</Text>
    <Label text="Chat text size" />
    <View style={[styles.fontScale, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <IconButton icon={Minus} disabled={fontScale <= CHAT_FONT_SCALE_MIN} label="Decrease chat text size" onPress={() => setFontScale(fontScale - CHAT_FONT_SCALE_STEP)} />
      <View style={styles.fontScalePreview}>
        <Text style={[styles.fontScaleValue, { color: colors.muted }]}>{Math.round(fontScale * 100)}%</Text>
        <Text numberOfLines={2} style={{ color: colors.text, fontSize: scaleChatFont(15.5, fontScale), lineHeight: scaleChatFont(21, fontScale) }}>Messages and code resize immediately.</Text>
      </View>
      <IconButton icon={Plus} disabled={fontScale >= CHAT_FONT_SCALE_MAX} label="Increase chat text size" onPress={() => setFontScale(fontScale + CHAT_FONT_SCALE_STEP)} />
    </View>
    <Text style={[styles.help, { color: colors.muted }]}>Applies to chat messages, traces, queued turns, and the composer. Navigation stays compact.</Text>
    <PrimaryButton testID="settings-apply" label={connecting ? 'Connecting…' : 'Apply & reconnect'} disabled={connecting || !url.trim()} onPress={() => void apply(url, token).then(onClose)} />
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
  const select = useAppStore(state => state.selectSession)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Awaited<ReturnType<typeof client.searchTimeline>>>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!visible) { setQuery(''); setResults([]); setBusy(false); return }
    const clean = query.trim()
    if (!clean) { setResults([]); setBusy(false); return }
    let cancelled = false
    const timer = setTimeout(() => {
      setBusy(true)
      const request = sessionId ? client.searchTimeline(sessionId, clean) : client.searchSessions(clean)
      void request.then(value => { if (!cancelled) setResults(value) }).catch(() => { if (!cancelled) setResults([]) }).finally(() => { if (!cancelled) setBusy(false) })
    }, 230)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, sessionId, visible])
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
  const folderOrder = useAppStore(state => state.folderOrder)
  const sections = useMemo(
    () => orderedSessionSections(allSessions.filter(value => value.id !== source?.id), folderOrder, false),
    [allSessions, folderOrder, source?.id],
  )
  const sessions = useMemo(() => sections.flatMap(section => section.sessions), [sections])
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('normal')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [phase, setPhase] = useState<'idle' | 'preview' | 'send'>('idle')
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!visible) return
    setDetail('normal')
    setPrompt('')
    setPreview('')
    setStatus('')
    setPhase('idle')
  }, [source?.id, visible])
  useEffect(() => {
    if (visible && !sessions.some(value => value.id === target)) setTarget(sessions[0]?.id ?? '')
  }, [sessions, target, visible])
  if (!source) return null
  const busy = phase !== 'idle'
  const generate = async () => {
    if (!target) return
    setPhase('preview'); setStatus('Summarizing the source chat with its agent…')
    try {
      const value = await client.previewDigest(source.id, target, detail, prompt)
      setPreview(value)
      setStatus(`${value.length.toLocaleString()} character preview`)
    } catch (error) {
      setStatus(dialogError(error))
    } finally {
      setPhase('idle')
    }
  }
  const send = async () => {
    if (!target) return
    setPhase('send'); setStatus('Starting the digest turn in the source chat…')
    try {
      await client.sendDigest(source.id, target, detail, prompt)
      onClose()
    } catch (error) {
      setStatus(dialogError(error))
    } finally {
      setPhase('idle')
    }
  }
  return <Sheet visible={visible} title="Create digest" onClose={onClose} wide>
    <View style={[styles.digestSource, { backgroundColor: colors.raised, borderColor: colors.border }]}><BackendMark backend={source.backend} size={20} /><View style={{ flex: 1 }}><Text style={{ color: colors.muted, fontSize: 10, fontWeight: '800' }}>SOURCE CHAT</Text><Text style={{ color: colors.text, fontSize: 13, fontWeight: '800' }} numberOfLines={1}>{source.title}</Text></View></View>
    <Label text="Target chat" /><Select testID="digest-target" value={target} options={sections.flatMap(section => section.sessions.map(value => ({ value: value.id, label: `${section.title} · ${value.title}` })))} onChange={setTarget} />
    <Label text="Detail" /><Select testID="digest-detail" value={detail} options={[{ value: 'short', label: 'Short' }, { value: 'normal', label: 'Normal' }, { value: 'deep', label: 'Deep' }]} onChange={value => { setDetail(value); setPreview(''); setStatus('') }} />
    <Label text="Prompt for target agent" /><TextInput testID="digest-prompt" accessibilityLabel="Prompt for target agent" value={prompt} onChangeText={value => { setPrompt(value); if (preview) setStatus('Prompt changed · refresh the preview before sending') }} multiline placeholder="What should the target agent focus on?" placeholderTextColor={colors.muted} style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    {preview ? <ScrollView style={[styles.preview, { backgroundColor: colors.raised }]}><Text selectable style={{ color: colors.text, fontSize: 13, lineHeight: 19 }}>{preview}</Text></ScrollView> : null}
    <View style={styles.statusRow}>{busy ? <ActivityIndicator size="small" color={colors.blue} /> : null}<Text style={{ flex: 1, color: status && !busy && !preview ? colors.red : colors.muted, fontSize: 11 }}>{status || 'The source chat agent creates one focused handoff turn.'}</Text></View>
    <View style={styles.buttonRow}><SecondaryButton testID="digest-preview" label={phase === 'preview' ? 'Working…' : 'Preview'} disabled={busy || !target} onPress={() => void generate()} /><PrimaryButton testID="digest-send" label={phase === 'send' ? 'Sending…' : 'Send to chat'} disabled={busy || !target} onPress={() => void send()} /></View>
  </Sheet>
}

type JobStartMode = 'keep' | 'immediate' | 'interval' | 'time'

export function JobDialog({ visible, session, jobId, onClose }: { visible: boolean; session: Session | null; jobId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const jobs = useAppStore(state => state.jobs)
  const create = useAppStore(state => state.createJob)
  const update = useAppStore(state => state.updateJob)
  const job = jobs.find(value => value.id === jobId) ?? null
  const [title, setTitle] = useState('Status check')
  const [prompt, setPrompt] = useState('Check the current status and report meaningful changes.')
  const [interval, setIntervalValue] = useState('3600')
  const [startMode, setStartMode] = useState<JobStartMode>('interval')
  const [loop, setLoop] = useState(true)
  const [maxRuns, setMaxRuns] = useState('1')
  const [start, setStart] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [backend, setBackend] = useState<Backend>('codex')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState('')
  useEffect(() => {
    if (!visible) return
    setTitle(job?.title ?? 'Status check')
    setPrompt(job?.prompt ?? 'Check the current status and report meaningful changes.')
    setIntervalValue(String(job?.interval_seconds ?? 3600))
    setStartMode(job ? 'keep' : 'interval')
    setLoop(job?.loop ?? true)
    setMaxRuns(String(job?.max_runs ?? 1))
    setStart(localScheduleValue(job?.next_run_at_iso ?? job?.first_run_at ?? job?.next_run_at))
    setEnabled(job?.enabled ?? true)
    setBackend(job?.backend ?? session?.backend ?? 'codex')
    setSaving(false)
    setStatus('')
  }, [job, session?.backend, visible])
  if (!session) return null
  const submit = async () => {
    const intervalSeconds = Math.max(10, Number(interval) || 3600)
    let scheduledTime: string | null = null
    if (startMode === 'immediate') scheduledTime = new Date().toISOString()
    else if (startMode === 'interval') scheduledTime = job ? new Date(Date.now() + intervalSeconds * 1000).toISOString() : null
    else if (startMode === 'time') {
      scheduledTime = parseScheduleValue(start)
      if (!scheduledTime) { setStatus('Enter a valid date and time, for example 2026-07-12 18:30.'); return }
    }
    const body: CreateJobInput = {
      session_id: session.id,
      title: title.trim(),
      prompt: prompt.trim(),
      interval_seconds: intervalSeconds,
      first_run_at: scheduledTime,
      loop,
      max_runs: loop ? null : Math.min(999, Math.max(1, Number(maxRuns) || 1)),
      enabled,
      backend,
      model: backend === session.backend ? session.model : null,
      effort: backend === session.backend ? session.effort : null,
    }
    setSaving(true); setStatus(job ? 'Saving scheduled job…' : 'Creating scheduled job…')
    const saved = job
      ? await update(job.id, {
          title: body.title,
          prompt: body.prompt,
          interval_seconds: body.interval_seconds,
          ...(startMode === 'keep' ? {} : { next_run_at: scheduledTime }),
          loop: body.loop,
          max_runs: body.max_runs,
          enabled: body.enabled,
          backend: body.backend,
        } satisfies UpdateJobInput)
      : await create(body)
    setSaving(false)
    if (saved) onClose()
    else setStatus('The server did not save this scheduled job. Review the connection error and try again.')
  }
  return <Sheet visible={visible} title={job ? 'Edit job' : 'Schedule job'} onClose={onClose} wide>
    <Label text="Title" /><TextInput testID="job-title" accessibilityLabel="Job title" value={title} onChangeText={setTitle} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text="Backend" /><View style={styles.segment}>{(['claude', 'codex'] as Backend[]).map(value => <Pressable key={value} onPress={() => setBackend(value)} style={[styles.segmentButton, { backgroundColor: backend === value ? colors.blue : colors.raised }]}><BackendMark backend={value} size={20} /><Text style={{ color: backend === value ? 'white' : colors.text, fontWeight: '700' }}>{value === 'claude' ? 'Claude' : 'Codex'}</Text></Pressable>)}</View>
    <Label text="Interval" />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presetRow}>{[60, 300, 900, 1800, 3600, 7200, 14400, 28800, 43200, 86400, 604800].map(value => <Pressable key={value} onPress={() => setIntervalValue(String(value))} style={[styles.preset, { backgroundColor: interval === String(value) ? colors.blue : colors.raised }]}><Text style={{ color: interval === String(value) ? 'white' : colors.text, fontSize: 11 }}>{intervalLabel(value)}</Text></Pressable>)}</ScrollView>
    <Label text="Custom seconds" /><TextInput testID="job-interval" accessibilityLabel="Job interval seconds" value={interval} onChangeText={setIntervalValue} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    <Label text={job ? 'Next run' : 'First run'} />
    <View style={styles.modeRow}>{job ? <ModeButton label="Keep" selected={startMode === 'keep'} onPress={() => setStartMode('keep')} /> : null}<ModeButton label="Now" selected={startMode === 'immediate'} onPress={() => setStartMode('immediate')} /><ModeButton label="After interval" selected={startMode === 'interval'} onPress={() => setStartMode('interval')} /><ModeButton label="At a time" selected={startMode === 'time'} onPress={() => setStartMode('time')} /></View>
    {startMode === 'time' ? <TextInput testID="job-start-time" accessibilityLabel="Job start time" value={start} onChangeText={setStart} autoCapitalize="none" autoCorrect={false} placeholder="2026-07-12 18:30" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /> : <Text style={[styles.help, { color: colors.muted }]}>{startMode === 'keep' ? `Keeps ${job?.next_run_at_iso ? new Date(job.next_run_at_iso).toLocaleString() : 'the current schedule'}.` : startMode === 'immediate' ? 'Runs as soon as the scheduler can launch it.' : `First run is ${job ? 'reset to ' : ''}one interval from now.`}</Text>}
    <Label text="Mode" /><View style={styles.modeRow}><ModeButton label="Run fixed times" selected={!loop} onPress={() => setLoop(false)} /><ModeButton label="Loop forever" selected={loop} onPress={() => setLoop(true)} /></View>
    {!loop ? <><Label text="Number of runs" /><TextInput testID="job-run-count" accessibilityLabel="Number of job runs" value={maxRuns} onChangeText={setMaxRuns} keyboardType="number-pad" style={[styles.input, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} /></> : null}
    <View style={styles.toggle}><Text style={{ color: colors.text, flex: 1 }}>Enabled</Text><Switch value={enabled} onValueChange={setEnabled} /></View>
    <Label text="Prompt" /><TextInput testID="job-prompt" accessibilityLabel="Job prompt" value={prompt} onChangeText={setPrompt} multiline style={[styles.textarea, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]} />
    {status ? <Text style={{ color: status.startsWith('The server') || status.startsWith('Enter') ? colors.red : colors.muted, fontSize: 11 }}>{status}</Text> : null}
    <PrimaryButton testID="job-save" label={saving ? 'Saving…' : job ? 'Save job' : 'Schedule job'} disabled={saving || !title.trim() || !prompt.trim()} onPress={() => void submit()} />
  </Sheet>
}

export function ProcessDialog({ visible, sessionId, onClose }: { visible: boolean; sessionId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const inspect = useAppStore(state => state.inspectProcesses)
  const snapshot = useAppStore(state => sessionId ? state.processes[sessionId] : undefined)
  useEffect(() => { if (visible && sessionId) void inspect(sessionId) }, [inspect, sessionId, visible])
  return <Sheet visible={visible} title="Live processes" onClose={onClose} wide>
    <ScrollView style={{ maxHeight: 560 }}>{snapshot?.processes.length ? snapshot.processes.map(process => <View key={process.pid} style={[styles.process, { backgroundColor: colors.raised }]}><View style={[styles.processDot, { backgroundColor: colors.green }]} /><View style={{ flex: 1 }}><Text selectable style={{ color: colors.text, fontSize: 12, fontFamily: 'Menlo' }}>{process.command || process.args}</Text><Text style={{ color: colors.muted, fontSize: 10 }}>{process.cwd} · pid {process.pid} · CPU {process.cpu_percent ?? 0}% · {Math.round((process.rss_kb ?? 0) / 1024)} MB</Text></View><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync([process.command || process.args, process.cwd].filter(Boolean).join('\n'))} label="Copy process" /></View>) : <Text style={[styles.empty, { color: colors.muted }]}>No live processes for this chat.</Text>}{snapshot?.stdout_tail?.text ? <View><View style={styles.outputHeader}><Text style={[styles.outputTitle, { color: colors.muted }]}>Live stdout</Text><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync(snapshot.stdout_tail?.text ?? '')} label="Copy stdout" /></View><Text selectable style={[styles.log, { color: colors.text, backgroundColor: '#090b0e' }]}>{snapshot.stdout_tail.text}</Text></View> : null}</ScrollView>
    <View style={styles.buttonRow}><SecondaryButton label="Refresh" onPress={() => sessionId && void inspect(sessionId)} /></View>
  </Sheet>
}

export function TmuxDialog({ visible, sessionId, onClose }: { visible: boolean; sessionId: string | null; onClose: () => void }) {
  const colors = usePalette()
  const inspect = useAppStore(state => state.inspectTmux)
  const panes = useAppStore(state => sessionId ? state.tmuxPanes[sessionId] : undefined) ?? []
  const [includeAll, setIncludeAll] = useState(false)
  const [selectedPane, setSelectedPane] = useState<string | null>(null)
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (visible && sessionId) void inspect(sessionId, includeAll)
    if (!visible) { setSelectedPane(null); setOutput('') }
  }, [includeAll, inspect, sessionId, visible])
  const capture = async (paneId: string) => {
    if (!sessionId) return
    setSelectedPane(paneId); setBusy(true)
    try { setOutput(await client.captureTmux(sessionId, paneId, 500)) }
    finally { setBusy(false) }
  }
  return <Sheet visible={visible} title="Tmux submitters" onClose={onClose} wide>
    <View style={styles.toggle}><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontWeight: '700' }}>Machine-wide panes</Text><Text style={{ color: colors.muted, fontSize: 10 }}>Off shows panes linked to this chat.</Text></View><Switch value={includeAll} onValueChange={setIncludeAll} /></View>
    <ScrollView style={{ maxHeight: selectedPane ? 280 : 520 }}>
      {panes.length ? panes.map(pane => <Pressable key={pane.pane_id} onPress={() => void capture(pane.pane_id)} style={[styles.process, { backgroundColor: selectedPane === pane.pane_id ? colors.raised : colors.surface, borderColor: colors.border }]}><View style={[styles.processDot, { backgroundColor: pane.dead ? colors.muted : colors.green }]} /><SquareTerminal size={15} color={colors.muted} /><View style={{ flex: 1 }}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }}>{pane.session_name ?? 'tmux'}:{pane.window_name ?? pane.pane_index ?? pane.pane_id}</Text><Text selectable style={{ color: colors.muted, fontSize: 10, marginTop: 3 }} numberOfLines={2}>{pane.command || 'shell'} · {pane.current_path || pane.cwd || 'unknown directory'}</Text>{pane.tags?.length ? <Text style={{ color: colors.blue, fontSize: 10, marginTop: 3 }}>{pane.tags.join(' · ')}</Text> : null}</View></Pressable>) : <Text style={[styles.empty, { color: colors.muted }]}>No tmux panes linked to this chat.</Text>}
    </ScrollView>
    {selectedPane ? <View><View style={styles.outputHeader}><Text style={[styles.outputTitle, { color: colors.muted }]}>{busy ? 'Capturing output…' : `Output · ${selectedPane}`}</Text><IconButton icon={Copy} size={14} onPress={() => void Clipboard.setStringAsync(output)} label="Copy tmux output" /></View><ScrollView style={{ maxHeight: 250 }}><Text selectable style={[styles.log, { color: colors.text, backgroundColor: '#090b0e' }]}>{output || (busy ? 'Loading…' : 'No output.')}</Text></ScrollView></View> : null}
    <View style={styles.buttonRow}><SecondaryButton label="Refresh" onPress={() => sessionId && void inspect(sessionId, includeAll)} /></View>
  </Sheet>
}

function Sheet({ visible, title, onClose, children, wide }: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const colors = usePalette()
  const panel = <View
    testID={`sheet-${title.toLowerCase().replaceAll(' ', '-')}`}
    style={[styles.sheetPage, Platform.OS !== 'ios' && styles.sheet, wide && Platform.OS !== 'ios' && styles.sheetWide, { backgroundColor: colors.surface, borderColor: colors.border }]}
  >
    <SafeAreaView style={styles.sheetSafeArea} edges={['bottom']}>
      <View style={styles.sheetGrabber} />
      <View style={styles.sheetHeader}><Text style={[styles.sheetTitle, { color: colors.text }]}>{title}</Text><IconButton icon={X} onPress={onClose} label="Close" /></View>
      <ScrollView
        contentContainerStyle={styles.sheetBody}
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      >{children}</ScrollView>
    </SafeAreaView>
  </View>
  if (Platform.OS === 'ios') {
    return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={onClose}>{panel}</Modal>
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><Pressable style={styles.backdrop} onPress={onClose}><Pressable onPress={() => {}}>{panel}</Pressable></Pressable></Modal>
}
function Label({ text, children }: { text: string; children?: React.ReactNode }) { const colors = usePalette(); return <View style={styles.labelRow}><Text style={[styles.label, { color: colors.muted }]}>{text}</Text>{children}</View> }
function PrimaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primary, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={styles.primaryText}>{label}</Text></Pressable> }
function SecondaryButton({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondary, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}><Text style={{ color: colors.text, fontWeight: '700' }}>{label}</Text></Pressable> }
function ModeButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) { const colors = usePalette(); return <Pressable onPress={onPress} style={[styles.modeButton, { backgroundColor: selected ? colors.blue : colors.raised }]}><Text style={{ color: selected ? 'white' : colors.text, fontSize: 12, fontWeight: '700', textAlign: 'center' }}>{label}</Text></Pressable> }
function SearchResult({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) { const colors = usePalette(); return <Pressable onPress={onPress} style={[styles.result, { borderColor: colors.border }]}><Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>{title}</Text><Text style={{ color: colors.muted, fontSize: 11, marginTop: 4 }} numberOfLines={3}>{subtitle}</Text></Pressable> }

function Select({ value, options, onChange, testID }: { value: string; options: RuntimeOption[]; onChange: (value: string) => void; testID?: string }) {
  const colors = usePalette(); const [open, setOpen] = useState(false); const deduped = options.filter((option, index) => options.findIndex(value => value.value === option.value) === index); const selected = deduped.find(option => option.value === value) ?? deduped[0]
  return <><Pressable testID={testID} accessibilityRole="button" accessibilityLabel={selected?.label ?? 'Choose'} onPress={() => setOpen(true)} style={[styles.select, { backgroundColor: colors.raised, borderColor: colors.border }]}><Text style={{ color: colors.text, flex: 1 }} numberOfLines={1}>{selected?.label ?? 'Choose'}</Text><ChevronDown size={15} color={colors.muted} /></Pressable><Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}><Pressable style={styles.backdrop} onPress={() => setOpen(false)}><View style={[styles.menu, { backgroundColor: colors.surface, borderColor: colors.border }]}><ScrollView>{deduped.map(option => <Pressable key={option.value || '__default'} onPress={() => { onChange(option.value); setOpen(false) }} style={[styles.option, { backgroundColor: value === option.value ? colors.raised : 'transparent' }]}>{value === option.value ? <Check size={15} color={colors.blue} /> : <View style={{ width: 15 }} />}<Text style={{ color: colors.text, flex: 1 }}>{option.label}</Text></Pressable>)}</ScrollView></View></Pressable></Modal></>
}

function dialogError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function intervalLabel(seconds: number): string { if (seconds % 604800 === 0) return `${seconds / 604800}w`; if (seconds % 86400 === 0) return `${seconds / 86400}d`; if (seconds % 3600 === 0) return `${seconds / 3600}h`; return `${seconds / 60}m` }
function localScheduleValue(value?: string | number | null): string {
  if (value == null || value === '') return ''
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function parseScheduleValue(value: string): string | null {
  const clean = value.trim()
  if (!clean) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(clean) ? clean.replace(' ', 'T') : clean
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 18 }, sheetPage: { flex: 1 }, sheetSafeArea: { flex: 1 }, sheet: { width: '100%', maxWidth: 520, maxHeight: '88%', borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' }, sheetWide: { maxWidth: 760 }, sheetGrabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, marginBottom: 1, borderRadius: 3, backgroundColor: '#8a8a8a88' },
  sheetHeader: { height: 53, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' }, sheetTitle: { flex: 1, fontSize: 16, fontWeight: '800' }, sheetBody: { paddingHorizontal: 16, paddingBottom: 18, gap: 8 },
  labelRow: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 8 }, label: { fontSize: 11, fontWeight: '700' }, help: { fontSize: 11, lineHeight: 16 },
  input: { height: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, fontSize: 14 }, textarea: { minHeight: 110, maxHeight: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 10, fontSize: 14, textAlignVertical: 'top' },
  segment: { flexDirection: 'row', gap: 6 }, segmentButton: { flex: 1, minHeight: 40, borderRadius: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primary: { minHeight: 43, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, primaryText: { color: 'white', fontWeight: '800' }, secondary: { minHeight: 43, borderRadius: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }, buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 7 }, statusRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7 },
  select: { minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center' }, menu: { width: '100%', maxWidth: 440, maxHeight: '70%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 6 }, option: { minHeight: 42, borderRadius: 5, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchBox: { height: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, result: { minHeight: 58, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth }, empty: { padding: 24, textAlign: 'center' },
  digestSource: { minHeight: 56, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 }, preview: { maxHeight: 280, borderRadius: 6, padding: 10 }, presetRow: { flexDirection: 'row', gap: 5, paddingRight: 4 }, preset: { minWidth: 46, minHeight: 32, borderRadius: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 }, modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, modeButton: { minHeight: 38, minWidth: 88, flexGrow: 1, borderRadius: 6, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' }, toggle: { minHeight: 42, flexDirection: 'row', alignItems: 'center' },
  process: { minHeight: 58, borderRadius: 6, padding: 9, marginBottom: 6, flexDirection: 'row', gap: 8 }, processDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 }, log: { padding: 10, borderRadius: 6, fontFamily: 'Menlo', fontSize: 11, lineHeight: 16 },
  outputHeader: { minHeight: 34, flexDirection: 'row', alignItems: 'center' }, outputTitle: { flex: 1, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  fontScale: { minHeight: 74, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }, fontScalePreview: { flex: 1, gap: 3 }, fontScaleValue: { fontSize: 10, fontWeight: '800' },
})
