import { useEffect, useMemo, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Check, Clock3, Command, Download, FileText, GitFork, LoaderCircle, Monitor, Moon, RefreshCw, Search, Server, Sparkles, Sun, X } from 'lucide-react'
import type { AppUpdateStatus, Backend, CreateJobInput, Job, Session, UpdateJobInput } from '@shared/types'
import { runtimeCatalogOptions } from '@shared/runtime-catalog'
import { readAppearance, setAppearanceMode, type AppearanceMode } from '../lib/appearance'
import { runtimeLabel } from '../lib/format'
import { historyResultsBySession, openSessionHistoryResult, useSessionHistorySearch } from '../lib/session-history-search'
import { digestTargetSections, rankSessionsForSearch, sessionNameMatchRank } from '../lib/sessions'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { BackendMark } from './BackendMark'

export function Dialogs() {
  return <>
    <SettingsDialog />
    <SessionDialog mode="newChat" />
    <SessionDialog mode="resume" />
    <FolderDialog />
    <SearchDialog />
    <DigestDialog />
    <JobDialog />
    <ConfirmDeleteDialog />
  </>
}

function FolderDialog() {
  const open = useAppStore(state => state.modals.folder)
  const sessions = useAppStore(state => state.sessions)
  const folderOrder = useAppStore(state => state.folderOrder)
  const [name, setName] = useState('')
  useEffect(() => { if (open) setName('') }, [open])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const clean = name.trim()
    if (!clean) return
    const existing = new Set([...folderOrder, ...sessions.map(session => session.folder?.trim() || 'General')].map(folder => folder.toLocaleLowerCase()))
    if (existing.has(clean.toLocaleLowerCase())) {
      useAppStore.getState().setError(`Folder “${clean}” already exists.`)
      return
    }
    useAppStore.getState().setFolderOrder([...folderOrder, clean])
    useAppStore.getState().setModal('folder', false)
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('folder', value)} title="New folder" description="Create an empty chat folder, then drag or move chats into it.">
    <form onSubmit={submit} className="dialog-form">
      <label><span>Folder name</span><input autoFocus value={name} onChange={event => setName(event.target.value)} /></label>
      <footer><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('folder', false)}>Cancel</button><button className="primary-button" disabled={!name.trim()}>Create folder</button></footer>
    </form>
  </Shell>
}

function ConfirmDeleteDialog() {
  const [session, setSession] = useState<Session | null>(null)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    const open = (event: Event) => setSession((event as CustomEvent<Session>).detail)
    window.addEventListener('agentsdock:confirm-delete', open)
    return () => window.removeEventListener('agentsdock:confirm-delete', open)
  }, [])
  const remove = async () => {
    if (!session) return; setDeleting(true)
    await useAppStore.getState().deleteSession(session.id)
    setDeleting(false); setSession(null)
  }
  return <Shell open={Boolean(session)} onOpenChange={open => { if (!open) setSession(null) }} title="Delete chat?" description={session ? `“${session.title}” and its AgentsDock history will be removed. Provider history is not deleted.` : ''} className="confirm-dialog"><div className="confirm-actions"><button className="quiet-button" onClick={() => setSession(null)}>Cancel</button><button className="danger-button" disabled={deleting} onClick={() => void remove()}>{deleting && <LoaderCircle className="spin" size={13} />} Delete chat</button></div></Shell>
}

function Shell({ open, onOpenChange, title, description, children, className = '' }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string
}) {
  useTransientClose(open, () => onOpenChange(false))
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`form-dialog ${className}`}><header><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></header>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}

