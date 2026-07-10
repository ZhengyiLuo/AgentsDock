import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, Copy, FileDiff, X } from 'lucide-react'
import { parseUnifiedDiff } from '../lib/timeline'
import { useTransientClose } from '../lib/transient-close'

export function CodeReview({ source, onClose }: { source: string | null; onClose: () => void }) {
  useTransientClose(Boolean(source), onClose)
  const files = useMemo(() => parseUnifiedDiff(source ?? ''), [source])
  const [selected, setSelected] = useState(0)
  const [copied, setCopied] = useState(false)
  const file = files[selected] ?? files[0]
  if (!source) return null
  const additions = files.reduce((sum, item) => sum + item.additions, 0)
  const deletions = files.reduce((sum, item) => sum + item.deletions, 0)
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay review-overlay" />
      <Dialog.Content className="review-dialog">
        <header className="review-header">
          <Dialog.Title><FileDiff size={16} /> Review changes</Dialog.Title>
          <span className="diff-stat"><b>+{additions}</b><i>-{deletions}</i></span>
          <span className="review-spacer" />
          <button className="quiet-button" onClick={() => void navigator.clipboard.writeText(source).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) })}>{copied ? <Check size={14} /> : <Copy size={14} />} Copy diff</button>
          <Dialog.Close className="icon-button"><X size={16} /></Dialog.Close>
        </header>
        <div className="review-body">
          <nav className="review-files">
            <div className="review-files-label">Edited {files.length} file{files.length === 1 ? '' : 's'}</div>
            {files.map((item, index) => <button key={`${item.path}:${index}`} className={index === selected ? 'selected' : ''} onClick={() => setSelected(index)}><span title={item.path}>{item.path}</span><small><b>+{item.additions}</b><i>-{item.deletions}</i></small></button>)}
          </nav>
          <section className="diff-view">
            {file ? <><div className="diff-file-header"><span>{file.path}</span><small><b>+{file.additions}</b><i>-{file.deletions}</i></small></div><div className="diff-lines">{file.lines.map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="old-line">{line.oldLine ?? ''}</span><span className="new-line">{line.newLine ?? ''}</span><code>{line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}{line.text}</code></div>)}</div></> : <div className="review-empty">No unified diff was found in this turn.</div>}
          </section>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
