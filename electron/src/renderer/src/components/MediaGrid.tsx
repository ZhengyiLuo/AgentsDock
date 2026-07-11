import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, FolderOpen, Maximize2, Pin, Play, Search, X } from 'lucide-react'
import type { AgentFile, PinnedItem } from '@shared/types'
import { formatBytes } from '../lib/format'
import { useTransientClose } from '../lib/transient-close'
import { NativeFileDragSurface } from './NativeFileDragSurface'

export const MediaGrid = memo(function MediaGrid({ files, sessionId, onFind, compact = false, pinnedItemIds = EMPTY_PIN_IDS }: {
  files: AgentFile[]; sessionId: string; onFind?: (file: AgentFile) => void; compact?: boolean; pinnedItemIds?: ReadonlySet<string>
}) {
  const [preview, setPreview] = useState<AgentFile | null>(null)
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? files : files.slice(0, 4)
  const media = visible.filter(isPreviewableMedia)
  const documents = visible.filter(file => !isPreviewableMedia(file))
  if (!files.length) return null
  return (
    <div className={`media-section ${compact ? 'compact' : ''}`}>
      <div className="media-heading"><span>Files &amp; media</span><small>{files.length}</small></div>
      {media.length > 0 && <div className={`media-grid count-${Math.min(media.length, 4)}`}>
        {media.map(file => <MediaTile key={file.id} file={file} sessionId={sessionId} onPreview={() => setPreview(file)} onFind={onFind} pinned={pinnedItemIds.has(`file:${file.id}`)} />)}
      </div>}
      {documents.length > 0 && <div className="timeline-document-grid">
        {documents.map(file => <MediaTile key={file.id} file={file} sessionId={sessionId} onPreview={() => setPreview(file)} onFind={onFind} pinned={pinnedItemIds.has(`file:${file.id}`)} />)}
      </div>}
      {files.length > 4 && <button className="quiet-button media-more" onClick={() => setShowAll(value => !value)}>{showAll ? 'Show less' : `Show ${files.length - 4} more`}</button>}
      <MediaPreviewDialog file={preview} files={files} onSelect={setPreview} onClose={() => setPreview(null)} />
    </div>
  )
})

const EMPTY_PIN_IDS: ReadonlySet<string> = new Set()
const EMPTY_MEDIA_FILES: AgentFile[] = []

const MediaTile = memo(function MediaTile({ file, sessionId, onPreview, onFind, pinned }: { file: AgentFile; sessionId: string; onPreview: () => void; onFind?: (file: AgentFile) => void; pinned: boolean }) {
  const type = file.content_type ?? ''
  const media = type.startsWith('image/') || type.startsWith('video/')
  const source = window.agentsDock.files.mediaURL(file.id)
  const pinId = `file:${file.id}`
  const togglePin = async () => {
    if (pinned) {
      await window.agentsDock.pins.remove(sessionId, pinId)
      window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
      return
    }
    const item: PinnedItem = { id: `file:${file.id}`, sessionId, kind: 'file', fileId: file.id, title: file.title || file.filename, subtitle: file.text, createdAt: Date.now() }
    await window.agentsDock.pins.put(item)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  const actions = <div className="media-actions" data-native-drag-ignore>
    {media && <button title="Preview" onClick={onPreview}><Maximize2 size={12} /></button>}
    {onFind && <button title="Find in chat" onClick={() => onFind(file)}><Search size={12} /></button>}
    <button title="Download" onClick={() => void window.agentsDock.files.save(file)}><Download size={12} /></button>
    <button title="Reveal in Finder" onClick={() => void window.agentsDock.files.reveal(file)}><FolderOpen size={12} /></button>
    <button title="Open" onClick={() => void window.agentsDock.files.open(file)}><ExternalLink size={12} /></button>
    <button className={`pin-button ${pinned ? 'active' : ''}`} aria-pressed={pinned} title={pinned ? 'Unpin file' : 'Pin file'} onClick={() => void togglePin()}><Pin size={12} fill={pinned ? 'currentColor' : 'none'} /></button>
  </div>
  if (!media) return (
    <NativeFileDragSurface file={file} className="media-file-row">
      <span className="compact-file-glyph"><File size={17} /></span>
      <button className="media-file-copy" data-native-drag-ignore onClick={() => void window.agentsDock.files.open(file)}>
        <strong title={file.title || file.filename}>{file.title || file.filename}</strong>
        <small>{formatBytes(file.size)}</small>
      </button>
      {actions}
    </NativeFileDragSurface>
  )
  return (
    <NativeFileDragSurface
      file={file}
      className={`media-tile ${media ? 'has-preview' : 'file-only'}`}
    >
      <button className="media-preview" onClick={media ? onPreview : () => void window.agentsDock.files.open(file)}>
        {type.startsWith('image/') ? <img src={source} alt={file.title || file.filename} loading="lazy" draggable={false} />
          : type.startsWith('video/') ? <><LazyVideoThumbnail source={source} /><span className="play-badge"><Play size={16} fill="currentColor" /></span></>
          : <span className="file-glyph"><File size={22} /></span>}
      </button>
      <div className="media-meta"><strong title={file.title || file.filename}>{file.title || file.filename}</strong><small>{formatBytes(file.size)}</small></div>
      {actions}
    </NativeFileDragSurface>
  )
})

function isPreviewableMedia(file: AgentFile): boolean {
  return Boolean(file.content_type?.startsWith('image/') || file.content_type?.startsWith('video/'))
}

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
  return <span ref={ref} className="lazy-video-thumb">{active && <video src={source} preload="metadata" muted draggable={false} />}</span>
}