function SettingsDialog() {
  const open = useAppStore(state => state.modals.settings)
  const connected = useAppStore(state => state.connected)
  const health = useAppStore(state => state.health)
  const [url, setURL] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [update, setUpdate] = useState<AppUpdateStatus | null>(null)
  const [appearance, setAppearance] = useState<AppearanceMode>('system')
  useEffect(() => {
    if (!open) return
    setAppearance(readAppearance())
    void window.agentsDock.settings.get().then(value => { setURL(value.serverUrl); setToken('') })
    void window.agentsDock.updates.status().then(setUpdate)
    return window.agentsDock.events.on('app:update', setUpdate)
  }, [open])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    try {
      const current = await window.agentsDock.settings.get()
      await window.agentsDock.settings.apply({ serverUrl: url.trim(), accessToken: token || (current.hasAccessToken ? '__KEEP__' : '') })
      useAppStore.getState().setModal('settings', false)
      window.location.reload()
    } catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  const chooseAppearance = (mode: AppearanceMode) => {
    setAppearance(mode)
    setAppearanceMode(mode)
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('settings', value)} title="Settings" description="Connection, appearance, and updates.">
    <form onSubmit={submit} className="dialog-form">
      <fieldset className="appearance-field"><legend>Appearance</legend><div className="segmented appearance-picker">
        <button type="button" className={appearance === 'system' ? 'active' : ''} onClick={() => chooseAppearance('system')}><Monitor size={14} />System</button>
        <button type="button" className={appearance === 'light' ? 'active' : ''} onClick={() => chooseAppearance('light')}><Sun size={14} />Light</button>
        <button type="button" className={appearance === 'dark' ? 'active' : ''} onClick={() => chooseAppearance('dark')}><Moon size={14} />Dark</button>
      </div></fieldset>
      <div className={`server-health ${connected ? 'online' : 'offline'}`}><span /><div><strong>{connected ? 'Connected' : 'Offline'}</strong><small>{health?.server_identity || 'Connection settings are stored on this Mac.'}</small></div></div>
      <label><span>Server URL</span><div className="input-with-icon"><Server size={14} /><input value={url} onChange={event => setURL(event.target.value)} placeholder="100.73.184.23:7850" autoCapitalize="none" autoCorrect="off" /></div></label>
      <label><span>Access token</span><input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Leave blank to keep saved token" autoComplete="off" /></label>
      {update && <div className="update-panel">
        <div className="update-copy"><strong>App updates <small>v{update.currentVersion}</small></strong><span>{update.message}</span></div>
        {update.channel === 'direct' && update.state !== 'downloaded' && <button type="button" className="quiet-button" disabled={update.state === 'checking' || update.state === 'downloading'} onClick={() => void window.agentsDock.updates.check()}>{update.state === 'checking' || update.state === 'downloading' ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />} Check now</button>}
        {update.state === 'downloaded' && <button type="button" className="primary-button" onClick={() => void window.agentsDock.updates.install()}><Download size={13} /> Restart to update</button>}
        {update.channel === 'app-store' && <span className="update-channel">TestFlight</span>}
        {update.state === 'downloading' && <div className="update-progress"><span style={{ width: `${update.progress ?? 0}%` }} /></div>}
      </div>}
      <footer><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('settings', false)}>Cancel</button><button className="primary-button" disabled={!url.trim() || saving}>{saving && <LoaderCircle className="spin" size={14} />} Apply &amp; reconnect</button></footer>
    </form>
  </Shell>
}

