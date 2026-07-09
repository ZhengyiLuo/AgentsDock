import { useEffect, useMemo, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Clock3, Command, LoaderCircle, Search, Server, X } from 'lucide-react'
import type { Backend, CreateJobInput, Job, Session, UpdateJobInput } from '@shared/types'
import { runtimeLabel } from '../lib/format'
import { orderedActiveSessions, sessionMatchesQuery } from '../lib/sessions'
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
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className={`form-dialog ${className}`}><header><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></header>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>
}

function SettingsDialog() {
  const open = useAppStore(state => state.modals.settings)
  const connected = useAppStore(state => state.connected)
  const health = useAppStore(state => state.health)
  const [url, setURL] = useState('')
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (open) void window.agentsDock.settings.get().then(value => { setURL(value.serverUrl); setToken('') }) }, [open])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true)
    try {
      const current = await window.agentsDock.settings.get()
      await window.agentsDock.settings.apply({ serverUrl: url.trim(), accessToken: token || (current.hasAccessToken ? '__KEEP__' : '') })
      useAppStore.getState().setModal('settings', false)
      window.location.reload()
    } catch (error) { useAppStore.getState().setError(message(error)) } finally { setSaving(false) }
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('settings', value)} title="Server connection" description="Connect this app to your AgentsDock server.">
    <form onSubmit={submit} className="dialog-form">
      <div className={`server-health ${connected ? 'online' : 'offline'}`}><span /><div><strong>{connected ? 'Connected' : 'Offline'}</strong><small>{health?.server_identity || 'Connection settings are stored on this Mac.'}</small></div></div>
      <label><span>Server URL</span><div className="input-with-icon"><Server size={14} /><input value={url} onChange={event => setURL(event.target.value)} placeholder="100.73.184.23:7850" autoCapitalize="none" autoCorrect="off" /></div></label>
      <label><span>Access token</span><input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="Leave blank to keep saved token" autoComplete="off" /></label>
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
  const backendCatalog = catalog?.backends[backend]
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal(mode, value)} title={mode === 'newChat' ? 'New chat' : 'Resume a provider session'} description={mode === 'resume' ? 'Import a rough transcript and continue from an existing Claude or Codex ID.' : 'Choose the workspace and runtime for this conversation.'}>
    <form onSubmit={submit} className="dialog-form two-column-form">
      {mode === 'resume' && <label className="span-two"><span>Claude session or Codex thread ID</span><input value={providerId} onChange={event => setProviderId(event.target.value)} placeholder="Session ID" required /></label>}
      <label className="span-two"><span>Chat name</span><input value={title} onChange={event => setTitle(event.target.value)} autoFocus /></label>
      <label><span>Folder</span><input value={folder} onChange={event => setFolder(event.target.value)} list="folder-list" /><datalist id="folder-list">{folders.map(item => <option key={item}>{item}</option>)}</datalist></label>
      <label><span>Working directory</span><input value={cwd} onChange={event => setCwd(event.target.value)} placeholder={defaultCwd || 'Server default'} /></label>
      <fieldset className="span-two"><legend>Backend</legend><div className="segmented">{(['claude', 'codex'] as Backend[]).map(value => <button type="button" className={backend === value ? 'active' : ''} key={value} onClick={() => { setBackend(value); setModel(''); setEffort('') }}><BackendMark backend={value} size={16} />{value === 'claude' ? 'Claude' : 'Codex'}</button>)}</div></fieldset>
      <label><span>Model</span><select value={model} onChange={event => setModel(event.target.value)}><option value="">{backendCatalog?.default_model || 'Server model'}</option>{backendCatalog?.models.filter(item => item.value).map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
      <label><span>Reasoning</span><select value={effort} onChange={event => setEffort(event.target.value)}><option value="">{backendCatalog?.default_effort || 'Default effort'}</option>{backendCatalog?.efforts.filter(item => item.value).map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
      <footer className="span-two"><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal(mode, false)}>Cancel</button><button className="primary-button" disabled={saving || mode === 'resume' && !providerId.trim()}>{saving && <LoaderCircle className="spin" size={14} />}{mode === 'newChat' ? 'Create chat' : 'Resume chat'}</button></footer>
    </form>
  </Shell>
}

