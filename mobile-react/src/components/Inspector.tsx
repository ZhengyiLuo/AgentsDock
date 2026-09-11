import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { useShallow } from 'zustand/react/shallow'
import { Archive, Check, ChevronDown, Copy, FileText, GitFork, Pause, Pencil, Pin, Play, Plus, RefreshCw, Search, SquareTerminal, Trash2, X } from 'lucide-react-native'
import { describeJobSchedule, effectiveScheduleKind } from '../lib/job-schedule'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { filesNewestFirst } from '../lib/format'
import { mobileFileViewerKind } from '../lib/file-viewer'
import { runtimeCatalogOptions, runtimeEffortAfterModelChange, runtimeEffortOptions, runtimeSelectionError } from '../lib/runtime-catalog'
import { PROVIDER_JOBS_ACCESS_MODES, providerJobsAccessDescription, providerJobsAccessLabel, providerJobsAccessState } from '../lib/provider-jobs-access'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { ProviderJobsAccess, RuntimeOption } from '../types'
import { Text, TextInput } from './AppText'
import { MediaGrid } from './MediaGrid'
import { IconButton, SectionHeader } from './ui'
import { useFileViewer } from './file-viewer/FileViewerContext'

type JobRunFeedback = {
  phase: 'requesting' | 'deferred' | 'started' | 'failed'
  message: string
}

