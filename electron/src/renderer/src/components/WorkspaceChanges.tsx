import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Check, FileDiff, GitBranch, GitCommitHorizontal, LoaderCircle, Minus, Plus, RefreshCw, Search, X } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { WorkspaceProfileScope } from '@shared/types'
import type { WorkspaceGitAction, WorkspaceGitConflict, WorkspaceGitDiff, WorkspaceGitStatus } from '@shared/workspace-git'
import { useWorkspaceGitLabels } from '../lib/workspace-git-labels'
import './WorkspaceChanges.css'

type Selection = { path: string; view: 'staged' | 'unstaged' | 'conflict' }
type Filter = 'all' | 'staged' | 'unstaged' | 'untracked' | 'conflicts'
type Detail = { kind: 'diff'; value: WorkspaceGitDiff } | { kind: 'conflict'; value: WorkspaceGitConflict }
type FileEntry = WorkspaceGitStatus['files'][number]

export interface WorkspaceChangesProps {
  scope: WorkspaceProfileScope
  sessionId: string
  active?: boolean
  readOnly?: boolean
}

// A changed profile/chat remounts local drafts and invalidates outstanding reads.
export function WorkspaceChanges(props: WorkspaceChangesProps) {
  return <WorkspaceChangesPanel key={JSON.stringify([props.scope.profileId, props.scope.profileGeneration, props.scope.serverIdentity, props.sessionId])} {...props} />
}