function SessionDialog({ mode }: { mode: 'newChat' | 'resume' }) {
  const open = useAppStore(state => state.modals[mode])
  const catalog = useAppStore(state => state.runtimeCatalog)
  const defaultCwd = useAppStore(state => state.health?.default_cwd?.trim() || '')
  const sessions = useAppStore(state => state.sessions)
  const [title, setTitle] = useState('')
  const [folder, setFolder] = useState('General')
  const [cwd, setCwd] = useState('')
  const [providerId, setProviderId] = useState('')
  const [backend, setBackend] = useState<Backend>('codex')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [saving, setSaving] = useState(false)
  const folders = useMemo(() => [...new Set(sessions.map(session => session.folder || 'General'))].sort(), [sessions])
  useEffect(() => { if (!open) return; setTitle(mode === 'newChat' ? 'New chat' : 'Resumed chat'); setProviderId(''); setModel(''); setEffort(''); setCwd(defaultCwd) }, [open, mode, defaultCwd])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    try {
      const input = { title: title.trim() || 'New chat', folder: folder.trim() || 'General', cwd: cwd.trim(), backend, model: model || null, effort: effort || null }
      const session = mode === 'resume' ? await window.agentsDock.sessions.resume({ ...input, providerId: providerId.trim() }) : await window.agentsDock.sessions.create(input)
      await useAppStore.getState().refreshSessions(); useAppStore.getState().setModal(mode, false); await useAppStore.getState().selectSession(session.id)
    } catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  const modelOptions = runtimeCatalogOptions(catalog, backend, 'models', model)
  const effortOptions = runtimeCatalogOptions(catalog, backend, 'efforts', effort)
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal(mode, value)} title={mode === 'newChat' ? 'New chat' : 'Resume a provider session'} description={mode === 'resume' ? 'Import a rough transcript and continue from an existing Claude or Codex ID.' : 'Choose the workspace and runtime for this conversation.'}>
    <form onSubmit={submit} className="dialog-form two-column-form">
      {mode === 'resume' && <label className="span-two"><span>Claude session or Codex thread ID</span><input value={providerId} onChange={event => setProviderId(event.target.value)} placeholder="Session ID" required /></label>}
      <label className="span-two"><span>Chat name</span><input value={title} onChange={event => setTitle(event.target.value)} autoFocus /></label>
      <label><span>Folder</span><input value={folder} onChange={event => setFolder(event.target.value)} list="folder-list" /><datalist id="folder-list">{folders.map(item => <option key={item}>{item}</option>)}</datalist></label>
      <label><span>Working directory</span><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder={defaultCwd || 'Server default'} /></label>
      <fieldset className="span-two"><legend>Backend</legend><div className="segmented">{(['claude', 'codex'] as Backend[]).map(value => <button type="button" className={backend === value ? 'active' : ''} key={value} onClick={() => { setBackend(value); setModel(''); setEffort('') }}><BackendMark backend={value} size={16} />{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div></fieldset>
      <label><span>Model</span><select value={model} onChange={event => setModel(event.target.value)}>{modelOptions.map(option => <option value={option.value} key={option.value || 'default'}>{option.label}</option>)}</select></label>
      <label><span>Reasoning</span><select value={effort} onChange={event => setEffort(event.target.value)}>{effortOptions.map(option => <option value={option.value} key={option.value || 'default'}>{option.label}</option>)}</select></label>
      <footer className="span-two"><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal(mode, false)}>Cancel</button><button className="primary-button" disabled={saving || mode === 'resume' && !providerId.trim()}>{saving && <LoaderCircle className="spin" size={14} />}{mode === 'newChat' ? 'Create chat' : 'Resume chat'}</button></footer>
    </form>
  </Shell>
}

function SearchDialog() {
  const open = useAppStore(state => state.modals.search)
  const sessions = useAppStore(state => state.sessions)
  const [query, setQuery] = useState('')
  const historySearch = useSessionHistorySearch(query)
  const historyResults = useMemo(() => historyResultsBySession(historySearch.results), [historySearch.results])
  const filtered = useMemo(
    () => rankSessionsForSearch(sessions, query, new Set(historyResults.keys())).slice(0, 18),
    [historyResults, query, sessions]
  )
  useEffect(() => { if (open) setQuery('') }, [open])
  const openSession = (session: Session) => {
    useAppStore.getState().setModal('search', false)
    const historyResult = sessionNameMatchRank(session, query) == null ? historyResults.get(session.id) : undefined
    void openSessionHistoryResult(session.id, historyResult)
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('search', value)} title="Open chat" className="command-dialog">
    <label className="command-search">{historySearch.loading ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}<input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && filtered[0]) openSession(filtered[0]) }} placeholder="Search chats and full history" /></label>
    <div className="command-results">{filtered.map(session => {
      const match = sessionNameMatchRank(session, query) == null ? historyResults.get(session.id) : undefined
      return <button key={session.id} onClick={() => openSession(session)}><BackendMark backend={session.backend} size={18} /><span><strong>{session.title}</strong><small>{session.folder || 'General'} · {runtimeLabel(session, useAppStore.getState().runtimeCatalog)}</small>{match && <small className="history-match">{match.snippet}</small>}</span></button>
    })}{!filtered.length && <p>{historySearch.loading ? 'Searching full history…' : 'No matching chats.'}</p>}</div>
    <div className="command-hint"><Command size={12} /> P searches chats and messages · Control Tab switches chats</div>
  </Shell>
}