export function Inspector({ sessionId, onDigest, onJob, onTerminal, onProcesses, onTmux, onFileViewerRequested }: { sessionId: string; onDigest: () => void; onJob: (jobId?: string) => void; onTerminal: () => void; onProcesses: () => void; onTmux: () => void; onFileViewerRequested?: () => void }) {
  const colors = usePalette()
  const { openArtifacts } = useFileViewer()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const workspaceAdopting = useAppStore(state => state.workspaceAdopting)
  const connected = useAppStore(state => state.connected)
  const running = useAppStore(state => state.activeSessionIds.has(sessionId))
  const stopping = useAppStore(state => state.stoppingSessionIds.has(sessionId))
  const admitting = useAppStore(state => Boolean(state.turnAdmissionTokens[sessionId]) || state.sendingSessionIds.has(sessionId)
    || Boolean(state.snapshots[sessionId]?.queuedTurns.some(turn => state.pendingQueuedRunIds.has(turn.queued_id))))
  const session = useAppStore(useShallow(state => {
    const value = state.sessions.find(candidate => candidate.id === sessionId)
    return value ? {
      id: value.id,
      title: value.title,
      folder: value.folder,
      cwd: value.cwd,
      backend: value.backend,
      model: value.model,
      effort: value.effort,
      system_prompt: value.system_prompt,
      provider_jobs_access: value.provider_jobs_access,
      pinned: value.pinned,
      archived: value.archived,
      session_id: value.session_id,
      codex_thread_id: value.codex_thread_id,
      claude_session_id: value.claude_session_id,
      cursor_session_id: value.cursor_session_id,
    } : undefined
  }))
  const snapshotFiles = useAppStore(state => state.snapshots[sessionId]?.files)
  const filesTotal = useAppStore(state => state.snapshots[sessionId]?.filesTotal ?? state.snapshots[sessionId]?.files.length ?? 0)
  const filePaging = useAppStore(state => state.filePaging[sessionId])
  const runtime = useAppStore(state => state.runtime)
  const health = useAppStore(state => state.health)
  const allJobs = useAppStore(state => state.jobs)
  const pendingJobRunIds = useAppStore(state => state.pendingJobRunIds)
  const allPins = useAppStore(state => state.pins)
  const jobs = useMemo(() => allJobs.filter(value => value.session_id === sessionId), [allJobs, sessionId])
  const pins = useMemo(() => allPins.filter(value => value.sessionId === sessionId), [allPins, sessionId])
  const newestFiles = useMemo(() => filesNewestFirst(snapshotFiles ?? []), [snapshotFiles])
  const loadedFileCount = snapshotFiles?.length ?? 0
  const filesHasMore = filePaging?.hasMore ?? loadedFileCount < filesTotal
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
  const [systemPrompt, setSystemPrompt] = useState(session?.system_prompt ?? '')
  const [mediaOpen, setMediaOpen] = useState(false)
  const [pinPreviewId, setPinPreviewId] = useState<string | null>(null)
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null)
  const [jobRunFeedback, setJobRunFeedback] = useState<Record<string, JobRunFeedback>>({})
  const jobRunsInFlight = useRef(new Set<string>())
  const jobRunFeedbackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const scopeIsCurrent = () => {
    const state = useAppStore.getState()
    return state.activeProfileId === activeProfileId
      && state.profileGeneration === profileGeneration
      && state.selectedSessionId === sessionId
      && !state.workspaceAdopting
  }
  const providerSessionId = session?.session_id?.trim() || session?.codex_thread_id?.trim() || session?.claude_session_id?.trim() || session?.cursor_session_id?.trim() || ''
  const forkDisabled = !connected || running || stopping || admitting
  const copySessionId = async () => {
    if (!providerSessionId || !scopeIsCurrent()) return
    try {
      await Clipboard.setStringAsync(providerSessionId)
      if (scopeIsCurrent()) {
        setCopiedSessionId(providerSessionId)
        AccessibilityInfo.announceForAccessibility('Session ID copied')
      }
    } catch (cause) {
      if (scopeIsCurrent()) Alert.alert('Could not copy session ID', cause instanceof Error ? cause.message : String(cause))
    }
  }
  const openPinnedItem = (pinId: string) => {
    const pin = pins.find(value => value.id === pinId)
    const file = pin?.fileId ? snapshotFiles?.find(value => value.id === pin.fileId) : null
    if (file && mobileFileViewerKind(file.filename, file.content_type) !== 'unsupported') {
      onFileViewerRequested?.()
      openArtifacts({ sessionId, files: [file], initialId: file.id, ownerKey: `pin:${pinId}` })
      return
    }
    setPinPreviewId(pinId)
  }
  const showJobRunFeedback = (jobId: string, feedback: JobRunFeedback, clearAfterMs = 0) => {
    const priorTimer = jobRunFeedbackTimers.current.get(jobId)
    if (priorTimer) clearTimeout(priorTimer)
    jobRunFeedbackTimers.current.delete(jobId)
    setJobRunFeedback(value => ({ ...value, [jobId]: feedback }))
    if (Platform.OS === 'ios' && feedback.phase !== 'requesting') {
      AccessibilityInfo.announceForAccessibility(feedback.message)
    }
    if (clearAfterMs > 0) {
      const timer = setTimeout(() => {
        jobRunFeedbackTimers.current.delete(jobId)
        setJobRunFeedback(value => {
          if (value[jobId] !== feedback) return value
          const next = { ...value }
          delete next[jobId]
          return next
        })
      }, clearAfterMs)
      jobRunFeedbackTimers.current.set(jobId, timer)
    }
  }
  const runScheduledJob = async (jobId: string) => {
    if (!scopeIsCurrent() || jobRunsInFlight.current.has(jobId)) return
    jobRunsInFlight.current.add(jobId)
    showJobRunFeedback(jobId, { phase: 'requesting', message: 'Requesting run…' })
    try {
      const result = await runJob(jobId, profileGeneration)
      if (!scopeIsCurrent()) return
      if (!result) {
        showJobRunFeedback(jobId, { phase: 'failed', message: 'The active server changed before the run was accepted.' }, 8_000)
        return
      }
      if (result.error || result.ok === false) {
        showJobRunFeedback(jobId, { phase: 'failed', message: result.error || result.message || 'Could not run this job.' }, 8_000)
        return
      }
      const deferred = result.deferred === true || result.queued === true
      showJobRunFeedback(jobId, {
        phase: deferred ? 'deferred' : 'started',
        message: result.message || (deferred
          ? 'Waiting for this chat to become idle, then the job will run automatically.'
          : 'Started now. Output will appear in this chat.'),
      }, deferred ? 0 : 6_000)
    } finally {
      jobRunsInFlight.current.delete(jobId)
    }
  }
  useEffect(() => {
    setTitle(session?.title ?? '')
    setFolder(session?.folder ?? 'General')
    setCwd(session?.cwd ?? '')
    setSystemPrompt(session?.system_prompt ?? '')
  }, [session?.cwd, session?.folder, session?.system_prompt, session?.title])
  useEffect(() => {
    for (const job of jobs) {
      if (jobRunFeedback[job.id]?.phase === 'deferred' && job.manual_run_pending === false) {
        showJobRunFeedback(job.id, {
          phase: 'started',
          message: 'The deferred run started. Output will appear in this chat.',
        }, 6_000)
      }
    }
  }, [jobRunFeedback, jobs])
  useEffect(() => () => {
    for (const timer of jobRunFeedbackTimers.current.values()) clearTimeout(timer)
    jobRunFeedbackTimers.current.clear()
  }, [])
  useEffect(() => { void refreshJobs(profileGeneration) }, [profileGeneration, refreshJobs, sessionId])
  if (!session) return null
  const modelOptions = runtimeCatalogOptions(runtime, session.backend, 'models', session.model)
  const effortOptions = runtimeEffortOptions(runtime, session.backend, session.model, session.effort)
  const selectionError = runtimeSelectionError(health, runtime, session.backend, session.model)
  const jobsAccess = providerJobsAccessState(session, health)
  const jobsAccessOptions = PROVIDER_JOBS_ACCESS_MODES.map(value => ({ value, label: providerJobsAccessLabel(value) }))
  return <ScrollView pointerEvents={workspaceAdopting ? 'none' : 'auto'} style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border, opacity: workspaceAdopting ? 0.55 : 1 }]} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title="Session" />
      <Field label="Name"><TextInput value={title} onChangeText={setTitle} onBlur={() => { const clean = title.trim(); if (scopeIsCurrent() && clean && clean !== session.title) void update(sessionId, { title: clean }, profileGeneration) }} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
      <Field label="Model"><ChoiceField value={session.model ?? ''} options={modelOptions} onChange={model => { if (scopeIsCurrent()) void update(sessionId, { model, effort: runtimeEffortAfterModelChange(runtime, session.backend, model, session.effort) }, profileGeneration) }} /></Field>
      {session.backend !== 'cursor' ? <Field label="Effort"><ChoiceField value={session.effort ?? ''} options={effortOptions} onChange={effort => { if (scopeIsCurrent()) void update(sessionId, { effort }, profileGeneration) }} /></Field> : null}
      {selectionError ? <Text accessibilityRole="alert" style={[styles.hint, { color: colors.orange }]}>{selectionError}</Text> : null}
      <Field label="Agent jobs"><ChoiceField disabled={!jobsAccess.available} value={jobsAccess.effective} options={jobsAccessOptions} onChange={value => { if (scopeIsCurrent() && jobsAccess.available) void update(sessionId, { provider_jobs_access: value as ProviderJobsAccess }, profileGeneration) }} /></Field>
      <Text style={[styles.hint, { color: colors.muted }]}>{jobsAccess.available ? `${providerJobsAccessLabel(jobsAccess.effective)}${jobsAccess.inheritedDefault ? ' (server default)' : ''}. ${providerJobsAccessDescription(jobsAccess.effective)}` : 'Update AgentsServer to set Read-only or Blocked. Human job controls remain available.'}</Text>
      <Field label="System prompt"><TextInput value={systemPrompt} onChangeText={setSystemPrompt} onBlur={() => { const clean = systemPrompt.trim(); if (scopeIsCurrent() && clean !== (session.system_prompt ?? '')) void update(sessionId, { system_prompt: clean || null }, profileGeneration) }} multiline maxLength={12_000} placeholder="Optional per-chat instructions" placeholderTextColor={colors.muted} style={[styles.multilineInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
      <Field label="Folder"><TextInput value={folder} onChangeText={setFolder} onBlur={() => { if (scopeIsCurrent()) void update(sessionId, { folder: folder.trim() || 'General' }, profileGeneration) }} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
      <Field label="Working directory"><TextInput value={cwd} onChangeText={setCwd} onBlur={() => { if (scopeIsCurrent()) void update(sessionId, { cwd: cwd.trim() }, profileGeneration) }} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} /></Field>
    </View>

    <View style={styles.commandGrid}>
      <Command icon={GitFork} label="Fork" testID="inspector-fork-chat" disabled={forkDisabled} hint={stopping ? 'Wait for the current turn to stop before forking this chat.' : running ? 'Wait for the active turn to finish before forking this chat.' : admitting ? 'Wait for the pending message to be accepted before forking this chat.' : !connected ? 'Connect to the server to fork this chat.' : undefined} onPress={() => { if (!forkDisabled && scopeIsCurrent()) void fork(sessionId, profileGeneration) }} />
      <Command icon={providerSessionId && copiedSessionId === providerSessionId ? Check : Copy} label={providerSessionId && copiedSessionId === providerSessionId ? 'Copied' : 'Copy session'} testID="inspector-copy-session-id" disabled={!providerSessionId} hint={providerSessionId ? 'Copies the full provider session ID.' : 'Available after the chat agent starts a provider session.'} onPress={() => void copySessionId()} />
      <Command icon={FileText} label="Digest" onPress={() => { if (scopeIsCurrent()) onDigest() }} />
      <Command icon={Pin} label={session.pinned ? 'Unpin' : 'Pin'} onPress={() => { if (scopeIsCurrent()) void update(sessionId, { pinned: !session.pinned }, profileGeneration) }} />
      <Command icon={Archive} label={session.archived ? 'Unarchive' : 'Archive'} onPress={() => { if (scopeIsCurrent()) void update(sessionId, { archived: !session.archived }, profileGeneration) }} />
      <Command icon={SquareTerminal} label="Terminal" onPress={() => { if (scopeIsCurrent()) onTerminal() }} />
      <Command icon={Search} label="Processes" onPress={() => { if (scopeIsCurrent()) onProcesses() }} />
      <Command icon={SquareTerminal} label="Tmux panes" onPress={() => { if (scopeIsCurrent()) onTmux() }} />
      <Command icon={Trash2} label="Delete" destructive onPress={() => { if (!scopeIsCurrent()) return; Alert.alert('Delete chat?', 'This removes the chat from the server.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { if (scopeIsCurrent()) void remove(sessionId, profileGeneration) } }]) }} />
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title={`Pinned ${pins.length}`} />
      {pins.length ? pins.map(pin => <View key={pin.id} style={styles.pinRow}><Pressable accessibilityRole="button" accessibilityLabel={`Open pinned item ${pin.title}`} onPress={() => openPinnedItem(pin.id)} style={styles.pinIdentity}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{pin.title}</Text>{pin.body ? <Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={2}>{pin.body}</Text> : <Text style={{ color: colors.muted, fontSize: 10 }}>Pinned file</Text>}</Pressable><IconButton icon={X} size={13} onPress={() => { if (scopeIsCurrent()) void removePin(pin.id, profileGeneration) }} label="Unpin" /></View>) : <Text style={[styles.hint, { color: colors.muted }]}>Pin important messages or files from the timeline.</Text>}
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Media and files" accessibilityState={{ expanded: mediaOpen }} onPress={() => setMediaOpen(value => !value)} style={styles.disclosure}><SectionHeader title={`Media & files ${snapshotFiles?.length ?? 0}/${filesTotal}`} /><ChevronDown size={15} color={colors.muted} /></Pressable>
      {mediaOpen ? <>
        {newestFiles.length ? <MediaGrid files={newestFiles} sessionId={sessionId} compact onViewerRequested={onFileViewerRequested} /> : null}
        {filePaging?.loading ? <View testID="file-page-loading" accessibilityLiveRegion="polite" style={styles.filePageStatus}><ActivityIndicator size="small" color={colors.blue} /><Text style={{ color: colors.muted, fontSize: 11 }}>Loading files…</Text></View> : null}
        {filePaging?.error ? <View testID="file-page-error" accessibilityLiveRegion="polite" style={[styles.filePageError, { borderColor: colors.red }]}><Text style={{ flex: 1, color: colors.red, fontSize: 11 }}>{filePaging.error}</Text><Pressable testID="file-page-retry" accessibilityRole="button" accessibilityLabel="Retry loading media and files" onPress={() => { if (scopeIsCurrent()) void refreshFiles(sessionId, filePaging.retryAppend, profileGeneration) }} style={[styles.filePageRetry, { backgroundColor: colors.surface }]}><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '800' }}>Retry</Text></Pressable></View> : null}
        {!filePaging?.loading && !filePaging?.error && filesHasMore ? <Pressable testID="file-page-load-more" accessibilityRole="button" accessibilityLabel="Load more media and files" onPress={() => { if (scopeIsCurrent()) void refreshFiles(sessionId, true, profileGeneration) }} style={[styles.loadMore, { backgroundColor: colors.surface }]}><Text style={{ color: colors.muted, fontSize: 11 }}>Load more</Text></Pressable> : null}
        {!filePaging?.loading && !filePaging?.error && !filesHasMore && newestFiles.length ? <Text testID="file-page-exhausted" style={[styles.filePageHint, { color: colors.muted }]}>All files loaded.</Text> : null}
        {!filePaging?.loading && !filePaging?.error && !newestFiles.length ? <Text style={[styles.filePageHint, { color: colors.muted }]}>No media or files.</Text> : null}
      </> : null}
    </View>

    <View style={[styles.card, { backgroundColor: colors.raised }]}>
      <SectionHeader title={`Jobs ${jobs.length}`} trailing={<View style={styles.headerActions}><IconButton icon={RefreshCw} size={15} onPress={() => { if (scopeIsCurrent()) void refreshJobs(profileGeneration) }} label="Refresh jobs" /><Pressable accessibilityRole="button" accessibilityLabel="Schedule job" testID="schedule-job" onPress={() => { if (scopeIsCurrent()) onJob() }} style={[styles.scheduleJob, { backgroundColor: colors.surface }]}><Plus size={14} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 10, fontWeight: '800' }}>Schedule</Text></Pressable></View>} />
      {!jobs.length ? <Text style={[styles.hint, { color: colors.muted }]}>No scheduled jobs for this chat.</Text> : null}
      {jobs.map(job => {
        const feedback = jobRunFeedback[job.id]
        const requestingRun = feedback?.phase === 'requesting' || pendingJobRunIds.has(job.id)
        const pendingOnServer = job.manual_run_pending === true
        const actionLocked = requestingRun || pendingOnServer
        const status = pendingOnServer ? {
          phase: 'deferred' as const,
          message: 'Waiting for this chat to become idle, then the job will run automatically.',
        } : feedback ?? null
        return <View key={job.id} style={[styles.jobBlock, { opacity: job.enabled === false && !pendingOnServer ? 0.62 : 1 }]}>
          <View style={styles.jobRow}>
            <Pressable testID={`scheduled-job-card-${job.id}`} accessibilityRole="button" accessibilityLabel={`Edit scheduled job ${job.title}`} accessibilityState={{ disabled: actionLocked }} disabled={actionLocked} onPress={() => { if (scopeIsCurrent()) onJob(job.id) }} style={styles.jobContent}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{job.title}</Text><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={2}>{describeJobSchedule(job)} · {job.max_runs == null ? (effectiveScheduleKind(job) === 'interval' ? 'loops' : 'no extra run limit') : `${job.max_runs} total run${job.max_runs === 1 ? '' : 's'}`} · {job.run_count ?? 0} completed{job.enabled === false ? ' · inactive' : nextRunLabel(job.next_run_at_iso)}</Text></Pressable>
            <IconButton icon={Pencil} size={14} disabled={actionLocked} onPress={() => { if (scopeIsCurrent()) onJob(job.id) }} label="Edit job" />
            <IconButton icon={job.enabled === false ? Play : Pause} size={14} disabled={actionLocked} onPress={() => { if (scopeIsCurrent()) void updateJob(job.id, { enabled: job.enabled === false }, profileGeneration) }} label={job.enabled === false ? 'Enable job' : 'Pause job'} />
            <Pressable testID={`run-scheduled-job-${job.id}`} accessibilityRole="button" accessibilityLabel={pendingOnServer ? `Scheduled job ${job.title} is waiting to run` : `Run scheduled job ${job.title} now`} accessibilityState={{ busy: requestingRun || pendingOnServer, disabled: actionLocked }} disabled={actionLocked} onPress={() => void runScheduledJob(job.id)} style={({ pressed }) => [styles.runJobButton, { opacity: actionLocked ? 0.5 : pressed ? 0.65 : 1 }]}>{requestingRun || pendingOnServer ? <ActivityIndicator size="small" color={colors.blue} /> : <Play size={14} color={colors.muted} />}</Pressable>
            <IconButton icon={Trash2} size={14} disabled={actionLocked} onPress={() => { if (!scopeIsCurrent()) return; Alert.alert('Delete job?', `“${job.title}” will stop running.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => { if (scopeIsCurrent()) void deleteJob(job.id, profileGeneration) } }]) }} label="Delete job" />
          </View>
          {status ? <Text testID={`run-scheduled-job-status-${job.id}`} accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.jobRunStatus, { color: status.phase === 'failed' ? colors.red : status.phase === 'started' ? colors.green : colors.blue }]}>{status.message}</Text> : null}
        </View>
      })}
    </View>
    <Modal visible={pinPreviewId != null} transparent animationType="fade" onRequestClose={() => setPinPreviewId(null)}><View style={styles.modalBackdrop}><Pressable accessibilityRole="button" accessibilityLabel="Dismiss pinned item" style={StyleSheet.absoluteFill} onPress={() => setPinPreviewId(null)} /><View style={[styles.pinPreview, { backgroundColor: colors.surface, borderColor: colors.border }]}>{(() => { const pin = pins.find(value => value.id === pinPreviewId); const file = pin?.fileId ? snapshotFiles?.find(value => value.id === pin.fileId) : null; return <><View style={styles.pinPreviewHeader}><Text style={[styles.pinPreviewTitle, { color: colors.text }]} numberOfLines={2}>{pin?.title ?? 'Pinned item'}</Text>{pin?.body ? <IconButton icon={Copy} size={15} onPress={() => void Clipboard.setStringAsync(pin.body ?? '')} label="Copy full text" /> : null}<IconButton icon={X} size={15} onPress={() => setPinPreviewId(null)} label="Close" /></View>{pin?.body ? <ScrollView style={{ maxHeight: 480 }}><Text selectable style={{ color: colors.text, fontSize: 14, lineHeight: 20 }}>{pin.body}</Text></ScrollView> : file ? <MediaGrid files={[file]} sessionId={sessionId} onViewerRequested={() => { setPinPreviewId(null); onFileViewerRequested?.() }} /> : <Text style={{ color: colors.muted }}>This file is not in the loaded media page yet.</Text>}</> })()}</View></View></Modal>
  </ScrollView>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { const colors = usePalette(); return <View style={styles.field}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={{ flex: 1 }}>{children}</View></View> }
function Command({ icon: Icon, label, onPress, destructive, disabled = false, hint, testID }: { icon: typeof Pin; label: string; onPress: () => void; destructive?: boolean; disabled?: boolean; hint?: string; testID?: string }) { const colors = usePalette(); return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.command, { backgroundColor: colors.raised, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 }]}><Icon size={15} color={destructive ? colors.red : colors.muted} /><Text style={{ color: destructive ? colors.red : colors.text, fontSize: 11, fontWeight: '700' }}>{label}</Text></Pressable> }

function ChoiceField({ value, options, onChange, disabled = false }: { value: string; options: RuntimeOption[]; onChange: (value: string) => void; disabled?: boolean }) {
  const colors = usePalette(); const [open, setOpen] = useState(false); const selected = options.find(option => option.value === value) ?? options[0]
  return <><Pressable accessibilityRole="button" accessibilityLabel={selected?.label ?? (value || 'Default')} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => { setOpen(true); requestAnimationFrame(dismissAppKeyboard) }} style={[styles.choice, { borderColor: colors.border, backgroundColor: colors.surface, opacity: disabled ? 0.45 : 1 }]}><Text style={{ flex: 1, color: colors.text, fontSize: 12 }} numberOfLines={1}>{selected?.label ?? (value || 'Default')}</Text><ChevronDown size={14} color={colors.muted} /></Pressable><Modal visible={open && !disabled} transparent animationType="fade" onRequestClose={() => setOpen(false)}><View style={styles.modalBackdrop}><Pressable accessibilityRole="button" accessibilityLabel="Dismiss choices" style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} /><View style={[styles.choiceMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}><ScrollView keyboardShouldPersistTaps="always">{options.map(option => <Pressable key={option.value || '__default'} accessibilityRole="button" accessibilityLabel={option.locked ? `${option.label}, upgrade required` : option.label} accessibilityHint={option.locked ? option.locked_reason ?? undefined : undefined} accessibilityState={{ disabled: option.locked, selected: option.value === value }} disabled={option.locked} onPress={() => { onChange(option.value); setOpen(false) }} style={[styles.choiceOption, { backgroundColor: option.value === value ? colors.raised : 'transparent', opacity: option.locked ? 0.45 : 1 }]}><Text style={{ color: colors.text }}>{option.label}{option.locked ? ' (upgrade required)' : ''}</Text></Pressable>)}</ScrollView></View></View></Modal></>
}
function nextRunLabel(value?: string | null): string { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : ` · next ${date.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}` }

const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 290, borderLeftWidth: StyleSheet.hairlineWidth }, content: { padding: 10, gap: 8, paddingBottom: 30 },
  card: { borderRadius: 7, padding: 8, gap: 7 }, field: { flexDirection: 'row', gap: 8, alignItems: 'center' }, label: { width: 70, fontSize: 10, fontWeight: '700' },
  input: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 8, fontSize: 12 }, multilineInput: { minHeight: 78, maxHeight: 150, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 8, fontSize: 12, textAlignVertical: 'top' },
  choice: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center' },
  commandGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 }, command: { minWidth: '30%', minHeight: 44, borderRadius: 6, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', gap: 6 },
  hint: { fontSize: 10, paddingHorizontal: 5, paddingBottom: 5 }, pinRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 5 }, pinIdentity: { flex: 1, minHeight: 44, justifyContent: 'center' },
  disclosure: { minHeight: 44, flexDirection: 'row', alignItems: 'center' }, loadMore: { minHeight: 44, borderRadius: 5, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  filePageStatus: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }, filePageError: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingLeft: 9, flexDirection: 'row', alignItems: 'center', gap: 8 }, filePageRetry: { minWidth: 64, minHeight: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 5 }, filePageHint: { minHeight: 36, paddingHorizontal: 5, textAlign: 'center', textAlignVertical: 'center', fontSize: 10 },
  jobBlock: { minHeight: 45 }, jobRow: { minHeight: 45, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 4 },
  jobContent: { minHeight: 44, flex: 1, minWidth: 0, justifyContent: 'center' },
  runJobButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, jobRunStatus: { minHeight: 20, paddingHorizontal: 6, paddingBottom: 4, fontSize: 10, fontWeight: '700' },
  headerActions: { flexDirection: 'row', alignItems: 'center' }, scheduleJob: { minHeight: 44, borderRadius: 5, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4 },
  modalBackdrop: { flex: 1, backgroundColor: '#00000088', alignItems: 'center', justifyContent: 'center', padding: 30 }, choiceMenu: { width: '100%', maxWidth: 380, maxHeight: '70%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 6 }, choiceOption: { minHeight: 44, borderRadius: 5, paddingHorizontal: 12, justifyContent: 'center' },
  pinPreview: { width: '100%', maxWidth: 680, maxHeight: '78%', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 }, pinPreviewHeader: { minHeight: 38, flexDirection: 'row', alignItems: 'center' }, pinPreviewTitle: { flex: 1, fontSize: 14, fontWeight: '800' },
})