function WorkspaceChangesPanel({ scope, sessionId, active = true, readOnly = false }: WorkspaceChangesProps) {
  const labels = useWorkspaceGitLabels()
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [result, setResult] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [reviewRevision, setReviewRevision] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [abortOpen, setAbortOpen] = useState(false)
  const [discard, setDiscard] = useState<{ run: () => void } | null>(null)
  const [detailVersion, setDetailVersion] = useState(0)
  const mounted = useRef(true)
  const statusEpoch = useRef(0)
  const detailEpoch = useRef(0)
  const mutation = useRef(false)
  const conflictDirty = detail?.kind === 'conflict' && result !== detail.value.result
  const dirtyRef = useRef(conflictDirty)
  dirtyRef.current = conflictDirty
  const owner = useRef({ scope, sessionId }).current

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; statusEpoch.current++; detailEpoch.current++ }
  }, [])

  const refresh = useCallback(async () => {
    if (mutation.current) return
    const epoch = ++statusEpoch.current
    setLoading(true); setError(null)
    try {
      if (!window.agentsDock.workspaceGit) throw new Error(labels.update)
      const next = await window.agentsDock.workspaceGit.status(owner.scope, owner.sessionId)
      if (mounted.current && epoch === statusEpoch.current) setStatus(next)
    } catch (cause) {
      if (mounted.current && epoch === statusEpoch.current) setError(gitError(cause, labels.update, labels.noRepository))
    } finally {
      if (mounted.current && epoch === statusEpoch.current) setLoading(false)
    }
  }, [owner, labels.update, labels.noRepository])

  useEffect(() => { if (active) void refresh() }, [active, refresh])

  useEffect(() => {
    const git = window.agentsDock.workspaceGit
    if (!active || !selection || !status || mutation.current || !git) return
    // A refresh never destroys an in-progress conflict draft. Its original
    // revision is retained so the server can reject a stale resolution.
    if (dirtyRef.current) return
    const epoch = ++detailEpoch.current
    setDetail(null); setDetailError(null); setDetailLoading(true)
    const request = selection.view === 'conflict'
      ? git.conflict(owner.scope, owner.sessionId, selection.path).then(value => ({ kind: 'conflict' as const, value }))
      : git.diff(owner.scope, owner.sessionId, selection.path, selection.view).then(value => ({ kind: 'diff' as const, value }))
    void request.then(next => {
      if (!mounted.current || epoch !== detailEpoch.current) return
      setDetail(next)
      if (next.kind === 'conflict') setResult(next.value.result)
    }).catch(cause => {
      if (mounted.current && epoch === detailEpoch.current) setDetailError(errorText(cause))
    }).finally(() => {
      if (mounted.current && epoch === detailEpoch.current) setDetailLoading(false)
    })
    return () => { detailEpoch.current++ }
  }, [active, selection, status?.revision, owner, detailVersion])

  const run = async (input: Omit<WorkspaceGitAction, 'expected_revision'>, revision = status?.revision): Promise<void> => {
    if (mutation.current || readOnly || !revision) return
    const git = window.agentsDock.workspaceGit
    if (!git) { setError(labels.update); return }
    mutation.current = true; statusEpoch.current++; detailEpoch.current++
    setBusy(true); setLoading(false); setDetailLoading(false); setError(null); setNotice(null)
    try {
      const next = await git.action(owner.scope, owner.sessionId, { ...input, expected_revision: revision })
      if (!mounted.current) return
      setStatus(next)
      if (input.action === 'commit') { setMessage(''); setReviewRevision(null); setNotice(labels.committed) }
      if (input.action === 'resolve') { setDetail(null); dirtyRef.current = false; setSelection(null); setNotice(labels.resolved) }
      if (input.action === 'continue' || input.action === 'abort') {
        setDetail(null); setSelection(null); setReviewRevision(null); setAbortOpen(false)
        setNotice(input.action === 'abort' ? labels.abortDone : next.operation ? next.conflict_count > 0 ? labels.moreConflicts : labels.inProgress : labels.completed)
      }
      if (selection && !next.files.some(file => matchesSelection(file, selection))) { setSelection(null); setDetail(null) }
    } catch (cause) {
      if (!mounted.current) return
      setError(errorText(cause))
      // Never retry a mutation. One read reconciles ambiguous/stale results.
      try {
        const next = await git.status(owner.scope, owner.sessionId)
        if (mounted.current) setStatus(next)
      } catch { /* Keep the original mutation error and a manual retry path. */ }
    } finally {
      mutation.current = false
      if (mounted.current) { setBusy(false); setDetailVersion(value => value + 1) }
    }
  }

  const protectDraft = (action: () => void) => {
    if (conflictDirty) setDiscard({ run: action })
    else action()
  }
  const select = (next: Selection) => {
    if (busy || (selection?.path === next.path && selection.view === next.view)) return
    protectDraft(() => { dirtyRef.current = false; setDetail(null); setSelection(next); setNotice(null) })
  }
  const review = () => protectDraft(() => {
    if (!status) return
    dirtyRef.current = false; setDetail(null); setReviewRevision(status.revision); setFilter('staged'); setQuery('')
    const first = status.files.find(file => file.staged && !file.conflicted)
    setSelection(first ? { path: first.path, view: 'staged' } : null)
  })
  const allFiles = status?.files ?? []
  const counts = useMemo(() => ({ all: allFiles.length, staged: allFiles.filter(file => file.staged && !file.conflicted).length,
    unstaged: allFiles.filter(file => file.unstaged && !file.conflicted && !file.untracked).length,
    untracked: allFiles.filter(file => file.untracked).length, conflicts: allFiles.filter(file => file.conflicted).length }), [allFiles])
  const files = useMemo(() => allFiles.filter(file => {
    const inGroup = filter === 'all' || (filter === 'conflicts' ? file.conflicted
      : filter === 'staged' ? file.staged && !file.conflicted
      : filter === 'unstaged' ? file.unstaged && !file.conflicted && !file.untracked : file.untracked)
    return inGroup && file.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }), [allFiles, filter, query])
  const blocked = busy || loading || readOnly
  const selectedFile = selection ? allFiles.find(file => file.path === selection.path) : null
  const conflict = detail?.kind === 'conflict' ? detail.value : null
  const staleConflict = Boolean(conflict && status && conflict.revision !== status.revision)
  const hasMarkers = /^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(result)
  const operation = status?.operation

  return <section className="workspace-changes" aria-label={labels.region} aria-busy={busy}>
    <header className="workspace-changes-header">
      <h2><FileDiff size={17} />{labels.changes}</h2>
      {status && <span className="workspace-changes-branch" title={`${status.root}\n${status.head ?? ''}`}><GitBranch size={14} />{status.branch || labels.detached}</span>}
      <span className="workspace-changes-spacer" />
      <button type="button" className="icon-button" disabled={busy || loading} title={labels.refresh} aria-label={labels.refresh} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'spin' : undefined} /></button>
      <button type="button" className="primary-button" disabled={blocked || !counts.staged || Boolean(counts.conflicts) || Boolean(operation)} onClick={review}><GitCommitHorizontal size={15} />{labels.review}</button>
    </header>
    {status && <div className="workspace-changes-summary"><span title={status.root}>{status.root.split(/[\\/]/).filter(Boolean).at(-1) || status.root}</span><span>{counts.all} {counts.all === 1 ? labels.changedOne : labels.changed} · {counts.staged} {counts.staged === 1 ? labels.stagedFile : labels.stagedFiles}</span></div>}
    {operation && <div className="workspace-changes-operation" role="status">
      <AlertTriangle size={16} /><span>{labels[operation]} {labels.operation}{counts.conflicts > 0 ? ` · ${counts.conflicts} ${counts.conflicts === 1 ? labels.conflict : labels.conflicts.toLocaleLowerCase()}` : ''}</span>
      <button type="button" className="quiet-button" disabled={blocked || counts.conflicts > 0 || conflictDirty} onClick={() => void run({ action: 'continue' })}>{labels.continue} {labels[operation].toLocaleLowerCase()}</button>
      <button type="button" className="quiet-button workspace-changes-danger" disabled={blocked} onClick={() => setAbortOpen(true)}>{labels.abort} {labels[operation].toLocaleLowerCase()}</button>
    </div>}
    {readOnly && <p className="workspace-changes-notice">{labels.readOnly}</p>}
    {error && <div className="workspace-changes-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><button type="button" className="quiet-button" disabled={busy || loading} onClick={() => void refresh()}>{labels.refresh}</button></div>}
    {notice && <p className="workspace-changes-notice" role="status"><Check size={14} />{notice}</p>}
    <div className="workspace-changes-body">
      <aside className="workspace-changes-sidebar" aria-label={labels.all}>
        <label className="workspace-changes-filter"><Search size={14} /><input aria-label={labels.filter} placeholder={labels.filter} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="workspace-changes-groups" aria-label={labels.all}>
          {(['all', 'staged', 'unstaged', 'untracked', 'conflicts'] as const).map(group => <button type="button" key={group} aria-pressed={filter === group} onClick={() => setFilter(group)}>{labels[group]}<span>{counts[group]}</span></button>)}
        </div>
        <div className="workspace-changes-bulk">
          <button type="button" className="quiet-button" disabled={blocked || conflictDirty || !allFiles.some(file => !file.conflicted && (file.unstaged || file.untracked))} onClick={() => void run({ action: 'stage', paths: allFiles.filter(file => !file.conflicted && (file.unstaged || file.untracked)).map(file => file.path) })}><Plus size={13} />{labels.stageAll}</button>
          <button type="button" className="quiet-button" disabled={blocked || conflictDirty || !counts.staged} onClick={() => void run({ action: 'unstage', paths: allFiles.filter(file => file.staged && !file.conflicted).map(file => file.path) })}><Minus size={13} />{labels.unstageAll}</button>
        </div>
        {files.length > 0 ? <Virtuoso className="workspace-changes-file-list" data={files} computeItemKey={(_index, file) => file.path} itemContent={(_index, file) => <div className={`workspace-changes-file${selection?.path === file.path ? ' selected' : ''}`}>
          <button type="button" className="workspace-changes-file-name" disabled={busy} title={file.original_path ? `${file.original_path} → ${file.path}` : file.path} onClick={() => select({ path: file.path, view: file.conflicted ? 'conflict' : filter === 'staged' || (!file.unstaged && !file.untracked && file.staged) ? 'staged' : 'unstaged' })}>
            <span className={file.conflicted ? 'workspace-changes-danger' : ''}>{file.conflicted ? <AlertTriangle size={14} /> : <FileDiff size={14} />}</span><span>{file.path}</span><code>{file.conflicted ? '!' : `${file.index_status}${file.worktree_status}`}</code>
          </button>
          {!file.conflicted && <div className="workspace-changes-file-actions">
            {(file.unstaged || file.untracked) && <button type="button" className="icon-button" disabled={blocked || conflictDirty} title={labels.stage} aria-label={`${labels.stage} ${file.path}`} onClick={() => void run({ action: 'stage', paths: [file.path] })}><Plus size={14} /></button>}
            {file.staged && <button type="button" className="icon-button" disabled={blocked || conflictDirty} title={labels.unstage} aria-label={`${labels.unstage} ${file.path}`} onClick={() => void run({ action: 'unstage', paths: [file.path] })}><Minus size={14} /></button>}
          </div>}
        </div>} /> : <div className="workspace-changes-empty">{loading && !status ? <LoaderCircle size={18} className="spin" /> : counts.all ? labels.noMatches : status ? labels.clean : labels.unavailable}</div>}
      </aside>
      <main className="workspace-changes-main">
        {reviewRevision && <section className="workspace-changes-commit" aria-label={labels.reviewTitle}>
          <div><h3>{labels.reviewTitle}</h3><button type="button" className="icon-button" aria-label={labels.close} onClick={() => setReviewRevision(null)}><X size={15} /></button></div>
          <p>{labels.commitHint}</p>
          {reviewRevision !== status?.revision && <p role="status" className="workspace-changes-danger">{labels.reviewChanged}</p>}
          <textarea aria-label={labels.message} placeholder={labels.messageHint} value={message} maxLength={10000} disabled={busy} onChange={event => setMessage(event.target.value)} />
          <button type="button" className="primary-button" disabled={blocked || !message.trim() || !counts.staged || counts.conflicts > 0 || Boolean(operation)} onClick={() => {
            if (reviewRevision !== status?.revision) { setReviewRevision(status?.revision ?? null); return }
            void run({ action: 'commit', message: message.trim() }, reviewRevision)
          }}>{busy ? <LoaderCircle size={14} className="spin" /> : <GitCommitHorizontal size={14} />}{reviewRevision !== status?.revision ? labels.review : labels.commit}</button>
        </section>}
        {selection && <div className="workspace-changes-detail-header"><strong title={selection.path}>{selection.path}</strong><span className="workspace-changes-spacer" />
          {conflictDirty && <span className="workspace-changes-draft">{labels.dirty}</span>}
          {selectedFile && !selectedFile.conflicted && <div className="workspace-changes-view-switch">
            {selectedFile.staged && <button type="button" aria-pressed={selection.view === 'staged'} onClick={() => select({ path: selection.path, view: 'staged' })}>{labels.staged}</button>}
            {(selectedFile.unstaged || selectedFile.untracked) && <button type="button" aria-pressed={selection.view === 'unstaged'} onClick={() => select({ path: selection.path, view: 'unstaged' })}>{selectedFile.untracked ? labels.untracked : labels.unstaged}</button>}
          </div>}
        </div>}
        {detailLoading ? <div className="workspace-changes-empty" role="status"><LoaderCircle className="spin" size={18} />{labels.loading}</div>
          : detailError ? <div className="workspace-changes-empty" role="alert">{detailError}<button type="button" className="quiet-button" onClick={() => setDetailVersion(value => value + 1)}>{labels.refresh}</button></div>
          : conflict ? <div className="workspace-changes-conflict">
            {staleConflict && <div className="workspace-changes-error" role="alert"><span>{labels.stale}</span><button type="button" className="quiet-button" onClick={() => protectDraft(() => { dirtyRef.current = false; setDetail(null); setDetailVersion(value => value + 1) })}>{labels.reload}</button></div>}
            <p>{conflict.binary ? labels.binaryConflict : labels.conflictHint}</p>
            {operation === 'rebase' && <p>{labels.rebaseHint}</p>}
            {!conflict.binary && <>
              <div className="workspace-changes-conflict-sources">
                {([{ title: labels.base, content: conflict.base }, { title: labels.current, content: conflict.ours }, { title: labels.incoming, content: conflict.theirs }]).map(side => <section key={side.title}><h3>{side.title}</h3><pre>{side.content ?? labels.missing}</pre></section>)}
              </div>
              <div className="workspace-changes-result-actions"><h3>{labels.result}</h3><span className="workspace-changes-spacer" /><button type="button" className="quiet-button" disabled={blocked || conflict.ours === null} onClick={() => setResult(conflict.ours ?? '')}>{labels.useCurrent}</button><button type="button" className="quiet-button" disabled={blocked || conflict.theirs === null} onClick={() => setResult(conflict.theirs ?? '')}>{labels.useIncoming}</button></div>
              <textarea className="workspace-changes-result" aria-label={labels.result} value={result} readOnly={blocked} spellCheck={false} onChange={event => setResult(event.target.value)} />
              <div className="workspace-changes-resolution-footer">{hasMarkers && <span>{labels.markers}</span>}<button type="button" className="primary-button" disabled={blocked || staleConflict || hasMarkers} onClick={() => void run({ action: 'resolve', path: conflict.path, content: result }, conflict.revision)}><Check size={14} />{labels.saveResolution}</button></div>
            </>}
          </div> : detail?.kind === 'diff' ? <DiffPreview diff={detail.value} /> : <div className="workspace-changes-empty"><FileDiff size={28} /><span>{status?.files.length ? labels.select : status ? labels.empty : labels.unavailable}</span></div>}
      </main>
    </div>
    <ConfirmDialog open={active && abortOpen} title={labels.abortTitle} description={labels.abortHint} confirm={labels.abortConfirm} disabled={busy} onCancel={() => setAbortOpen(false)} onConfirm={() => void run({ action: 'abort', confirmed: true })} />
    <ConfirmDialog open={active && Boolean(discard)} title={labels.discardTitle} description={labels.discardHint} confirm={labels.discard} disabled={busy} onCancel={() => setDiscard(null)} onConfirm={() => { const action = discard?.run; setDiscard(null); action?.() }} />
  </section>
}

