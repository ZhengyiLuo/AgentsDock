import { useEffect, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Archive, ChevronDown, ChevronRight, Clock3, Copy, Download, ExternalLink, File, FileStack, FolderOpen, GitFork, LoaderCircle, MoreHorizontal, Pause, Pin, Play, RefreshCw, Server, SquareTerminal, Trash2, Unplug, X } from 'lucide-react'
import type { AgentFile, AgentProcess, Job, PinnedItem, TmuxPane } from '@shared/types'
import { formatBytes, formatTime, runtimeLabel } from '../lib/format'
import { useAppStore } from '../store/app-store'
import { BackendMark } from './BackendMark'
import { LazyVideoThumbnail, MediaPreviewDialog } from './MediaGrid'
import { NativeFileDragSurface } from './NativeFileDragSurface'

const EMPTY_FILES: AgentFile[] = []

export function Inspector() {
  const session = useAppStore(state => state.sessions.find(candidate => candidate.id === state.selectedSessionId) ?? null)
  const snapshotFiles = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId]?.files ?? EMPTY_FILES : EMPTY_FILES)
  const snapshotFilesTotal = useAppStore(state => state.selectedSessionId ? state.snapshots[state.selectedSessionId]?.filesTotal ?? 0 : 0)
  const allJobs = useAppStore(state => state.jobs)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const jobs = useMemo(() => allJobs.filter(job => job.session_id === selectedSessionId), [allJobs, selectedSessionId])
  const connected = useAppStore(state => state.connected)
  const connectionError = useAppStore(state => state.connectionError)
  const catalog = useAppStore(state => state.runtimeCatalog)
  const [pins, setPins] = useState<PinnedItem[]>([])
  const [files, setFiles] = useState<AgentFile[]>([])
  const [filesTotal, setFilesTotal] = useState(0)
  const [mediaOpen, setMediaOpen] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [preview, setPreview] = useState<AgentFile | null>(null)

  useEffect(() => {
    if (!session) { setPins([]); setFiles([]); setFilesTotal(0); return }
    setFiles(snapshotFiles); setFilesTotal(snapshotFilesTotal || snapshotFiles.length)
    void window.agentsDock.pins.list(session.id).then(setPins)
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === session.id) void window.agentsDock.pins.list(session.id).then(setPins) }
    window.addEventListener('agentsdock:pins-changed', changed)
    return () => window.removeEventListener('agentsdock:pins-changed', changed)
  }, [session?.id])

  useEffect(() => {
    setFiles(current => mergeFiles(current, snapshotFiles))
    setFilesTotal(snapshotFilesTotal)
  }, [snapshotFiles, snapshotFilesTotal])

  const loadFiles = async (reset = false) => {
    if (!session || loadingFiles) return
    setLoadingFiles(true)
    try {
      const offset = reset ? 0 : files.length
      const page = await window.agentsDock.files.list(session.id, offset, 60)
      setFiles(current => reset ? page.files : mergeFiles(current, page.files)); setFilesTotal(page.total)
    } catch (error) { useAppStore.getState().setError(error instanceof Error ? error.message : String(error)) } finally { setLoadingFiles(false) }
  }
  const toggleMedia = () => { const next = !mediaOpen; setMediaOpen(next); if (next && session && files.length === 0) void loadFiles(true) }

  return <aside className="inspector">
    <div className="inspector-drag-region" />
    <div className="inspector-scroll">
      <section className="inspector-status"><div className={`server-pill ${connected ? 'online' : 'offline'}`} title={connectionError || undefined}><span />{connected ? 'Online' : 'Offline'}</div><button className="icon-button" title={connectionError || 'Connection settings'} onClick={() => useAppStore.getState().setModal('settings', true)}><Server size={14} /></button></section>
      {!session ? <div className="inspector-empty">Select a chat to inspect its runtime, files, jobs, and live processes.</div> : <>
        <section className="inspector-section session-settings">
          <h3>Session</h3>
          <SessionField label="Name" value={session.title} onSave={value => useAppStore.getState().updateSession(session.id, { title: value })} />
          <div className="runtime-summary"><BackendMark backend={session.backend} size={18} /><span><strong>{session.backend === 'codex' ? 'Codex' : 'Claude'}</strong><small>{runtimeLabel(session, catalog)}</small></span></div>
          {!isBackendLocked(session) && <div className="segmented inspector-backend">{(['claude', 'codex'] as const).map(backend => <button className={session.backend === backend ? 'active' : ''} key={backend} onClick={() => void useAppStore.getState().updateSession(session.id, { backend, model: null, effort: null })}><BackendMark backend={backend} size={14} />{backend === 'claude' ? 'Claude' : 'Codex'}</button>)}</div>}
          <label><span>Model</span><select value={session.model ?? ''} onChange={event => void useAppStore.getState().updateSession(session.id, { model: event.target.value || null })}>{runtimeOptions(session.backend, 'models', session.model)}</select></label>
          <SessionField label="Custom model" value={session.model || ''} allowEmpty onSave={value => useAppStore.getState().updateSession(session.id, { model: value || null })} />
          <label><span>Reasoning</span><select value={session.effort ?? ''} onChange={event => void useAppStore.getState().updateSession(session.id, { effort: event.target.value || null })}>{runtimeOptions(session.backend, 'efforts', session.effort)}</select></label>
          <SessionField label="Folder" value={session.folder || 'General'} onSave={value => useAppStore.getState().updateSession(session.id, { folder: value })} />
          <SessionField label="Working directory" value={session.cwd || ''} onSave={value => useAppStore.getState().updateSession(session.id, { cwd: value })} />
          <div className="session-id-row"><span>{session.backend === 'codex' ? 'Thread' : 'Session'}</span><code>{session.codex_thread_id || session.claude_session_id || session.session_id || 'Starts on first message'}</code></div>
        </section>

        <section className="inspector-actions">
          <button onClick={() => useAppStore.getState().setModal('digest', true)}><GitFork size={14} /> Create digest</button>
          <button onClick={() => void useAppStore.getState().forkSession(session.id)}><GitFork size={14} /> Fork chat</button>
          <button onClick={() => void useAppStore.getState().updateSession(session.id, { pinned: !session.pinned })}><Pin size={14} /> {session.pinned ? 'Unpin' : 'Pin'}</button>
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><button><MoreHorizontal size={14} /> More</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end"><DropdownMenu.Item className="menu-item" onSelect={() => void useAppStore.getState().importHistory(session.id)}><RefreshCw size={14} />Refresh provider history</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={() => void useAppStore.getState().updateSession(session.id, { archived: !session.archived })}><Archive size={14} />{session.archived ? 'Unarchive chat' : 'Archive chat'}</DropdownMenu.Item><DropdownMenu.Item className="menu-item danger" onSelect={() => window.dispatchEvent(new CustomEvent('agentsdock:confirm-delete', { detail: session }))}><Trash2 size={14} />Delete chat</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </section>

        <PinnedSection sessionId={session.id} pins={pins} setPins={setPins} files={files} />
        <RunSummary sessionId={session.id} files={filesTotal} media={files} />
        <ProcessSection sessionId={session.id} />
        <section className="inspector-section collapsible-section">
          <div className="section-heading-row"><button className="section-toggle" onClick={toggleMedia}>{mediaOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FileStack size={15} /><strong>Media &amp; files</strong><small>{files.length}/{filesTotal || files.length}</small></button><button className="nested-icon" title="Refresh" onClick={() => void loadFiles(true)}><RefreshCw size={12} /></button></div>
          {mediaOpen && <MediaInspector sessionId={session.id} files={files} total={filesTotal} loading={loadingFiles} loadMore={() => void loadFiles(false)} onPreview={setPreview} />}
        </section>
        <JobsSection jobs={jobs} />
        <MediaPreviewDialog file={preview} onClose={() => setPreview(null)} />
      </>}
    </div>
  </aside>

  function runtimeOptions(backend: string, type: 'models' | 'efforts', current?: string | null) {
    const options = catalog?.backends[backend]
    const label = type === 'models' ? options?.default_model || 'Server model' : options?.default_effort || 'Default effort'
    const available = (options?.[type] ?? []).filter(option => option.value)
    return <><option value="">{label}</option>{available.map(option => <option value={option.value} key={option.value}>{option.label}</option>)}{current && !available.some(option => option.value === current) && <option value={current}>{current}</option>}</>
  }
}