export function DigestDialog() {
  const open = useAppStore(state => state.modals.digest)
  const sessions = useAppStore(state => state.sessions)
  const sourceId = useAppStore(state => state.selectedSessionId)
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('normal')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [targetQuery, setTargetQuery] = useState('')
  const [phase, setPhase] = useState<'idle' | 'preview' | 'send'>('idle')
  const [status, setStatus] = useState('')
  const folderOrder = useAppStore(state => state.folderOrder)
  const source = sessions.find(session => session.id === sourceId) ?? null
  const allSections = useMemo(() => digestTargetSections(sessions, folderOrder, sourceId), [folderOrder, sessions, sourceId])
  const allChoices = useMemo(() => allSections.flatMap(section => section.sessions), [allSections])
  const targetSections = useMemo(
    () => digestTargetSections(sessions, folderOrder, sourceId, targetQuery),
    [folderOrder, sessions, sourceId, targetQuery]
  )
  const resolvedTarget = allChoices.some(session => session.id === target) ? target : allChoices[0]?.id ?? ''
  const targetSession = allChoices.find(session => session.id === resolvedTarget) ?? null
  const busy = phase !== 'idle'

  useEffect(() => {
    if (!open) return
    setDetail('normal')
    setPrompt('')
    setPreview('')
    setTargetQuery('')
    setStatus('')
    setPhase('idle')
  }, [open, sourceId])

  useEffect(() => {
    if (!open) return
    if (!allChoices.some(session => session.id === target)) setTarget(allChoices[0]?.id ?? '')
  }, [allChoices, open, target])

  const previewDigest = async () => {
    if (!sourceId || !resolvedTarget) return
    setPhase('preview'); setStatus('Summarizing source chat with the LLM…')
    try {
      const result = await window.agentsDock.digest.preview({ sourceSessionId: sourceId, targetSessionId: resolvedTarget, detail, userPrompt: prompt.trim() })
      setPreview(result)
      setStatus(`${result.length.toLocaleString()} character preview`)
    } catch (error) {
      setStatus(message(error))
    } finally {
      setPhase('idle')
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!sourceId || !resolvedTarget) return
    setPhase('send'); setStatus('Starting digest in the source chat…')
    try {
      const accepted = await window.agentsDock.digest.send({ sourceSessionId: sourceId, targetSessionId: resolvedTarget, detail, userPrompt: prompt.trim() })
      if (!accepted) throw new Error('The server did not accept the digest request.')
      useAppStore.getState().setModal('digest', false)
    } catch (error) {
      setStatus(message(error))
    } finally {
      setPhase('idle')
    }
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('digest', value)} title="Create context digest" description="The source chat agent creates one focused handoff turn for another chat." className="digest-dialog">
    <form onSubmit={submit} className="dialog-form digest-form">
      <section className="digest-route" aria-label="Digest route">
        <div className="digest-route-chat source"><small>Source</small><span><BackendMark backend={source?.backend || 'codex'} size={18} /><strong>{source?.title || 'No source chat'}</strong></span><em>{source ? runtimeLabel(source, useAppStore.getState().runtimeCatalog) : 'Select a chat first'}</em></div>
        <ArrowRight size={18} />
        <div className={`digest-route-chat target ${targetSession ? 'selected' : ''}`}><small>Target</small><span>{targetSession ? <BackendMark backend={targetSession.backend} size={18} /> : <GitFork size={18} />}<strong>{targetSession?.title || 'Choose a chat'}</strong></span><em>{targetSession ? `${targetSession.folder || 'General'} · ${runtimeLabel(targetSession, useAppStore.getState().runtimeCatalog)}` : 'No active target available'}</em></div>
      </section>

      <div className="digest-workspace">
        <section className="digest-target-browser">
          <header><strong>Target chat</strong><small>{allChoices.length} available</small></header>
          <label className="digest-target-search"><Search size={14} /><input value={targetQuery} onChange={event => setTargetQuery(event.target.value)} placeholder="Filter chats" aria-label="Filter target chats" /></label>
          <div className="digest-target-list" role="listbox" aria-label="Digest target chat">
            {targetSections.map(section => <section key={section.id}><h3>{section.title}</h3>{section.sessions.map(session => <button type="button" role="option" aria-selected={resolvedTarget === session.id} className={resolvedTarget === session.id ? 'selected' : ''} key={session.id} onClick={() => setTarget(session.id)}><BackendMark backend={session.backend} size={17} /><span><strong>{session.title}</strong><small>{runtimeLabel(session, useAppStore.getState().runtimeCatalog)}</small></span>{resolvedTarget === session.id && <Check size={15} />}</button>)}</section>)}
            {!targetSections.length && <p>No matching active chats.</p>}
          </div>
        </section>

        <section className="digest-builder">
          <fieldset className="digest-detail"><legend>Detail</legend><div className="segmented">{[
            ['short', 'Short'], ['normal', 'Normal'], ['deep', 'Deep']
          ].map(([value, label]) => <button type="button" className={detail === value ? 'active' : ''} key={value} onClick={() => { setDetail(value); setPreview(''); setStatus('') }}>{label}</button>)}</div></fieldset>
          <label><span>Prompt for target agent</span><textarea value={prompt} onChange={event => { setPrompt(event.target.value); if (preview) setStatus('Prompt changed · refresh preview before sending') }} rows={5} placeholder="What should the target agent focus on?" /></label>
          <section className={`digest-preview ${preview ? 'has-content' : ''}`}>
            <header><span><FileText size={14} /><strong>Preview</strong></span>{preview && <small>{preview.length.toLocaleString()} characters</small>}</header>
            {preview ? <pre>{preview}</pre> : <div className="digest-preview-empty"><Sparkles size={22} /><strong>No preview yet</strong><span>Preview runs the LLM without sending the handoff.</span></div>}
          </section>
        </section>
      </div>

      <footer className="digest-footer">
        <div className={`digest-status ${status && !busy && !preview ? 'error' : ''}`}>{busy && <LoaderCircle className="spin" size={14} />}<span>{status || 'Ready'}</span></div>
        <span className="dialog-spacer" />
        <button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('digest', false)}>Cancel</button>
        <button type="button" className="quiet-button" disabled={busy || !sourceId || !resolvedTarget} onClick={() => void previewDigest()}>{phase === 'preview' && <LoaderCircle className="spin" size={14} />} Preview</button>
        <button className="primary-button" disabled={!sourceId || !resolvedTarget || busy}>{phase === 'send' && <LoaderCircle className="spin" size={14} />} Send to chat</button>
      </footer>
    </form>
  </Shell>
}