function DiffPreview({ diff }: { diff: WorkspaceGitDiff }) {
  const labels = useWorkspaceGitLabels()
  const lines = useMemo(() => diff.diff.split('\n'), [diff.diff])
  if (diff.binary || !diff.diff) return <div className="workspace-changes-empty">{diff.binary ? labels.binary : labels.noDiff}</div>
  return <div className="workspace-changes-diff">
    {diff.truncated && <p className="workspace-changes-notice">{labels.truncated}</p>}
    <Virtuoso className="workspace-changes-diff-lines" data={lines} itemContent={(index, line) => <div className={`workspace-changes-diff-line ${line.startsWith('+') && !line.startsWith('+++') ? 'addition' : line.startsWith('-') && !line.startsWith('---') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''}`}><span aria-hidden="true">{index + 1}</span><code>{line || ' '}</code></div>} />
  </div>
}

function ConfirmDialog({ open, title, description, confirm, disabled, onCancel, onConfirm }: { open: boolean; title: string; description: string; confirm: string; disabled: boolean; onCancel: () => void; onConfirm: () => void }) {
  const labels = useWorkspaceGitLabels()
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !disabled) onCancel() }}><Dialog.Portal><Dialog.Overlay className="workspace-changes-dialog-overlay" /><Dialog.Content className="workspace-changes-dialog" onEscapeKeyDown={event => { if (disabled) event.preventDefault() }} onPointerDownOutside={event => event.preventDefault()}>
    <Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description><div><button type="button" className="quiet-button" disabled={disabled} onClick={onCancel}>{labels.cancel}</button><button type="button" className="danger-button" disabled={disabled} onClick={onConfirm}>{confirm}</button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}

function matchesSelection(file: FileEntry, selection: Selection): boolean {
  return file.path === selection.path && (selection.view === 'conflict' ? file.conflicted : selection.view === 'staged' ? file.staged && !file.conflicted : (file.unstaged || file.untracked) && !file.conflicted)
}

function errorText(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/^(?:Error:\s*)?Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

function gitError(cause: unknown, update: string, noRepository: string): string {
  const message = errorText(cause)
  if (/not a git repository|no git repository|not_git_repository/i.test(message)) return noRepository
  if (/404|not found|unsupported|not implemented/i.test(message)) return update
  return message
}
