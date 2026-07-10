import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, FileDiff, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { CodeReviewTarget, DiffFile, DiffLine } from '../lib/timeline'
import { parseUnifiedDiff } from '../lib/timeline'
import { useTransientClose } from '../lib/transient-close'

type ReviewRow =
  | { kind: 'file'; file: DiffFile; fileIndex: number }
  | { kind: 'gap'; count: number; fileIndex: number }
  | { kind: 'line'; line: DiffLine; fileIndex: number }

interface ReviewModel {
  rows: ReviewRow[]
  fileStarts: number[]
}

export function CodeReview({ target, onClose }: { target: CodeReviewTarget | null; onClose: () => void }) {
  useTransientClose(Boolean(target), onClose)
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activeFile, setActiveFile] = useState(0)
  const list = useRef<VirtuosoHandle>(null)

  useEffect(() => {
    let active = true
    setSource(target?.source ?? '')
    setError(null)
    setCopied(false)
    setActiveFile(0)
    if (!target?.runId) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void window.agentsDock.diffs.get(target.sessionId, target.runId)
      .then(diff => { if (active) setSource(diff) })
      .catch(reason => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [target])

  const files = useMemo(() => parseUnifiedDiff(source), [source])
  const model = useMemo(() => buildReviewModel(files), [files])
  const additions = target?.additions ?? files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = target?.deletions ?? files.reduce((sum, file) => sum + file.deletions, 0)
  const fileCount = target?.files?.length ?? files.length

  if (!target) return null

  const retry = () => {
    if (!target.runId) return
    setLoading(true)
    setError(null)
    void window.agentsDock.diffs.get(target.sessionId, target.runId)
      .then(setSource)
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false))
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

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay review-overlay" />
      <Dialog.Content className="review-dialog">
        <Dialog.Description className="sr-only">Complete code changes from the selected agent turn.</Dialog.Description>
        <header className="review-header">
          <Dialog.Title><FileDiff size={16} /> Review</Dialog.Title>
          <span className="diff-stat"><b>+{additions}</b><i>-{deletions}</i></span>
          <span className="review-spacer" />
          <button className="quiet-button" disabled={!source} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />} Copy diff</button>
          <Dialog.Close className="icon-button" aria-label="Close review"><X size={16} /></Dialog.Close>
        </header>
        <div className="review-toolbar">
          <strong>Last turn</strong>
          <span>{fileCount} file{fileCount === 1 ? '' : 's'}</span>
          {files.length > 0 && <select aria-label="Jump to changed file" value={Math.min(activeFile, files.length - 1)} onChange={event => jumpToFile(Number(event.target.value))}>
            {files.map((file, index) => <option value={index} key={`${file.path}:${index}`}>{file.path}</option>)}
          </select>}
        </div>
        <section className="review-diff-view">
          {loading && !source ? <div className="review-state"><LoaderCircle className="spin" size={18} /><span>Loading complete diff…</span></div>
            : error && !source ? <div className="review-state error"><span>{error}</span><button className="quiet-button" onClick={retry}><RotateCcw size={14} /> Retry</button></div>
              : model.rows.length === 0 ? <div className="review-state"><span>No unified diff was found for this turn.</span></div>
                : <Virtuoso
                  ref={list}
                  className="review-diff-list"
                  data={model.rows}
                  computeItemKey={(index, row) => reviewRowKey(row, index)}
                  rangeChanged={range => setActiveFile(fileIndexAtRow(model.fileStarts, range.startIndex))}
                  itemContent={(_index, row) => <ReviewRowView row={row} />}
                />}
        </section>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
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
