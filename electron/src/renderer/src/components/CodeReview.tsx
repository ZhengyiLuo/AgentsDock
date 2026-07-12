import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronDown, ChevronRight, Copy, FileCode2, FileDiff, Folder, LoaderCircle, RotateCcw, Search, X } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { CodeReviewTarget, DiffFile, DiffLine } from '../lib/timeline'
import { parseReviewableDiff } from '../lib/timeline'
import { useTransientClose } from '../lib/transient-close'

type ReviewRow =
  | { kind: 'file'; file: DiffFile; fileIndex: number }
  | { kind: 'gap'; count: number; fileIndex: number }
  | { kind: 'line'; line: DiffLine; fileIndex: number }

interface ReviewModel {
  rows: ReviewRow[]
  fileStarts: number[]
}

interface ReviewTreeEntry {
  file: DiffFile
  fileIndex: number
  name: string
}

interface ReviewTreeNode {
  name: string
  path: string
  directories: ReviewTreeNode[]
  files: ReviewTreeEntry[]
}

export function CodeReview({ target, onClose }: { target: CodeReviewTarget | null; onClose: () => void }) {
  useTransientClose(Boolean(target), onClose)
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activeFile, setActiveFile] = useState(0)
  const [filter, setFilter] = useState('')
  const [workspaceLeft, setWorkspaceLeft] = useState(0)
  const list = useRef<VirtuosoHandle>(null)
  const requestEpoch = useRef(0)

  useLayoutEffect(() => {
    if (!target) return
    const sidebar = document.querySelector<HTMLElement>('.sidebar')
    if (!sidebar) { setWorkspaceLeft(0); return }
    const update = () => setWorkspaceLeft(Math.round(sidebar.getBoundingClientRect().right))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(sidebar)
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [target])

  useEffect(() => {
    const epoch = ++requestEpoch.current
    setSource(target?.source ?? '')
    setError(null)
    setCopied(false)
    setActiveFile(0)
    setFilter('')
    if (!target?.runId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.agentsDock.diffs.get(target.sessionId, target.runId)
      .then(diff => { if (requestEpoch.current === epoch) setSource(diff) })
      .catch(reason => {
        if (requestEpoch.current !== epoch) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (requestEpoch.current === epoch) setLoading(false) })
    return () => { if (requestEpoch.current === epoch) requestEpoch.current += 1 }
  }, [target])

  const files = useMemo(() => parseReviewableDiff(source), [source])
  const model = useMemo(() => buildReviewModel(files), [files])
  const parsedAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const parsedDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const additions = target?.runId && target.additions != null ? target.additions : parsedAdditions
  const deletions = target?.runId && target.deletions != null ? target.deletions : parsedDeletions
  const fileCount = files.length || (loading ? target?.files?.length ?? 0 : 0)
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredEntries = useMemo(() => files.map((file, fileIndex) => ({
    file,
    fileIndex,
    name: file.path.split('/').filter(Boolean).at(-1) || file.path
  })).filter(entry => !normalizedFilter || entry.file.path.toLowerCase().includes(normalizedFilter)), [files, normalizedFilter])
  const fileTree = useMemo(() => buildFileTree(filteredEntries), [filteredEntries])
  const unavailableMessage = error || (source.trim() && files.length === 0
    ? 'This historical turn recorded a file list, but no line-level patch. AgentsDock will not present that inventory as a diff.'
    : 'No line-level code changes were captured for this turn.')

  if (!target) return null

  const retry = () => {
    if (!target.runId) return
    const epoch = ++requestEpoch.current
    const { sessionId, runId } = target
    setLoading(true)
    setError(null)
    void window.agentsDock.diffs.get(sessionId, runId)
      .then(diff => { if (requestEpoch.current === epoch) setSource(diff) })
      .catch(reason => { if (requestEpoch.current === epoch) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (requestEpoch.current === epoch) setLoading(false) })
  }
  const copy = async () => {
    await window.agentsDock.native.writeClipboard(source)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }
  const jumpToFile = (fileIndex: number) => {
    setActiveFile(fileIndex)
    list.current?.scrollToIndex({ index: model.fileStarts[fileIndex] ?? 0, align: 'start', behavior: 'auto' })
  }

  return <Dialog.Root open modal={false} onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Content className="review-dialog" style={{ left: workspaceLeft }} onPointerDownOutside={event => event.preventDefault()}>
        <Dialog.Description className="sr-only">Complete code changes from the selected agent turn.</Dialog.Description>
        <header className="review-header">
          <Dialog.Title><FileDiff size={15} /> Review</Dialog.Title>
          <span className="review-spacer" />
          <button className="quiet-button" disabled={files.length === 0} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />} Copy diff</button>
          <Dialog.Close className="icon-button" aria-label="Close review"><X size={16} /></Dialog.Close>
        </header>
        <div className="review-toolbar">
          <span className="review-turn-selector"><strong>Last turn</strong><ChevronDown size={13} /></span>
          <span className="diff-stat"><b>+{additions}</b><i>-{deletions}</i></span>
          <span>{fileCount} file{fileCount === 1 ? '' : 's'}</span>
          {files.length > 0 && <select className="review-file-select" aria-label="Jump to changed file" value={Math.min(activeFile, files.length - 1)} onChange={event => jumpToFile(Number(event.target.value))}>
            {files.map((file, index) => <option value={index} key={`${file.path}:${index}`}>{file.path}</option>)}
          </select>}
        </div>
        <div className="review-workspace">
          <section className="review-diff-view">
            {error && files.length > 0 && <div className="review-inline-warning"><span>{error}</span><button onClick={retry}><RotateCcw size={13} /> Retry</button></div>}
            {loading && files.length === 0 ? <div className="review-state"><LoaderCircle className="spin" size={18} /><span>Loading complete diff…</span></div>
              : model.rows.length === 0 ? <div className="review-state error"><FileDiff size={24} /><span>{unavailableMessage}</span>{target.runId && <button className="quiet-button" onClick={retry}><RotateCcw size={14} /> Retry</button>}</div>
                : <Virtuoso
                  ref={list}
                  className="review-diff-list"
                  data={model.rows}
                  computeItemKey={(index, row) => reviewRowKey(row, index)}
                  rangeChanged={range => setActiveFile(fileIndexAtRow(model.fileStarts, range.startIndex))}
                  itemContent={(_index, row) => <ReviewRowView row={row} />}
                />}
          </section>
          <aside className="review-navigator" aria-label="Changed files">
            <label className="review-filter"><Search size={13} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter files…" /></label>
            <div className="review-tree-root"><Folder size={14} /><strong title={target.repositoryRoot || undefined}>{shortRepositoryRoot(target.repositoryRoot)}</strong><span>{files.length}</span></div>
            <div className="review-tree">
              {filteredEntries.length > 0
                ? <ReviewTree node={fileTree} activeFile={activeFile} onSelect={jumpToFile} />
                : <p>No matching files</p>}
            </div>
          </aside>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function ReviewTree({ node, activeFile, onSelect }: { node: ReviewTreeNode; activeFile: number; onSelect: (index: number) => void }) {
  return <>
    {node.directories.map(directory => <details className="review-tree-directory" open key={directory.path}>
      <summary><ChevronRight size={12} /><Folder size={13} /><span>{directory.name}</span></summary>
      <div><ReviewTree node={directory} activeFile={activeFile} onSelect={onSelect} /></div>
    </details>)}
    {node.files.map(entry => <button className={entry.fileIndex === activeFile ? 'active' : ''} title={entry.file.path} key={`${entry.file.path}:${entry.fileIndex}`} onClick={() => onSelect(entry.fileIndex)}>
      <span className="review-file-status">M</span><FileCode2 size={13} /><span>{entry.name}</span><small><b>+{entry.file.additions}</b><i>-{entry.file.deletions}</i></small>
    </button>)}
  </>
}

function buildFileTree(entries: ReviewTreeEntry[]): ReviewTreeNode {
  type MutableNode = { name: string; path: string; directories: Map<string, MutableNode>; files: ReviewTreeEntry[] }
  const root: MutableNode = { name: '', path: '', directories: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.file.path.split('/').filter(Boolean)
    entry.name = parts.pop() || entry.file.path
    let node = root
    for (const part of parts) {
      const path = node.path ? `${node.path}/${part}` : part
      let child = node.directories.get(part)
      if (!child) {
        child = { name: part, path, directories: new Map(), files: [] }
        node.directories.set(part, child)
      }
      node = child
    }
    node.files.push(entry)
  }
  const freeze = (node: MutableNode): ReviewTreeNode => ({
    name: node.name,
    path: node.path,
    directories: [...node.directories.values()].sort((a, b) => a.name.localeCompare(b.name)).map(freeze),
    files: [...node.files].sort((a, b) => a.name.localeCompare(b.name))
  })
  return freeze(root)
}

function shortRepositoryRoot(path?: string | null): string {
  if (!path) return 'Changed files'
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

function buildReviewModel(files: DiffFile[]): ReviewModel {
  const rows: ReviewRow[] = []
  const fileStarts: number[] = []
  files.forEach((file, fileIndex) => {
    fileStarts.push(rows.length)
    rows.push({ kind: 'file', file, fileIndex })
    let previousOldEnd = 0
    for (const line of file.lines) {
      if (line.kind === 'hunk' && line.oldStart != null) {
        const gap = Math.max(0, line.oldStart - previousOldEnd - (previousOldEnd === 0 ? 1 : 0))
        if (gap > 0) rows.push({ kind: 'gap', count: gap, fileIndex })
        previousOldEnd = line.oldStart + (line.oldCount ?? 1)
      }
      rows.push({ kind: 'line', line, fileIndex })
    }
  })
  return { rows, fileStarts }
}

function fileIndexAtRow(starts: number[], rowIndex: number): number {
  let fileIndex = 0
  for (let index = 0; index < starts.length; index++) {
    if (starts[index] > rowIndex) break
    fileIndex = index
  }
  return fileIndex
}

function reviewRowKey(row: ReviewRow, index: number): string {
  if (row.kind === 'file') return `file:${row.fileIndex}:${row.file.path}`
  if (row.kind === 'gap') return `gap:${row.fileIndex}:${index}`
  return `line:${row.fileIndex}:${index}`
}

function ReviewRowView({ row }: { row: ReviewRow }) {
  if (row.kind === 'file') {
    return <div className="diff-file-header">
      <span title={row.file.path}>{row.file.path}</span>
      <small><b>+{row.file.additions}</b><i>-{row.file.deletions}</i></small>
    </div>
  }
  if (row.kind === 'gap') return <div className="diff-gap">{row.count.toLocaleString()} unmodified line{row.count === 1 ? '' : 's'}</div>
  const line = row.line
  const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : ''
  return <div className={`diff-line ${line.kind}`}>
    <span className="old-line">{line.oldLine ?? ''}</span>
    <span className="new-line">{line.newLine ?? ''}</span>
    <code>{prefix}{line.text}</code>
  </div>
}
