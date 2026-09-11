// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Download, ExternalLink, File, FileCode2, FolderOpen, Maximize2, Pin, Play, Search, X } from 'lucide-react'
import { effectiveFileContentType, isInternalViewerFile, isPreviewableFile } from '@shared/file-content-type'
import { agentFileBelongsToSession } from '@shared/session-files'
import type { AgentFile, PinnedItem, WorkspaceProfileScope } from '@shared/types'
import { trackEvent } from '../lib/analytics'
import { saveAgentFile } from '../lib/file-actions'
import { formatBytes } from '../lib/format'
import { requirePinnedItemsScope } from '../lib/pinned-items'
import { useTransientClose } from '../lib/transient-close'
import { requestOpenAgentFile, workspacePathForAgentFile } from '../lib/workspace-file-links'
import { useAppStore } from '../store/app-store'
import { NativeFileDragSurface } from './NativeFileDragSurface'

export const MediaGrid = memo(function MediaGrid({ files, sessionId, profileScope, onFind, compact = false, pinnedItemIds = EMPTY_PIN_IDS }: {
  files: AgentFile[]; sessionId: string; profileScope: WorkspaceProfileScope | null; onFind?: (file: AgentFile) => void; compact?: boolean; pinnedItemIds?: ReadonlySet<string>
}) {
  useLocale()
  const [preview, setPreview] = useState<AgentFile | null>(null)
  const [showAll, setShowAll] = useState(false)
  const workspaceRoot = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.cwd ?? null)
  const visible = showAll ? files : files.slice(0, 4)
  const media = visible.filter(isPreviewableFile)
  const documents = visible.filter(file => !isPreviewableFile(file))
  if (!files.length) return null
  return (
    <div className={`media-section ${compact ? 'compact' : ''}`}>
      <div className="media-heading"><span>{t("ui.MediaGrid.MediaGrid.files_media_6864970")}</span><small>{files.length}</small></div>
      {media.length > 0 && <div className={`media-grid count-${Math.min(media.length, 4)}`}>
        {media.map(file => <MediaTile key={file.id} file={file} sessionId={sessionId} profileScope={profileScope} workspaceRoot={workspaceRoot} onPreview={() => { trackEvent('file_view_opened'); setPreview(file) }} onFind={onFind} pinned={pinnedItemIds.has(`file:${file.id}`)} />)}
      </div>}
      {documents.length > 0 && <div className="timeline-document-grid">
        {documents.map(file => <MediaTile key={file.id} file={file} sessionId={sessionId} profileScope={profileScope} workspaceRoot={workspaceRoot} onPreview={() => { trackEvent('file_view_opened'); setPreview(file) }} onFind={onFind} pinned={pinnedItemIds.has(`file:${file.id}`)} />)}
      </div>}
      {files.length > 4 && <button type="button" className="quiet-button media-more" onClick={() => setShowAll(value => !value)}>{showAll ? t("ui.MediaGrid.MediaGrid.show_less_94ea9b1") : t("ui.MediaGrid.MediaGrid.show_more_e372f20", { "count": String(files.length - 4) })}</button>}
      <MediaPreviewDialog sessionId={sessionId} file={preview} files={files} onSelect={setPreview} onClose={() => setPreview(null)} />
    </div>
  )
})

const EMPTY_PIN_IDS: ReadonlySet<string> = new Set()
const EMPTY_MEDIA_FILES: AgentFile[] = []