function PinnedSection({ sessionId, pins, setPins, files }: { sessionId: string; pins: PinnedItem[]; setPins: (items: PinnedItem[]) => void; files: AgentFile[] }) {
  return <section className="inspector-section pins-section"><h3><Pin size={14} /> Pinned <small>{pins.length}</small></h3>{!pins.length ? <p>Pin important messages or files from the timeline.</p> : <div className="pin-list">{pins.map(pin => <article key={pin.id}><button className="pin-content" onClick={() => pin.fileId ? void window.agentsDock.files.open(files.find(file => file.id === pin.fileId) || { id: pin.fileId, filename: pin.title }) : pin.eventId && window.dispatchEvent(new CustomEvent('agentsdock:find-event', { detail: pin.eventId }))}><strong>{pin.title}</strong>{pin.body && <span>{pin.body}</span>}<small>{pin.subtitle}</small></button><button title="Unpin" onClick={() => void window.agentsDock.pins.remove(sessionId, pin.id).then(setPins)}><X size={12} /></button></article>)}</div>}</section>
}

function SessionField({ label, value, onSave, allowEmpty = false }: { label: string; value: string; onSave: (value: string) => Promise<void>; allowEmpty?: boolean }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => { const clean = draft.trim(); if ((clean || allowEmpty) && clean !== value) void onSave(clean); else if (!clean && !allowEmpty) setDraft(value) }
  return <label><span>{label}</span><input value={draft} onChange={event => setDraft(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setDraft(value); event.currentTarget.blur() } }} /></label>
}