function SearchDialog() {
  const open = useAppStore(state => state.modals.search)
  const sessions = useAppStore(state => state.sessions)
  const [query, setQuery] = useState('')
  const filtered = sessions.filter(session => sessionMatchesQuery(session, query)).slice(0, 18)
  useEffect(() => { if (open) setQuery('') }, [open])
  const openSession = (session: Session) => { useAppStore.getState().setModal('search', false); void useAppStore.getState().selectSession(session.id) }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('search', value)} title="Open chat" className="command-dialog">
    <label className="command-search"><Search size={16} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && filtered[0]) openSession(filtered[0]) }} placeholder="Search chat names" /></label>
    <div className="command-results">{filtered.map(session => <button key={session.id} onClick={() => openSession(session)}><BackendMark backend={session.backend} size={18} /><span><strong>{session.title}</strong><small>{session.folder || 'General'} · {runtimeLabel(session, useAppStore.getState().runtimeCatalog)}</small></span></button>)}{!filtered.length && <p>No matching chats.</p>}</div>
    <div className="command-hint"><Command size={12} /> P searches chats · Control Tab switches chats</div>
  </Shell>
}

function DigestDialog() {
  const open = useAppStore(state => state.modals.digest)
  const sessions = useAppStore(state => state.sessions)
  const sourceId = useAppStore(state => state.selectedSessionId)
  const [target, setTarget] = useState('')
  const [detail, setDetail] = useState('normal')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [sending, setSending] = useState(false)
  const folderOrder = useAppStore(state => state.folderOrder)
  const choices = orderedActiveSessions(sessions, folderOrder).filter(session => session.id !== sourceId)
  useEffect(() => { if (open) { setTarget(choices[0]?.id ?? ''); setPreview('') } }, [open, sourceId])
  const previewDigest = async () => {
    if (!sourceId) return
    setSending(true)
    try { setPreview(await window.agentsDock.digest.preview({ sourceSessionId: sourceId, targetSessionId: target, detail, userPrompt: prompt.trim() })) }
    catch (error) { useAppStore.getState().setError(message(error)) } finally { setSending(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!sourceId || !target) return; setSending(true)
    try { await window.agentsDock.digest.send({ sourceSessionId: sourceId, targetSessionId: target, detail, userPrompt: prompt.trim() }); useAppStore.getState().setModal('digest', false) }
    catch (error) { useAppStore.getState().setError(message(error)) } finally { setSending(false) }
  }
  return <Shell open={open} onOpenChange={value => useAppStore.getState().setModal('digest', value)} title="Send context digest" description="The source agent summarizes its context, then sends one handoff turn to the target chat." className="digest-dialog">
    <form onSubmit={submit} className="dialog-form">
      <label><span>Target chat</span><select value={target} onChange={event => setTarget(event.target.value)}>{choices.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}</select></label>
      <label><span>Detail</span><select value={detail} onChange={event => setDetail(event.target.value)}><option value="short">Short</option><option value="normal">Normal</option><option value="deep">Deep</option></select></label>
      <label><span>Prompt for target agent</span><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={5} placeholder="What should the target agent focus on?" /></label>
      <section className="digest-preview"><strong>Preview</strong>{preview ? <pre>{preview}</pre> : <p>Generate an LLM summary here before sending, or send it directly in the background.</p>}</section>
      <footer><button type="button" className="quiet-button" onClick={() => useAppStore.getState().setModal('digest', false)}>Cancel</button><span className="dialog-spacer" /><button type="button" className="quiet-button" disabled={sending || !sourceId} onClick={() => void previewDigest()}>{sending && <LoaderCircle className="spin" size={14} />} Preview</button><button className="primary-button" disabled={!target || sending}>Generate &amp; send</button></footer>
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