const MediaTile = memo(function MediaTile({ file, sessionId, profileScope, workspaceRoot, onPreview, onFind, pinned }: { file: AgentFile; sessionId: string; profileScope: WorkspaceProfileScope | null; workspaceRoot: string | null; onPreview: () => void; onFind?: (file: AgentFile) => void; pinned: boolean }) {
  useLocale()
  const type = effectiveFileContentType(file)
  const media = type.startsWith('image/') || type.startsWith('video/')
  const source = profileScope
    ? window.agentsDock.files.mediaURL(profileScope.profileId, profileScope.profileGeneration, sessionId, file.id)
    : undefined
  const workspacePath = workspacePathForAgentFile(file, workspaceRoot)
  const canOpenInEditor = Boolean(workspacePath) || isInternalViewerFile(file)
  const openInEditor = () => requestOpenAgentFile(sessionId, file)
  const pinId = `file:${file.id}`
  const togglePin = async () => {
    if (pinned) {
      await window.agentsDock.pins.remove(requirePinnedItemsScope(profileScope), sessionId, pinId)
      window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
      return
    }
    if (!agentFileBelongsToSession(file, sessionId)) return
    const item: PinnedItem = {
      id: `file:${file.id}`,
      sessionId,
      kind: 'file',
      fileId: file.id,
      fileSessionId: sessionId,
      filename: file.filename,
      content_type: file.content_type,
      path: file.path,
      source_path: file.source_path,
      title: file.title || file.filename,
      createdAt: Date.now()
    }
    await window.agentsDock.pins.put(requirePinnedItemsScope(profileScope), item)
    window.dispatchEvent(new CustomEvent('agentsdock:pins-changed', { detail: sessionId }))
  }
  const actions = <div className="media-actions" data-native-drag-ignore>
    {media && <button type="button" title={t("ui.MediaGrid.MediaTile.preview_324b134")} onClick={onPreview}><Maximize2 size={12} /></button>}
    {onFind && <button type="button" title={t("ui.MediaGrid.MediaTile.find_in_chat_df9554c")} onClick={() => onFind(file)}><Search size={12} /></button>}
    {canOpenInEditor && <button type="button" title={t("ui.MediaGrid.MediaTile.open_in_editor_f395ae5")} onClick={openInEditor}><FileCode2 size={12} /></button>}
    <button type="button" title={t("ui.MediaGrid.MediaTile.download_d6eafe8")} onClick={() => void saveAgentFile(sessionId, file)}><Download size={12} /></button>
    <button type="button" title={t("ui.MediaGrid.MediaTile.show_in_folder_3c4d9b8")} onClick={() => runMediaAction(window.agentsDock.files.reveal(sessionId, file))}><FolderOpen size={12} /></button>
    <button type="button" title={t("ui.MediaGrid.MediaTile.open_ed077f3")} onClick={() => runMediaAction(window.agentsDock.files.open(sessionId, file))}><ExternalLink size={12} /></button>
    <button type="button" className={`pin-button ${pinned ? 'active' : ''}`} aria-pressed={pinned} title={pinned ? t("ui.MediaGrid.MediaTile.unpin_file_1cf0044") : t("ui.MediaGrid.MediaTile.pin_file_59902fc")} onClick={() => runMediaAction(togglePin())}><Pin size={12} fill={pinned ? 'currentColor' : 'none'} /></button>
  </div>
  if (!media) return (
    <NativeFileDragSurface sessionId={sessionId} file={file} className="media-file-row">
      <span className="compact-file-glyph"><File size={17} /></span>
      <button type="button" className="media-file-copy" data-native-drag-ignore onClick={() => canOpenInEditor ? openInEditor() : runMediaAction(window.agentsDock.files.open(sessionId, file))}>
        <strong title={file.title || file.filename}>{file.title || file.filename}</strong>
        <small>{formatBytes(file.size)}</small>
      </button>
      {actions}
    </NativeFileDragSurface>
  )
  return (
    <NativeFileDragSurface
      sessionId={sessionId}
      file={file}
      className={`media-tile ${media ? 'has-preview' : 'file-only'}`}
    >
      <button type="button" className="media-preview" onClick={media ? onPreview : () => runMediaAction(window.agentsDock.files.open(sessionId, file))}>
        {type.startsWith('image/') ? <img src={source} alt={file.title || file.filename} loading="lazy" draggable={false} />
          : type.startsWith('video/') && source ? <><LazyVideoThumbnail source={source} /><span className="play-badge"><Play size={16} fill="currentColor" /></span></>
          : <span className="file-glyph"><File size={22} /></span>}
      </button>
      <div className="media-meta"><strong title={file.title || file.filename}>{file.title || file.filename}</strong><small>{formatBytes(file.size)}</small></div>
      {actions}
    </NativeFileDragSurface>
  )
})

export function LazyVideoThumbnail({ source }: { source: string }) {
  useLocale()
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

export function MediaPreviewDialog({ sessionId, file, files = EMPTY_MEDIA_FILES, onSelect, onClose }: {
  sessionId: string
  file: AgentFile | null
  files?: AgentFile[]
  onSelect?: (file: AgentFile) => void
  onClose: () => void
}) {
  useLocale()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  useTransientClose(Boolean(file), onClose)
  const gallery = useMemo(() => {
    const media = files.filter(isPreviewableFile)
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
  const source = activeProfileId
    ? window.agentsDock.files.mediaURL(activeProfileId, profileGeneration, sessionId, file.id)
    : undefined
  const video = effectiveFileContentType(file).startsWith('video/')
  const canGoPrevious = Boolean(onSelect && index > 0)
  const canGoNext = Boolean(onSelect && index >= 0 && index < gallery.length - 1)
  const showNavigation = Boolean(onSelect && gallery.length > 1)
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="media-dialog">
          <div className="media-dialog-head"><Dialog.Title>{file.title || file.filename}</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label={t("ui.MediaGrid.MediaPreviewDialog.close_media_preview_cf8d4bc")}><X size={16} /></button></Dialog.Close></div>
          <div className="media-dialog-body">
            {showNavigation && <button className="media-dialog-nav previous" type="button" aria-label={t("ui.MediaGrid.MediaPreviewDialog.previous_media_26b519b")} title={t("ui.MediaGrid.MediaPreviewDialog.previous_media_left_arrow_c5a64a9")} disabled={!canGoPrevious} onClick={() => void navigate(-1)}><ChevronLeft size={22} /></button>}
            {video ? <video key={`${activeProfileId ?? 'none'}:${profileGeneration}:${file.id}`} src={source} controls autoPlay /> : <img key={`${activeProfileId ?? 'none'}:${profileGeneration}:${file.id}`} src={source} alt={file.title || file.filename} />}
            {showNavigation && <button className="media-dialog-nav next" type="button" aria-label={t("ui.MediaGrid.MediaPreviewDialog.next_media_e752122")} title={t("ui.MediaGrid.MediaPreviewDialog.next_media_right_arrow_fbf2490")} disabled={!canGoNext} onClick={() => void navigate(1)}><ChevronRight size={22} /></button>}
          </div>
          <div className="media-dialog-foot"><span>{formatBytes(file.size)}{showNavigation ? t("ui.MediaGrid.MediaPreviewDialog.of_951f776", { "current": String(index + 1), "total": String(gallery.length) }) : ''}</span><button type="button" className="quiet-button" onClick={() => void saveAgentFile(sessionId, file)}><Download size={14} />{" "}{t("ui.MediaGrid.MediaPreviewDialog.download_d6eafe8")}</button><button type="button" className="quiet-button" onClick={() => runMediaAction(window.agentsDock.files.open(sessionId, file))}><ExternalLink size={14} />{" "}{t("ui.MediaGrid.MediaPreviewDialog.open_ed077f3")}</button></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

function runMediaAction(operation: Promise<unknown>): void {
  void operation.catch(error => {
    useAppStore.getState().setError(error instanceof Error ? error.message : String(error))
  })
}