function RunSummary({ sessionId, files, media }: { sessionId: string; files: number; media: AgentFile[] }) {
  const events = useAppStore(state => state.snapshots[sessionId]?.events.length ?? 0)
  const queued = useAppStore(state => state.snapshots[sessionId]?.queuedTurns.length ?? 0)
  const uploads = useAppStore(state => state.uploadsBySession[sessionId]?.length ?? 0)
  const videos = media.filter(file => file.content_type?.startsWith('video/')).length
  const images = media.filter(file => file.content_type?.startsWith('image/')).length
  return <section className="inspector-section run-summary"><h3>Run</h3><div><span>Events <b>{events}</b></span><span>Files <b>{files}</b></span><span>Videos <b>{videos}</b></span><span>Images <b>{images}</b></span><span>Queued <b>{queued}</b></span><span>Uploads <b>{uploads}</b></span></div></section>
}

function ProcessSection({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [processes, setProcesses] = useState<AgentProcess[]>([])
  const [stdout, setStdout] = useState('')
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null)
  const inspect = async () => { setLoading(true); setOpen(true); try { const value = await window.agentsDock.processes.list(sessionId); setProcesses(value.processes); setStdout(value.stdout_tail?.text || '') } catch (error) { useAppStore.getState().setError(String(error)) } finally { setLoading(false) } }
  return <section className="inspector-section collapsible-section"><button className="section-toggle" onClick={() => open ? setOpen(false) : void inspect()}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<SquareTerminal size={15} /><strong>Live processes</strong><small>{processes.length || ''}</small>{loading && <LoaderCircle className="spin" size={13} />}</button>{open && <div className="process-list">{stdout && <button className="live-stdout" onClick={() => setOutput({ title: 'Live stdout', text: stdout })}><SquareTerminal size={12} /> Open live stdout</button>}{!loading && !processes.length && <p>No live process found for this chat.</p>}{processes.map(process => <ProcessRow key={process.pid} process={process} openLog={hint => void window.agentsDock.processes.tail(sessionId, hint.path, 300).then(text => setOutput({ title: hint.label || hint.path, text }))} />)}</div>}{output && <OutputPanel title={output.title} text={output.text} onClose={() => setOutput(null)} />}</section>
}