export function MediaPreviewDialog({ file, files = EMPTY_MEDIA_FILES, onSelect, onClose }: {
  file: AgentFile | null
  files?: AgentFile[]
  onSelect?: (file: AgentFile) => void
  onClose: () => void
}) {
  useTransientClose(Boolean(file), onClose)
  const gallery = useMemo(() => {
    const media = files.filter(isPreviewableMedia)
    if (!file || media.some(candidate => candidate.id === file.id)) return media
    return [file, ...media]
  }, [file, files])
  const index = file ? gallery.findIndex(candidate => candidate.id === file.id) : -1
  const navigate = useCallback((offset: -1 | 1) => {
    if (!onSelect) return false
    const next = gallery[index + offset]
    if (!next) return false
    onSelect(next)
    return true
  }, [gallery, index, onSelect])

  useEffect(() => {
    if (!file || !onSelect || gallery.length < 2) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || isEditableTarget(event.target)) return
      const offset = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null
      if (!offset || !navigate(offset)) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [file, gallery.length, navigate, onSelect])

  if (!file) return null
  const source = window.agentsDock.files.mediaURL(file.id)
  const video = file.content_type?.startsWith('video/')
  const canGoPrevious = Boolean(onSelect && index > 0)
  const canGoNext = Boolean(onSelect && index >= 0 && index < gallery.length - 1)
  const showNavigation = Boolean(onSelect && gallery.length > 1)
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="media-dialog">
          <div className="media-dialog-head"><Dialog.Title>{file.title || file.filename}</Dialog.Title><Dialog.Close className="icon-button"><X size={16} /></Dialog.Close></div>
          <div className="media-dialog-body">
            {showNavigation && <button className="media-dialog-nav previous" type="button" aria-label="Previous media" title="Previous media (Left Arrow)" disabled={!canGoPrevious} onClick={() => void navigate(-1)}><ChevronLeft size={22} /></button>}
            {video ? <video key={file.id} src={source} controls autoPlay /> : <img key={file.id} src={source} alt={file.title || file.filename} />}
            {showNavigation && <button className="media-dialog-nav next" type="button" aria-label="Next media" title="Next media (Right Arrow)" disabled={!canGoNext} onClick={() => void navigate(1)}><ChevronRight size={22} /></button>}
          </div>
          <div className="media-dialog-foot"><span>{formatBytes(file.size)}{showNavigation ? ` · ${index + 1} of ${gallery.length}` : ''}</span><button className="quiet-button" onClick={() => void window.agentsDock.files.save(file)}><Download size={14} /> Download</button><button className="quiet-button" onClick={() => void window.agentsDock.files.open(file)}><ExternalLink size={14} /> Open</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}
