import { memo, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Download, ExternalLink, File, FolderOpen, Maximize2, Pin, Play, Search, X } from 'lucide-react'
import type { AgentFile, PinnedItem } from '@shared/types'
import { formatBytes } from '../lib/format'

export const MediaGrid = memo(function MediaGrid({ files, sessionId, onFind, compact = false }: {
  files: AgentFile[]; sessionId: string; onFind?: (file: AgentFile) => void; compact?: boolean
}) {
  const [preview, setPreview] = useState<AgentFile | null>(null)
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? files : files.slice(0, 4)
  if (!files.length) return null
  return (
    <div className={`media-section ${compact ? 'compact' : ''}`}>
      <div className="media-heading"><span>Files &amp; media</span><small>{files.length}</small></div>
      <div className={`media-grid count-${Math.min(visible.length, 4)}`}>
        {visible.map(file => <MediaTile key={file.id} file={file} sessionId={sessionId} onPreview={() => setPreview(file)} onFind={onFind} />)}
      </div>
      {files.length > 4 && <button className="quiet-button media-more" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show less' : `Show ${files.length - 4} more`}</button>}
      <MediaPreviewDialog file={preview} onClose={() => setPreview(null)} />
    </div>
  )
})

const MediaTile = memo(function MediaTile({ file, sessionId, onPreview, onFind }: { file: AgentFile; sessionId: string; onPreview: () => void; onFind?: (file: AgentFile) => void }) {
  const type = file.content_type ?? ''
  const media = type.startsWith('image/') || type.startsWith('video/')
  const source = window.agentsDock.files.mediaURL(file.id)
  const pin = async () => {
    const item: PinnedItem = { id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, subtitle: file.text, createdAt: Date.now() }
    await window.agentsDock.pins.put(item)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  return (
    <article
      className={`media-tile ${media ? 'has-preview' : 'file-only'}`}
      draggable
      onDragStart={event => { event.preventDefault(); window.agentsDock.files.beginDrag(file) }}
    >
      <button className="media-preview" onClick={media ? onPreview : () => void window.agentsDock.files.open(file)}>
        {type.startsWith('image/') ? <img src={source} alt={file.title || file.filename} loading="lazy" />
          : type.startsWith('video/') ? <><LazyVideoThumbnail source={source} /><span className="play-badge"><Play size={16} fill="currentColor" /></span></>
          : <span className="file-glyph"><File size={22} /></span>}
      </button>
      <div className="media-meta"><strong title={file.title || file.filename}>{file.title || file.filename}</strong><small>{formatBytes(file.size)}</small></div>
      <div className="media-actions">
        {media && <button title="Preview" onClick={onPreview}><Maximize2 size={12} /></button>}
        {onFind && <button title="Find in chat" onClick={() => onFind(file)}><Search size={12} /></button>}
        <button title="Download" onClick={() => void window.agentsDock.files.save(file)}><Download size={12} /></button>
        <button title="Reveal in Finder" onClick={() => void window.agentsDock.files.reveal(file)}><FolderOpen size={12} /></button>
        <button title="Open" onClick={() => void window.agentsDock.files.open(file)}><ExternalLink size={12} /></button>
        <button title="Pin" onClick={() => void pin()}><Pin size={12} /></button>
      </div>
    </article>
  )
})

export function LazyVideoThumbnail({ source }: { source: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [active, setActive] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (!node || active) return
    if (!('IntersectionObserver' in window)) { setActive(true); return }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setActive(true)
      observer.disconnect()
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [active])
  return <span ref={ref} className="lazy-video-thumb">{active && <video src={source} preload="metadata" muted />}</span>
}

export function MediaPreviewDialog({ file, onClose }: { file: AgentFile | null; onClose: () => void }) {
  if (!file) return null
  const source = window.agentsDock.files.mediaURL(file.id)
  const video = file.content_type?.startsWith('video/')
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="media-dialog">
          <div className="media-dialog-head"><Dialog.Title>{file.title || file.filename}</Dialog.Title><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
          <div className="media-dialog-body">{video ? <video src={source} controls autoPlay /> : <img src={source} alt={file.title || file.filename} />}</div>
          <div className="media-dialog-foot"><span>{formatBytes(file.size)}</span><button className="quiet-button" onClick={() => void window.agentsDock.files.save(file)}><Download size={14} /> Download</button><button className="quiet-button" onClick={() => void window.agentsDock.files.open(file)}><ExternalLink size={14} /> Open</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