function ProcessRow({ process, openLog }: { process: AgentProcess; openLog: (hint: NonNullable<AgentProcess['log_hints']>[number]) => void }) {
  const metrics = [
    `PID ${process.pid}`,
    process.elapsed_seconds != null ? `${Math.round(process.elapsed_seconds)}s` : '',
    process.cpu_percent != null ? `${process.cpu_percent.toFixed(1)}% CPU` : '',
    process.rss_kb != null ? `${formatBytes(process.rss_kb * 1024)} RSS` : '',
    process.stat || ''
  ].filter(Boolean).join(' · ')
  return <article style={{ paddingLeft: 7 + Math.min(6, process.depth || 0) * 8 }}><div title={process.args || process.command}><strong>{process.command}</strong><small>{metrics}</small><code>{process.cwd}</code></div>{process.log_hints?.map(hint => <button key={hint.path} onClick={() => openLog(hint)}>stdout</button>)}</article>
}

function TmuxSection({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [panes, setPanes] = useState<TmuxPane[]>([])
  const [includeAll, setIncludeAll] = useState(false)
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null)
  const inspect = async (all = includeAll) => { setLoading(true); setOpen(true); try { setPanes(await window.agentsDock.tmux.list(sessionId, all)) } catch (error) { useAppStore.getState().setError(String(error)) } finally { setLoading(false) } }
  return <section className="inspector-section collapsible-section"><button className="section-toggle" onClick={() => open ? setOpen(false) : void inspect()}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<SquareTerminal size={15} /><strong>Tmux submitters</strong><small>{panes.length || ''}</small>{loading && <LoaderCircle className="spin" size={13} />}</button>{open && <><label className="all-toggle"><input type="checkbox" checked={includeAll} onChange={event => { setIncludeAll(event.target.checked); void inspect(event.target.checked) }} /> Show machine-wide panes</label><div className="tmux-list">{!loading && !panes.length && <p>No linked tmux submitter is live.</p>}{panes.map(pane => <button key={pane.pane_id} onClick={() => void window.agentsDock.tmux.capture(sessionId, pane.pane_id, 600).then(text => setOutput({ title: `${pane.session_name || 'tmux'} ${pane.pane_id}`, text }))}><span className={pane.dead ? 'dead' : 'live'} /><div><strong>{pane.session_name || pane.pane_id}</strong><small>{pane.command || pane.window_name}</small><code>{pane.cwd || pane.current_path}</code></div></button>)}</div></>}{output && <OutputPanel title={output.title} text={output.text} onClose={() => setOutput(null)} />}</section>
}