function JobDialog() {
  const open = useAppStore(state => state.modals.job)
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const [editing, setEditing] = useState<Job | null>(null)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [interval, setIntervalValue] = useState(3600)
  const [startMode, setStartMode] = useState('interval')
  const [firstRun, setFirstRun] = useState('')
  const [loop, setLoop] = useState(true)
  const [maxRuns, setMaxRuns] = useState(1)
  const [enabled, setEnabled] = useState(true)
  const [backend, setBackend] = useState<Backend>('codex')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    const edit = (event: Event) => { const job = (event as CustomEvent<Job>).detail; setEditing(job); fill(job); useAppStore.getState().setModal('job', true) }
    window.addEventListener('agentsdock:edit-job', edit)
    return () => window.removeEventListener('agentsdock:edit-job', edit)
  }, [])
  useEffect(() => { if (open && !editing) { setTitle(''); setPrompt(session ? useAppStore.getState().drafts[session.id] ?? '' : ''); setIntervalValue(3600); setStartMode('interval'); setFirstRun(''); setLoop(true); setMaxRuns(1); setEnabled(true); setBackend(session?.backend ?? 'codex') } }, [open, editing, session?.id])
  const fill = (job: Job) => { setTitle(job.title); setPrompt(job.prompt); setIntervalValue(job.interval_seconds); setFirstRun(toLocalDateTime(job.next_run_at_iso || epochISO(job.next_run_at))); setStartMode('keep'); setLoop(Boolean(job.loop)); setMaxRuns(job.max_runs || 1); setEnabled(job.enabled !== false); setBackend(job.backend || session?.backend || 'codex') }
  const close = () => { setEditing(null); useAppStore.getState().setModal('job', false) }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!session) return; setSaving(true)
    const cleanInterval = Math.max(10, Number.isFinite(interval) ? interval : 3600)
    const scheduledTime = startMode === 'immediate' ? new Date().toISOString() : startMode === 'time' && firstRun ? new Date(firstRun).toISOString() : null
    try {
      if (editing) {
        const patch: UpdateJobInput = {}
        if (title.trim() !== editing.title) patch.title = title.trim()
        if (prompt.trim() !== editing.prompt) patch.prompt = prompt.trim()
        if (cleanInterval !== editing.interval_seconds) patch.interval_seconds = cleanInterval
        if (loop !== Boolean(editing.loop)) patch.loop = loop
        if ((loop ? null : Math.max(1, maxRuns)) !== (editing.max_runs ?? null)) patch.max_runs = loop ? null : Math.max(1, maxRuns)
        if (enabled !== (editing.enabled !== false)) patch.enabled = enabled
        if (backend !== (editing.backend || session.backend)) patch.backend = backend
        if (startMode === 'immediate' || startMode === 'time') patch.next_run_at = scheduledTime
        else if (startMode === 'interval') patch.next_run_at = new Date(Date.now() + cleanInterval * 1000).toISOString()
        await window.agentsDock.jobs.update(editing.id, patch)
      } else {
        const input: CreateJobInput = { session_id: session.id, title: title.trim(), prompt: prompt.trim(), interval_seconds: cleanInterval, first_run_at: scheduledTime, loop, max_runs: loop ? null : Math.max(1, maxRuns), enabled, backend, model: session.model, effort: session.effort }
        await window.agentsDock.jobs.create(input)
      }
      close()
    }
    catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  return <Shell open={open} onOpenChange={value => { if (!value) close() }} title={editing ? 'Edit scheduled job' : 'Schedule a job'} description="Run a prompt in this chat on your schedule.">
    <form onSubmit={submit} className="dialog-form job-form">
      <label><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <fieldset><legend>Backend</legend><div className="segmented">{(['claude', 'codex'] as Backend[]).map(value => <button type="button" key={value} className={backend === value ? 'active' : ''} onClick={() => setBackend(value)}><BackendMark backend={value} size={14} />{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div></fieldset>
      <div className="form-row"><label><span>Interval</span><select value={interval} onChange={event => setIntervalValue(Number(event.target.value))}><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option><option value={43200}>12 hours</option><option value={86400}>24 hours</option><option value={604800}>1 week</option></select></label><label><span>Seconds</span><input type="number" min={10} value={interval} onChange={event => setIntervalValue(Number(event.target.value))} /></label></div>
      <fieldset><legend>{editing ? 'Next run' : 'First run'}</legend><div className="segmented">{editing && <button type="button" className={startMode === 'keep' ? 'active' : ''} onClick={() => setStartMode('keep')}>Keep current</button>}<button type="button" className={startMode === 'immediate' ? 'active' : ''} onClick={() => setStartMode('immediate')}>Now</button><button type="button" className={startMode === 'interval' ? 'active' : ''} onClick={() => setStartMode('interval')}>After interval</button><button type="button" className={startMode === 'time' ? 'active' : ''} onClick={() => setStartMode('time')}>At a time</button></div>{startMode === 'time' && <input type="datetime-local" value={firstRun} onChange={event => setFirstRun(event.target.value)} />}</fieldset>
      <fieldset><legend>Mode</legend><div className="segmented"><button type="button" className={!loop ? 'active' : ''} onClick={() => setLoop(false)}>Run fixed times</button><button type="button" className={loop ? 'active' : ''} onClick={() => setLoop(true)}>Loop forever</button></div>{!loop && <label className="run-count"><span>Runs</span><input type="number" min={1} max={999} value={maxRuns} onChange={event => setMaxRuns(Number(event.target.value))} /></label>}</fieldset>
      <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><Check size={13} /> Enabled</label>
      <label><span>Prompt</span><textarea rows={10} value={prompt} onChange={event => setPrompt(event.target.value)} required /></label>
      <footer><button type="button" className="quiet-button" onClick={close}>Cancel</button><button className="primary-button" disabled={saving || !title.trim() || !prompt.trim()}>{saving && <LoaderCircle className="spin" size={14} />} Save job</button></footer>
    </form>
  </Shell>
}

function toLocalDateTime(value?: string | null): string { if (!value) return ''; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16) }
function epochISO(value?: number | null): string | null { return value == null ? null : new Date(value * 1000).toISOString() }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