function OutputPanel({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <div className="output-panel"><header><strong>{title}</strong><button onClick={() => void navigator.clipboard.writeText(text)}><Copy size={12} /></button><button onClick={onClose}><X size={12} /></button></header><pre>{text}</pre></div>
}

function MediaInspector({ sessionId, files, total, loading, loadMore, onPreview }: { sessionId: string; files: AgentFile[]; total: number; loading: boolean; loadMore: () => void; onPreview: (file: AgentFile) => void }) {
  const media = useMemo(() => files.filter(file => /^(image|video)\//.test(file.content_type || '')), [files])
  const documents = useMemo(() => files.filter(file => !/^(image|video)\//.test(file.content_type || '')), [files])
  const pin = async (file: AgentFile) => { await window.agentsDock.pins.put({ id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, subtitle: file.text, createdAt: Date.now() }); window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId })) }
  return <div className="media-inspector"><div className="inspector-media-grid">{media.map(file => <NativeFileDragSurface key={file.id} file={file}><button className="inspector-thumb" onClick={() => onPreview(file)}>{file.content_type?.startsWith('image/') ? <img src={window.agentsDock.files.mediaURL(file.id)} loading="lazy" /> : <LazyVideoThumbnail source={window.agentsDock.files.mediaURL(file.id)} />}{file.content_type?.startsWith('video/') && <Play className="thumb-play" size={14} fill="currentColor" />}</button><strong title={file.title || file.filename}>{file.title || file.filename}</strong><small>{formatBytes(file.size)}</small><div data-native-drag-ignore><button title="Find in chat" onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:find-file', { detail: file.id }))}><RefreshCw size={11} /></button><button title="Pin" onClick={() => void pin(file)}><Pin size={11} /></button><button title="Download" onClick={() => void window.agentsDock.files.save(file)}><Download size={11} /></button><button title="Reveal in Finder" onClick={() => void window.agentsDock.files.reveal(file)}><FolderOpen size={11} /></button><button title="Open" onClick={() => void window.agentsDock.files.open(file)}><ExternalLink size={11} /></button></div></NativeFileDragSurface>)}</div>{documents.length > 0 && <div className="document-list">{documents.map(file => <NativeFileDragSurface key={file.id} file={file}><File size={14} /><span><strong title={file.filename}>{file.filename}</strong><small>{formatBytes(file.size)}</small></span><button data-native-drag-ignore title="Find in chat" onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:find-file', { detail: file.id }))}><RefreshCw size={12} /></button><button data-native-drag-ignore title="Download" onClick={() => void window.agentsDock.files.save(file)}><Download size={12} /></button><button data-native-drag-ignore title="Reveal in Finder" onClick={() => void window.agentsDock.files.reveal(file)}><FolderOpen size={12} /></button></NativeFileDragSurface>)}</div>}{files.length < total && <button className="load-more" disabled={loading} onClick={loadMore}>{loading && <LoaderCircle className="spin" size={13} />} Load 60 more</button>}</div>
}

function isBackendLocked(session: import('@shared/types').Session): boolean { return Boolean(session.session_id || session.claude_session_id || session.codex_thread_id) }

function JobsSection({ jobs }: { jobs: Job[] }) {
  const [open, setOpen] = useState(true)
  return <section className="inspector-section jobs-section"><div className="section-heading-row"><button className="section-toggle" onClick={() => setOpen(value => !value)}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Clock3 size={15} /><strong>Jobs</strong><small>{jobs.length}</small></button><button className="nested-add" onClick={() => useAppStore.getState().setModal('job', true)}>Schedule</button></div>{open && <div className="job-list">{!jobs.length && <p>No jobs for this chat.</p>}{jobs.map(job => <article key={job.id}><span className={`job-state ${job.enabled ? 'enabled' : ''}`} /><button className="job-copy" onClick={() => window.dispatchEvent(new CustomEvent('agentsdock:edit-job', { detail: job }))}><strong>{job.title}</strong><small>{job.loop ? `Every ${formatInterval(job.interval_seconds)}` : `${job.max_runs || 1} run${job.max_runs === 1 ? '' : 's'}`}{job.next_run_at_iso ? ` · ${formatTime(job.next_run_at_iso)}` : ''}</small></button><button title="Run now" onClick={() => void window.agentsDock.jobs.run(job.id)}><Play size={12} /></button><button title={job.enabled ? 'Pause' : 'Enable'} onClick={() => void window.agentsDock.jobs.update(job.id, { enabled: !job.enabled })}>{job.enabled ? <Pause size={12} /> : <Play size={12} />}</button><button title="Delete" onClick={() => void window.agentsDock.jobs.remove(job.id)}><Trash2 size={12} /></button></article>)}</div>}</section>
}

function mergeFiles(a: AgentFile[], b: AgentFile[]): AgentFile[] { return [...new Map([...a, ...b].map(file => [file.id, file])).values()].sort((x, y) => (y.seq || 0) - (x.seq || 0)) }
function formatInterval(seconds: number): string { if (seconds % 86400 === 0) return `${seconds / 86400}d`; if (seconds % 3600 === 0) return `${seconds / 3600}h`; if (seconds % 60 === 0) return `${seconds / 60}m`; return `${seconds}s` }
