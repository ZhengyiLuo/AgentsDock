import { t, useLocale } from '../lib/i18n'
import {
  lazy,
  memo,
  Suspense,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import {
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRightClose,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { internalFileViewerKind, type InternalFileViewerKind } from '@shared/file-content-type'
import type {
  AgentFile,
  AgentTextFile,
  Session,
  WorkspaceCreateResult,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceProfileScope
} from '@shared/types'
import { agentFileBelongsToSession } from '@shared/session-files'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_THEMES,
  readEditorAppearance,
  writeEditorAppearance
} from '../lib/editor-appearance'
import { trackEvent } from '../lib/analytics'
import { getWorkspacePreference, setWorkspacePreference } from '../lib/workspace-preferences'
import {
  workspacePathForAgentFile,
  type OpenAgentFileDetail,
  type OpenWorkspacePathDetail
} from '../lib/workspace-file-links'
import {
  workspaceTabNavigationShortcut,
  workspaceTabNavigationTarget
} from '../lib/workspace-shortcuts'
import { useTransientClose } from '../lib/transient-close'
import type { CodeMirrorNavigationRequest, CodeMirrorViewState } from './CodeMirrorEditor'
import { MarkdownContent } from './MarkdownContent'
import { ShortcutKey } from './ShortcutTooltip'
import './WorkspaceEditor.css'

const LazyCodeMirrorEditor = lazy(() => import('./CodeMirrorEditor').then(module => ({ default: module.CodeMirrorEditor })))
const LazySafeHtmlMarkdownContent = lazy(() => import('./SafeHtmlMarkdownContent'))
const MAX_OPEN_TABS = 12
// Servers predating the advertised workspace capability enforce 2 MiB. Keep
// that fallback only when the field is absent; an explicit zero means that a
// newer server deliberately disabled its ceiling.
const LEGACY_MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024
const MAX_MEMORY_BYTES = 12 * 1024 * 1024
const WORKSPACE_DIRECTORY_PAGE_SIZE = 500
const MAX_AUTO_REVEAL_EXTRA_PAGES = 1
const MAX_AUTO_REVEAL_STEPS = 32
const MAX_AUTO_REVEAL_DIRECTORY_LOADS = 8
const DRAFT_PERSIST_DEBOUNCE_MS = 1500
const WORKSPACE_SPLIT_STORAGE_KEY = 'agentsdock:workspace-editor-split'
const DEFAULT_EDITOR_SPLIT_PERCENT = 58
const MIN_EDITOR_SPLIT_PERCENT = 38
const MAX_EDITOR_SPLIT_PERCENT = 72
const DEFAULT_EXPLORER_WIDTH = 232
const MIN_EXPLORER_WIDTH = 160
const MIN_EDITOR_CONTENT_WIDTH = 240
const EXPLORER_RESIZE_HANDLE_WIDTH = 5
const COMPACT_EXPLORER_PANEL_WIDTH = 440
const DEFAULT_MARKDOWN_SOURCE_PERCENT = 50
const MIN_MARKDOWN_SOURCE_PERCENT = 20
const MAX_MARKDOWN_SOURCE_PERCENT = 80
const workspaceMemory = new Map<string, WorkspaceMemoryState>()

type EditorSplitSide = 'left' | 'right'
type FilePresentation = 'full' | 'split'

interface EditorSplitPreference {
  side: EditorSplitSide
  editorPercent: number
  explorerWidth: number
  markdownSourcePercent: number
}

interface OpenWorkspaceFile extends WorkspaceFile {
  origin: 'workspace' | 'external' | 'artifact' | 'untitled'
  viewerKind: Exclude<InternalFileViewerKind, 'unsupported'>
  artifact?: AgentFile
  displayPath?: string
  saveDirectory?: string
  draft: string
  saved: string
  dirty: boolean
  saving: boolean
  loading: boolean
  loaded: boolean
  conflicted: boolean
  lines: number
  error: string | null
  previewSize?: number
  truncated?: boolean
}

interface DirectoryState {
  entries: WorkspaceEntry[]
  total: number
  loading: boolean
  error: string | null
}

interface PersistedTab {
  path: string
  artifact?: AgentFile
  external?: true
  untitled?: boolean
  name?: string
  saveDirectory?: string
  dirty?: boolean
  revision?: string
  draft?: string
  viewState?: CodeMirrorViewState
  secondaryViewState?: CodeMirrorViewState
  markdownViewMode?: MarkdownViewMode
}

interface PersistedWorkspaceState {
  version: 5
  cwd: string
  activePath: string | null
  secondaryPath: string | null
  activeGroup: EditorGroupId
  filePresentation: FilePresentation
  tabs: PersistedTab[]
}

interface LegacyPersistedWorkspaceState {
  version: 1 | 2 | 3 | 4
  cwd: string
  activePath: string | null
  secondaryPath?: string | null
  activeGroup?: EditorGroupId
  filePresentation?: FilePresentation
  tabs: PersistedTab[]
}

interface WorkspaceMemoryState {
  sessionId: string
  cwd: string
  activePath: string | null
  secondaryPath: string | null
  activeGroup: EditorGroupId
  filePresentation: FilePresentation
  openFiles: OpenWorkspaceFile[]
  viewStates: Map<string, CodeMirrorViewState>
  markdownViewModes: Map<string, MarkdownViewMode>
}

interface EditorNavigationRequest extends CodeMirrorNavigationRequest {
  path: string
}

interface OpenWorkspaceFileOptions {
  quiet?: boolean
  preserveReferenceRequest?: boolean
  targetGroup?: EditorGroupId
  errorSurface?: 'palette' | 'workspace'
  paletteLease?: PaletteOpenLease
}

type EditorGroupId = 'primary' | 'secondary'
interface PaletteOpenLease {
  generation: number
  targetGroup: EditorGroupId
}
type PendingOpenOutcome =
  | { kind: 'opened'; path: string }
  | { kind: 'failed'; error: string }
  | { kind: 'stale' }
interface PendingOpenReservation {
  token: symbol
  paletteGeneration: number | null
}
type PaletteCloseReason = 'cancel' | 'commit'
type MarkdownViewMode = 'source' | 'split' | 'preview'

interface PersistedWorkspaceSnapshot {
  target: string
  state: PersistedWorkspaceState
}

interface DraftFlushEventDetail {
  promises?: Promise<unknown>[]
  waitUntil?: (promise: PromiseLike<unknown> | unknown) => void
}

interface PendingWorkspaceMutation {
  kind: 'create' | 'rename' | 'delete' | 'save-as'
  path: string
}

type WorkspaceCreateKind = 'file' | 'directory'

interface PendingWorkspaceCreate {
  directory: string
  kind: WorkspaceCreateKind
  creating: boolean
  error: string | null
}

interface PendingUntitledSave {
  path: string
  directory: string
  name: string
  saving: boolean
  closeAfterSave: boolean
  overwriteConfirmed: boolean
  error: string | null
}

interface PendingWorkspaceFileOperation {
  kind: 'read' | 'reload' | 'save'
  token: symbol
}

interface SaveWorkspaceFileOptions {
  overwriteConflict?: boolean
}

export type WorkspacePathInputResolution =
  | { kind: 'search' }
  | { kind: 'workspace-file'; path: string }
  | { kind: 'absolute-file'; path: string }
  | { kind: 'outside-workspace' }

export type WorkspaceReferenceResolution =
  | { kind: 'match'; path: string }
  | { kind: 'ambiguous'; matches: WorkspaceEntry[] }
  | { kind: 'missing' }

export interface WorkspaceEditorProps {
  chatContent: ReactNode
  workspaceKey: string
  session: Session
  profileScope: WorkspaceProfileScope | null
  available: boolean | null
  capabilityVersion?: number
  maxTextFileBytes?: number
  unavailableMessage?: string
  onReady?: () => void
  onReturnToChat?: () => void
}

export function WorkspaceEditor({
  chatContent,
  workspaceKey,
  session,
  profileScope,
  available,
  capabilityVersion = 1,
  maxTextFileBytes,
  unavailableMessage,
  onReady,
  onReturnToChat
}: WorkspaceEditorProps) {
  useLocale()
  const instanceId = useId().replace(/:/g, '')
  const preferenceKey = `workspace-editor:${session.id}`
  const cwd = session.cwd ?? ''
  const maxEditableFileBytes = resolvedWorkspaceFileByteLimit(maxTextFileBytes)
  const memory = workspaceMemory.get(workspaceKey)
  const memoryMatches = memory?.sessionId === session.id && memory.cwd === cwd
  const memoryFiles = memoryMatches
    ? memory.openFiles.filter(file => (
      !file.artifact || agentFileBelongsToSession(file.artifact, session.id)
    ))
    : []
  const memoryPaths = new Set(memoryFiles.map(file => file.path))
  const [openFiles, setOpenFiles] = useState<OpenWorkspaceFile[]>(memoryFiles)
  const [activePath, setActivePath] = useState<string | null>(() => memory?.activePath && memoryPaths.has(memory.activePath) ? memory.activePath : null)
  const [secondaryPath, setSecondaryPath] = useState<string | null>(() => memory?.secondaryPath && memoryPaths.has(memory.secondaryPath) ? memory.secondaryPath : null)
  const [activeGroup, setActiveGroup] = useState<EditorGroupId>(() => memoryMatches ? memory.activeGroup ?? 'primary' : 'primary')
  const [restored, setRestored] = useState(memoryMatches)
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null)
  const [pendingReloadPath, setPendingReloadPath] = useState<string | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteGroup, setPaletteGroup] = useState<EditorGroupId | null>(null)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [paletteResults, setPaletteResults] = useState<WorkspaceEntry[]>([])
  const [paletteLoading, setPaletteLoading] = useState(false)
  const [paletteError, setPaletteError] = useState<string | null>(null)
  const [paletteTruncated, setPaletteTruncated] = useState(false)
  const [openingPath, setOpeningPath] = useState<string | null>(null)
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set())
  const [workspaceRoot, setWorkspaceRoot] = useState(cwd)
  const [pendingCreate, setPendingCreate] = useState<PendingWorkspaceCreate | null>(null)
  const [pendingUntitledSave, setPendingUntitledSave] = useState<PendingUntitledSave | null>(null)
  const [pendingRenameEntry, setPendingRenameEntry] = useState<WorkspaceEntry | null>(null)
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState<WorkspaceEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingEntry, setRenamingEntry] = useState(false)
  const [deletingEntry, setDeletingEntry] = useState(false)
  const [workspaceMutationPath, setWorkspaceMutationPath] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [editorAppearance, setEditorAppearance] = useState(readEditorAppearance)
  const [editorNavigation, setEditorNavigation] = useState<EditorNavigationRequest | null>(null)
  const [editorSplit, setEditorSplit] = useState(readEditorSplitPreference)
  const [filePresentation, setFilePresentation] = useState<FilePresentation>(() => (
    memoryMatches ? memory.filePresentation ?? 'full' : 'full'
  ))
  const [markdownViewModes, setMarkdownViewModes] = useState<Map<string, MarkdownViewMode>>(() => (
    memoryMatches ? new Map(memory.markdownViewModes ?? []) : new Map()
  ))
  const [splitDragging, setSplitDragging] = useState(false)
  const [explorerDragging, setExplorerDragging] = useState(false)
  const [editorPanelWidth, setEditorPanelWidth] = useState(0)
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const paletteDialogRef = useRef<HTMLDivElement>(null)
  const splitTabStripRef = useRef<HTMLElement>(null)
  const splitContainerRef = useRef<HTMLElement>(null)
  const splitDragRef = useRef<{ pointerId: number; editorPercent: number } | null>(null)
  const splitFrameRef = useRef<number | null>(null)
  const editorPanelRef = useRef<HTMLDivElement>(null)
  const editorGroupRefs = useRef<Record<EditorGroupId, HTMLElement | null>>({
    primary: null,
    secondary: null
  })
  const explorerDragRef = useRef<{ pointerId: number; width: number } | null>(null)
  const explorerFrameRef = useRef<number | null>(null)
  const markdownScrollSyncRef = useRef<Record<EditorGroupId, MarkdownScrollSyncController> | null>(null)
  if (!markdownScrollSyncRef.current) {
    markdownScrollSyncRef.current = {
      primary: createMarkdownScrollSyncController(),
      secondary: createMarkdownScrollSyncController()
    }
  }
  const markdownSourceScrollElementCallbacks = useMemo<Record<EditorGroupId, (element: HTMLElement | null) => void>>(() => ({
    primary: element => markdownScrollSyncRef.current?.primary.setSource(element),
    secondary: element => markdownScrollSyncRef.current?.secondary.setSource(element)
  }), [])
  const markdownPreviewScrollElementCallbacks = useMemo<Record<EditorGroupId, (element: HTMLDivElement | null) => void>>(() => ({
    primary: element => markdownScrollSyncRef.current?.primary.setPreview(element),
    secondary: element => markdownScrollSyncRef.current?.secondary.setPreview(element)
  }), [])
  const paletteReturnFocusRef = useRef<HTMLElement | null>(null)
  const paletteGroupRef = useRef<EditorGroupId | null>(null)
  const paletteFocusWasOpenRef = useRef(false)
  const paletteOpenRef = useRef(false)
  const paletteGenerationRef = useRef(0)
  const paletteCloseReasonRef = useRef<PaletteCloseReason>('cancel')
  const paletteCommittedGroupRef = useRef<EditorGroupId | null>(null)
  const paletteSeedResultsRef = useRef<{ generation: number; entries: WorkspaceEntry[] } | null>(null)
  const paletteNavigationRef = useRef<Pick<OpenWorkspacePathDetail, 'line' | 'column'> | null>(null)
  const initialWorkspaceOpenPendingRef = useRef(Boolean(onReturnToChat))
  const paletteReturnToChatOnCancelRef = useRef(false)
  const mountedRef = useRef(true)
  const requestSequence = useRef(0)
  const openRequestSequence = useRef(0)
  const referenceRequestSequence = useRef(0)
  const editorNavigationSequence = useRef(0)
  const pendingOpenPathsRef = useRef(new Map<string, PendingOpenReservation>())
  const pendingOpenOutcomesRef = useRef(new Map<string, Promise<PendingOpenOutcome>>())
  const artifactReadSequence = useRef(0)
  const artifactReadRequestsRef = useRef(new Map<string, string>())
  const directoryGeneration = useRef(0)
  const directoryLoadsRef = useRef(new Map<string, Promise<void>>())
  const directoriesRef = useRef(directories)
  const revealRequestSequence = useRef(0)
  const workspaceMutationRef = useRef<PendingWorkspaceMutation | null>(null)
  const pendingCreateRef = useRef(pendingCreate)
  const workspaceFileOperationsRef = useRef(new Map<string, PendingWorkspaceFileOperation>())
  const workspaceMetadataSyncsRef = useRef(new Map<string, Set<symbol>>())
  const untitledSequenceRef = useRef(0)
  const creationAuthorityRef = useRef({
    available,
    capabilityVersion,
    archived: Boolean(session.archived)
  })
  const openFilesRef = useRef(openFiles)
  const activePathRef = useRef(activePath)
  const secondaryPathRef = useRef(secondaryPath)
  const activeGroupRef = useRef(activeGroup)
  const filePresentationRef = useRef(filePresentation)
  const filePresentationTouchedRef = useRef(false)
  const markdownViewModesRef = useRef(markdownViewModes)
  const viewStatesRef = useRef<Map<string, CodeMirrorViewState>>(
    memoryMatches ? new Map(memory.viewStates ?? []) : new Map()
  )
  const lastPersistedWorkspaceRef = useRef<PersistedWorkspaceSnapshot | null>(null)
  openFilesRef.current = openFiles
  activePathRef.current = activePath
  secondaryPathRef.current = secondaryPath
  activeGroupRef.current = activeGroup
  paletteOpenRef.current = paletteOpen
  paletteGroupRef.current = paletteGroup
  filePresentationRef.current = filePresentation
  markdownViewModesRef.current = markdownViewModes
  directoriesRef.current = directories
  pendingCreateRef.current = pendingCreate
  creationAuthorityRef.current = {
    available,
    capabilityVersion,
    archived: Boolean(session.archived)
  }

  const focusedPath = activeGroup === 'secondary' && secondaryPath ? secondaryPath : activePath
  const primaryFile = openFiles.find(file => file.path === activePath) ?? null
  const secondaryFile = openFiles.find(file => file.path === secondaryPath) ?? null
  const activeFile = openFiles.find(file => file.path === focusedPath) ?? null
  const paletteRenderGroup: EditorGroupId | null = paletteGroup === 'secondary'
    ? secondaryPath ? 'secondary' : activePath ? 'primary' : null
    : paletteGroup === 'primary' && activePath ? 'primary' : null
  const openPathsKey = openFiles.map(file => file.path).join('\0')
  const openPaths = useMemo(() => new Set(openPathsKey ? openPathsKey.split('\0') : []), [openPathsKey])
  const pendingCloseFile = openFiles.find(file => file.path === pendingClosePath) ?? null
  const pendingReloadFile = openFiles.find(file => file.path === pendingReloadPath) ?? null
  const untitledSaveDirectory = pendingUntitledSave
    ? directories[pendingUntitledSave.directory]
    : null
  const mutationsAvailable = available === true && capabilityVersion >= 2 && !session.archived
  const creationAvailable = available === true && capabilityVersion >= 4 && !session.archived
  const absoluteReadsAvailable = available === true && capabilityVersion >= 5
  const absoluteWritesAvailable = available === true && capabilityVersion >= 6 && !session.archived
  const pendingCloseCanSave = pendingCloseFile
    ? pendingCloseFile.loaded
      && pendingCloseFile.dirty
      && pendingCloseFile.writable
      && !pendingCloseFile.saving
      && !pendingCloseFile.loading
      && !session.archived
      && !(
        pendingCloseFile.origin === 'workspace'
        && workspaceMutationPath
        && workspacePathIsWithin(pendingCloseFile.path, workspaceMutationPath)
      )
    : false
  const palettePathInput = useMemo(
    () => resolveWorkspacePathInput(cwd, paletteQuery),
    [cwd, paletteQuery]
  )
  const palettePaths = palettePathInput.kind === 'workspace-file'
    ? [palettePathInput.path]
    : palettePathInput.kind === 'absolute-file' && absoluteReadsAvailable
      ? [palettePathInput.path]
    : paletteResults.map(file => file.path)
  const paletteResultsId = `${instanceId}-file-picker-results`
  const activePaletteOptionId = palettePaths[paletteIndex]
    ? `${instanceId}-file-picker-option-${paletteIndex}`
    : undefined
  const workspaceLabel = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || t('editor.workspace')
  const capabilityMessage = unavailableMessage || (
    available === null
      ? t('editor.workspaceFilesWillBeAvailableAfterAgentsserverFinishesConnecting')
      : t('editor.updateAgentsserverToEnableWorkspaceFileBrowsingAndEditing')
  )

  const advancePaletteGeneration = (): number => {
    requestSequence.current += 1
    referenceRequestSequence.current += 1
    paletteGenerationRef.current += 1
    return paletteGenerationRef.current
  }

  const paletteLeaseIsCurrent = (lease: PaletteOpenLease | undefined): boolean => (
    !lease || (
      paletteOpenRef.current
      && lease.generation === paletteGenerationRef.current
      && (
        lease.targetGroup !== 'secondary'
        || secondaryPathRef.current !== null
      )
    )
  )

  const pendingOpenCount = (paletteLease?: PaletteOpenLease): number => {
    let count = 0
    const livePaletteGeneration = paletteLease?.generation ?? (
      paletteOpenRef.current ? paletteGenerationRef.current : null
    )
    for (const reservation of pendingOpenPathsRef.current.values()) {
      if (reservation.paletteGeneration === null) count += 1
      else if (reservation.paletteGeneration === livePaletteGeneration) count += 1
    }
    return count
  }

  const reservePendingOpen = (path: string, paletteLease?: PaletteOpenLease): symbol => {
    const token = Symbol(path)
    pendingOpenPathsRef.current.set(path, {
      token,
      paletteGeneration: paletteLease?.generation ?? null
    })
    return token
  }

  const releasePendingOpen = (path: string, token: symbol): void => {
    if (pendingOpenPathsRef.current.get(path)?.token === token) {
      pendingOpenPathsRef.current.delete(path)
    }
  }

  const cancelPalette = (): void => {
    if (!paletteOpenRef.current) return
    advancePaletteGeneration()
    paletteCloseReasonRef.current = 'cancel'
    paletteCommittedGroupRef.current = null
    paletteSeedResultsRef.current = null
    paletteOpenRef.current = false
    paletteNavigationRef.current = null
    setOpeningPath(null)
    setPaletteOpen(false)
    setPaletteQuery('')
  }

  const commitPaletteSelection = (lease: PaletteOpenLease): boolean => {
    if (!paletteLeaseIsCurrent(lease)) return false
    paletteCloseReasonRef.current = 'commit'
    paletteCommittedGroupRef.current = lease.targetGroup
    paletteSeedResultsRef.current = null
    paletteReturnToChatOnCancelRef.current = false
    paletteOpenRef.current = false
    paletteNavigationRef.current = null
    setPaletteOpen(false)
    setPaletteQuery('')
    return true
  }

  useTransientClose(paletteOpen, cancelPalette)
  useTransientClose(Boolean(pendingUntitledSave), () => {
    if (!pendingUntitledSave?.saving) setPendingUntitledSave(null)
  })
  useTransientClose(Boolean(pendingCloseFile), () => setPendingClosePath(null))
  useTransientClose(Boolean(pendingReloadFile), () => setPendingReloadPath(null))
  useTransientClose(Boolean(pendingRenameEntry), () => {
    if (!renamingEntry) setPendingRenameEntry(null)
  })
  useTransientClose(Boolean(pendingDeleteEntry), () => {
    if (!deletingEntry) setPendingDeleteEntry(null)
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (splitFrameRef.current !== null) {
        window.cancelAnimationFrame(splitFrameRef.current)
        splitFrameRef.current = null
      }
      if (explorerFrameRef.current !== null) {
        window.cancelAnimationFrame(explorerFrameRef.current)
        explorerFrameRef.current = null
      }
      markdownScrollSyncRef.current?.primary.destroy()
      markdownScrollSyncRef.current?.secondary.destroy()
      for (const requestId of artifactReadRequestsRef.current.values()) {
        void window.agentsDock.files.cancelReadText(session.id, requestId)
      }
      artifactReadRequestsRef.current.clear()
      directoryLoadsRef.current.clear()
      workspaceFileOperationsRef.current.clear()
      workspaceMetadataSyncsRef.current.clear()
    }
  }, [])

  useEffect(() => {
    writeEditorSplitPreference(editorSplit)
  }, [editorSplit])

  useLayoutEffect(() => {
    const panel = editorPanelRef.current
    if (!panel || activePath === null) return
    const updateWidth = () => {
      const width = Math.max(0, Math.round(panel.getBoundingClientRect().width))
      setEditorPanelWidth(current => current === width ? current : width)
    }
    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth)
      return () => window.removeEventListener('resize', updateWidth)
    }
    const observer = new ResizeObserver(updateWidth)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [activePath, filePresentation])

  useEffect(() => {
    referenceRequestSequence.current += 1
    openRequestSequence.current += 1
  }, [activePath])

  useEffect(() => {
    if (memoryMatches) return
    let cancelled = false
    if (!profileScope) return
    void getWorkspacePreference<PersistedWorkspaceState | LegacyPersistedWorkspaceState | null>(profileScope, preferenceKey, null)
      .then(stored => {
        if (cancelled || !stored || ![1, 2, 3, 4, 5].includes(stored.version) || stored.cwd !== cwd) return
        const persisted = normalizePersistedWorkspaceState(stored)
        lastPersistedWorkspaceRef.current = {
          target: workspacePersistenceTarget(profileScope, preferenceKey),
          state: persisted
        }
        for (const tab of persisted.tabs) {
          const primaryKey = editorViewStateKey('primary', tab.path)
          const secondaryKey = editorViewStateKey('secondary', tab.path)
          if (tab.viewState && !viewStatesRef.current.has(primaryKey)) {
            viewStatesRef.current.set(primaryKey, tab.viewState)
          }
          if (tab.secondaryViewState && !viewStatesRef.current.has(secondaryKey)) {
            viewStatesRef.current.set(secondaryKey, tab.secondaryViewState)
          }
        }
        setMarkdownViewModes(current => {
          const next = new Map(current)
          for (const tab of persisted.tabs) {
            if (isMarkdownViewMode(tab.markdownViewMode)) next.set(tab.path, tab.markdownViewMode)
          }
          markdownViewModesRef.current = next
          return next
        })
        const restoredTabs = persisted.tabs.filter(tab => (
          !tab.artifact || agentFileBelongsToSession(tab.artifact, session.id)
        ))
        const restoredFiles = restoredTabs.slice(0, MAX_OPEN_TABS).map(tab => (
          tab.artifact
            ? restoredArtifactFile(tab.artifact)
            : tab.external
              ? restoredExternalFile(tab)
            : tab.untitled
              ? restoredUntitledFile(cwd, tab)
              : restoredWorkspaceFile(cwd, tab)
        ))
        setOpenFiles(current => mergeOpenWorkspaceFiles(restoredFiles, current))
        setActivePath(current => current ?? (
          persisted.activePath && restoredFiles.some(file => file.path === persisted.activePath)
            ? persisted.activePath
            : null
        ))
        setSecondaryPath(current => current ?? (
          persisted.secondaryPath && restoredFiles.some(file => file.path === persisted.secondaryPath)
            ? persisted.secondaryPath
            : null
        ))
        setActiveGroup(current => current === 'secondary' || persisted.activeGroup !== 'secondary'
          ? current
          : persisted.secondaryPath ? 'secondary' : 'primary')
        if (!filePresentationTouchedRef.current) {
          filePresentationRef.current = persisted.filePresentation
          setFilePresentation(persisted.filePresentation)
        }
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setRestored(true) })
    return () => { cancelled = true }
  }, [cwd, memoryMatches, preferenceKey, profileScope, session.id])

  const persistWorkspace = useCallback(() => {
    const currentFiles = openFilesRef.current
    const currentActivePath = activePathRef.current
    const currentSecondaryPath = secondaryPathRef.current
    const currentActiveGroup = activeGroupRef.current
    workspaceMemory.delete(workspaceKey)
    const memoryFiles = currentFiles
    const memoryPaths = new Set(memoryFiles.map(file => file.path))
    const currentMarkdownViewModes = new Map(
      [...markdownViewModesRef.current].filter(([path]) => memoryPaths.has(path))
    )
    const memoryViewStates = new Map<string, CodeMirrorViewState>()
    for (const file of memoryFiles) {
      for (const group of ['primary', 'secondary'] as const) {
        const key = editorViewStateKey(group, file.path)
        const state = viewStatesRef.current.get(key)
        if (state) memoryViewStates.set(key, state)
      }
    }
    workspaceMemory.set(workspaceKey, {
      sessionId: session.id,
      cwd,
      activePath: currentActivePath && memoryPaths.has(currentActivePath) ? currentActivePath : null,
      secondaryPath: currentSecondaryPath && memoryPaths.has(currentSecondaryPath) ? currentSecondaryPath : null,
      activeGroup: currentActiveGroup === 'secondary'
        && currentSecondaryPath
        && memoryPaths.has(currentSecondaryPath)
        ? 'secondary'
        : 'primary',
      filePresentation: filePresentationRef.current,
      openFiles: compactWorkspaceFiles(memoryFiles, currentActivePath, currentSecondaryPath),
      viewStates: memoryViewStates,
      markdownViewModes: currentMarkdownViewModes
    })
    trimWorkspaceMemory()
    if (!profileScope) return Promise.resolve()
    const persisted = persistedWorkspaceState(
      cwd,
      currentActivePath,
      currentSecondaryPath,
      currentActiveGroup,
      filePresentationRef.current,
      currentFiles,
      viewStatesRef.current,
      currentMarkdownViewModes
    )
    const snapshot: PersistedWorkspaceSnapshot = {
      target: workspacePersistenceTarget(profileScope, preferenceKey),
      state: persisted
    }
    const previous = lastPersistedWorkspaceRef.current
    if (
      previous?.target === snapshot.target
      && equalPersistedWorkspaceState(previous.state, snapshot.state)
    ) return Promise.resolve()
    lastPersistedWorkspaceRef.current = snapshot
    return setWorkspacePreference(profileScope, preferenceKey, persisted).catch(error => {
      if (lastPersistedWorkspaceRef.current === snapshot) lastPersistedWorkspaceRef.current = null
      throw error
    })
  }, [cwd, preferenceKey, profileScope, session.id, workspaceKey])

  useEffect(() => {
    if (!restored || !profileScope) return
    let cancelIdle: (() => void) | null = null
    const timer = window.setTimeout(() => {
      cancelIdle = scheduleWhenIdle(() => { void persistWorkspace().catch(() => undefined) })
    }, DRAFT_PERSIST_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      cancelIdle?.()
    }
  }, [activeGroup, activePath, filePresentation, markdownViewModes, openFiles, persistWorkspace, profileScope, restored, secondaryPath])

  useEffect(() => () => {
    if (restored) void persistWorkspace().catch(() => undefined)
  }, [persistWorkspace, restored])

  useEffect(() => {
    const flush = (event: Event) => {
      if (!restored) return
      const persistence = Promise.resolve().then(persistWorkspace)
      const detail = (event as CustomEvent<DraftFlushEventDetail>).detail
      if (Array.isArray(detail?.promises)) detail.promises.push(persistence)
      else detail?.waitUntil?.(persistence)
    }
    window.addEventListener('agentsdock:flush-draft', flush)
    return () => window.removeEventListener('agentsdock:flush-draft', flush)
  }, [persistWorkspace, restored])

  const currentEditorGroup = (): EditorGroupId | null => (
    activeGroupRef.current === 'secondary' && secondaryPathRef.current
      ? 'secondary'
      : activePathRef.current ? 'primary' : null
  )

  const currentFocusedPath = (): string | null => (
    currentEditorGroup() === 'secondary'
      ? secondaryPathRef.current
      : activePathRef.current
  )

  const fileWorkspaceOwnsFocus = (): boolean => {
    const focusedElement = document.activeElement
    if (!(focusedElement instanceof Element)) return false
    if (
      paletteOpenRef.current
      && paletteDialogRef.current?.contains(focusedElement)
    ) return true
    if (!activePathRef.current) return false
    if (editorPanelRef.current?.contains(focusedElement)) return true
    return Boolean(
      splitTabStripRef.current?.contains(focusedElement)
      && focusedElement.closest('.workspace-editor-file-tabs')
    )
  }

  const workspaceSurfaceOwnsFocus = (): boolean => {
    const focusedElement = document.activeElement
    if (!(focusedElement instanceof Element)) return false
    if (
      paletteOpenRef.current
      && paletteDialogRef.current?.contains(focusedElement)
    ) return true
    if (
      splitContainerRef.current?.contains(focusedElement)
      || splitTabStripRef.current?.contains(focusedElement)
    ) return true
    return (
      (focusedElement === document.body || focusedElement === document.documentElement)
      && document.querySelectorAll('.workspace-editor-content').length === 1
    )
  }

  const requestOpenPalette = (returnToChatOnCancel = false) => {
    if (available !== true) {
      setWorkspaceError(capabilityMessage)
      return
    }
    paletteReturnToChatOnCancelRef.current = returnToChatOnCancel
    setWorkspaceError(null)
    setPaletteError(null)
    setPaletteQuery('')
    setPaletteIndex(0)
    advancePaletteGeneration()
    paletteOpenRef.current = true
    paletteCloseReasonRef.current = 'cancel'
    paletteCommittedGroupRef.current = null
    paletteSeedResultsRef.current = null
    paletteNavigationRef.current = null
    paletteReturnFocusRef.current = onReturnToChat
      ? null
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    const ownerGroup = currentEditorGroup()
    paletteGroupRef.current = ownerGroup
    setPaletteGroup(ownerGroup)
    setPaletteOpen(true)
  }

  const activateFilePath = (path: string, group: EditorGroupId = activeGroupRef.current): void => {
    if (group === 'secondary') {
      secondaryPathRef.current = path
      setSecondaryPath(path)
      activeGroupRef.current = 'secondary'
      setActiveGroup('secondary')
      return
    }
    activePathRef.current = path
    setActivePath(path)
    activeGroupRef.current = 'primary'
    setActiveGroup('primary')
  }

  const showChat = (): void => {
    if (paletteOpenRef.current) cancelPalette()
    activePathRef.current = null
    setActivePath(null)
    activeGroupRef.current = 'primary'
    setActiveGroup('primary')
    setPendingClosePath(null)
    onReturnToChat?.()
  }

  useEffect(() => {
    const open = (event: Event) => {
      const targetSessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
      if (targetSessionId && targetSessionId !== session.id) return
      if (paletteOpenRef.current) {
        cancelPalette()
        return
      }
      if (document.querySelector('[aria-modal="true"]')) return
      const initial = initialWorkspaceOpenPendingRef.current
      initialWorkspaceOpenPendingRef.current = false
      requestOpenPalette(initial)
    }
    window.addEventListener('agentsdock:open-workspace-file', open)
    return () => window.removeEventListener('agentsdock:open-workspace-file', open)
  }, [available, capabilityMessage])

  useEffect(() => {
    const quickOpen = (event: Event) => {
      if (event.defaultPrevented) return
      const detail = (event as CustomEvent<{
        source?: 'contextual' | 'workspace-file'
        sessionId?: string | null
      }>).detail
      const ownsRequest = detail?.source === 'workspace-file'
        ? detail.sessionId
          ? detail.sessionId === session.id
          : workspaceSurfaceOwnsFocus()
        : fileWorkspaceOwnsFocus()
      if (!ownsRequest) return
      event.preventDefault()
      if (paletteOpenRef.current) {
        cancelPalette()
        return
      }
      // The native menu command is routed through this event as well as the
      // direct key handler. Claim it for the selected workspace, but never
      // stack quick open on top of an unsaved/reload/rename/delete dialog.
      if (document.querySelector('[aria-modal="true"]')) return
      requestOpenPalette()
    }
    window.addEventListener('agentsdock:quick-open-active-surface', quickOpen)
    return () => window.removeEventListener('agentsdock:quick-open-active-surface', quickOpen)
  }, [available, capabilityMessage, paletteOpen])

  useEffect(() => {
    const dismissFilePicker = () => {
      if (paletteOpenRef.current) cancelPalette()
    }
    window.addEventListener('agentsdock:dismiss-workspace-file-picker', dismissFilePicker)
    return () => window.removeEventListener('agentsdock:dismiss-workspace-file-picker', dismissFilePicker)
  }, [])

  useEffect(() => {
    const navigateWorkspaceTab = (direction: -1 | 1): boolean => {
      if (paletteOpen || pendingClosePath || pendingReloadPath || document.querySelector('[aria-modal="true"]')) return false
      const target = workspaceTabNavigationTarget(
        currentFocusedPath(),
        openFilesRef.current.map(file => file.path),
        { kind: 'cycle', direction }
      )
      if (target === undefined) return false
      referenceRequestSequence.current += 1
      openRequestSequence.current += 1
      if (target === null) showChat()
      else activateFilePath(target)
      return true
    }
    const handleShortcut = (event: KeyboardEvent) => {
      const navigation = workspaceTabNavigationShortcut(event)
      if (navigation) {
        const handled = navigation.kind === 'cycle'
          ? navigateWorkspaceTab(navigation.direction)
          : (() => {
              if (paletteOpen || pendingClosePath || pendingReloadPath || document.querySelector('[aria-modal="true"]')) return false
              const target = workspaceTabNavigationTarget(
                currentFocusedPath(),
                openFilesRef.current.map(file => file.path),
                navigation
              )
              if (target === undefined) return false
              referenceRequestSequence.current += 1
              openRequestSequence.current += 1
              if (target === null) showChat()
              else activateFilePath(target)
              return true
            })()
        if (!handled) return
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLocaleLowerCase()
      if (key === 'o' && !event.shiftKey && paletteOpenRef.current && fileWorkspaceOwnsFocus()) {
        event.preventDefault()
        event.stopPropagation()
        cancelPalette()
        return
      }
      if (document.querySelector('[aria-modal="true"]')) return
      if (key === 'o' && !event.shiftKey) {
        if (!workspaceSurfaceOwnsFocus()) return
        event.preventDefault()
        event.stopImmediatePropagation()
        requestOpenPalette()
        return
      }
      if (key === 's' && focusedPath) {
        event.preventDefault()
        event.stopPropagation()
        void saveFile(focusedPath)
      }
    }
    const handleNavigationCommand = (event: Event) => {
      const direction = (event as CustomEvent<{ direction?: -1 | 1 }>).detail?.direction
      if (direction === -1 || direction === 1) navigateWorkspaceTab(direction)
    }
    window.addEventListener('keydown', handleShortcut, true)
    window.addEventListener('agentsdock:navigate-workspace-tab', handleNavigationCommand)
    return () => {
      window.removeEventListener('keydown', handleShortcut, true)
      window.removeEventListener('agentsdock:navigate-workspace-tab', handleNavigationCommand)
    }
  }, [available, capabilityMessage, focusedPath, paletteOpen, pendingClosePath, pendingReloadPath, pendingUntitledSave])

  useEffect(() => {
    const closeActive = (event: Event) => {
      if (event.defaultPrevented) return
      if (paletteOpenRef.current && fileWorkspaceOwnsFocus()) {
        event.preventDefault()
        cancelPalette()
        return
      }
      const path = currentFocusedPath()
      if (!path) {
        const dirtyFile = openFilesRef.current.find(file => file.dirty)
        if (!dirtyFile) return
        event.preventDefault()
        referenceRequestSequence.current += 1
        openRequestSequence.current += 1
        activateFilePath(dirtyFile.path, 'primary')
        setPendingClosePath(dirtyFile.path)
        return
      }
      event.preventDefault()
      closeFile(path)
    }
    window.addEventListener('agentsdock:workspace-close-active', closeActive)
    return () => window.removeEventListener('agentsdock:workspace-close-active', closeActive)
  }, [])

  useEffect(() => {
    const wasOpen = paletteFocusWasOpenRef.current
    paletteFocusWasOpenRef.current = paletteOpen
    if (paletteOpen) {
      paletteInputRef.current?.focus()
      return
    }
    if (!wasOpen) return
    paletteNavigationRef.current = null
    const returnTarget = paletteReturnFocusRef.current
    const closeReason = paletteCloseReasonRef.current
    const ownerGroup = closeReason === 'commit'
      ? paletteCommittedGroupRef.current
      : paletteGroupRef.current
    const focusGeneration = paletteGenerationRef.current
    paletteReturnFocusRef.current = null
    if (paletteReturnToChatOnCancelRef.current) return
    let focusFrame: number | null = null
    let cancelled = false
    const currentGroup = (): EditorGroupId | null => (
      ownerGroup === 'secondary' && secondaryPathRef.current
        ? 'secondary'
        : activePathRef.current ? 'primary' : null
    )
    const focusIsNeutral = (): boolean => {
      const focused = document.activeElement
      return (
        focused === null
        || focused === document.body
        || focused === document.documentElement
        || !focused.isConnected
        || (closeReason === 'cancel' && focused === returnTarget)
      )
    }
    const restoreFocus = (attempt: number) => {
      if (
        cancelled
        || focusGeneration !== paletteGenerationRef.current
        || !focusIsNeutral()
      ) return
      if (
        closeReason === 'cancel'
        &&
        returnTarget?.isConnected
        && returnTarget !== document.body
        && returnTarget !== document.documentElement
      ) {
        returnTarget.focus({ preventScroll: true })
        if (document.activeElement === returnTarget) return
      }
      const resolvedGroup = currentGroup()
      const group = resolvedGroup ? editorGroupRefs.current[resolvedGroup] : null
      const editor = group?.querySelector<HTMLElement>('[role="textbox"], textarea, [contenteditable="true"]')
      if (editor) {
        editor.focus({ preventScroll: true })
        return
      }
      group?.focus({ preventScroll: true })
      if (document.activeElement === group) return
      if (attempt < 3) focusFrame = window.requestAnimationFrame(() => restoreFocus(attempt + 1))
    }
    focusFrame = window.requestAnimationFrame(() => restoreFocus(0))
    return () => {
      cancelled = true
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame)
    }
  }, [paletteOpen])

  useLayoutEffect(() => {
    if (!paletteOpenRef.current) return
    if (
      (paletteGroup !== null && !activePath)
      || (paletteGroup === 'secondary' && !secondaryPath)
    ) cancelPalette()
  }, [activePath, paletteGroup, paletteOpen, secondaryPath])

  const paletteWasOpenRef = useRef(false)
  useEffect(() => {
    const wasOpen = paletteWasOpenRef.current
    paletteWasOpenRef.current = paletteOpen
    if (!wasOpen || paletteOpen) return
    const returnToChat = paletteReturnToChatOnCancelRef.current
    paletteReturnToChatOnCancelRef.current = false
    if (returnToChat) onReturnToChat?.()
  }, [onReturnToChat, paletteOpen])

  useEffect(() => {
    if (!paletteOpen || !available) return
    const sequence = ++requestSequence.current
    setPaletteError(null)
    if (palettePathInput.kind !== 'search') {
      setPaletteResults([])
      setPaletteLoading(false)
      setPaletteTruncated(false)
      setPaletteIndex(0)
      return
    }
    const collectPaletteEntries = (remoteEntries: WorkspaceEntry[] = []): WorkspaceEntry[] => {
      const knownEntries: WorkspaceEntry[] = []
      const normalizedQuery = paletteQuery.trim().toLocaleLowerCase()
      let inspectedEntries = 0
      for (const directory of Object.values(directoriesRef.current)) {
        for (const entry of directory.entries) {
          inspectedEntries += 1
          const searchable = `${entry.name}\n${entry.path}`.toLocaleLowerCase()
          if (
            entry.kind === 'file'
            && (!normalizedQuery || searchable.includes(normalizedQuery))
          ) knownEntries.push(entry)
          if (knownEntries.length >= 100 || inspectedEntries >= 5_000) break
        }
        if (knownEntries.length >= 100 || inspectedEntries >= 5_000) break
      }
      const seededEntries = paletteSeedResultsRef.current?.generation === paletteGenerationRef.current
        ? paletteSeedResultsRef.current.entries
        : []
      return mergeWorkspacePaletteEntries(
        openFilesRef.current.map(file => ({
          name: file.name || fileName(file.path),
          path: file.path,
          kind: 'file' as const,
          revision: file.revision,
          size: file.size,
          mtime_ns: file.mtime_ns,
          writable: file.writable
        })),
        knownEntries,
        [...seededEntries, ...remoteEntries],
        paletteQuery,
        currentFocusedPath(),
        100
      )
    }
    const localEntries = collectPaletteEntries()
    setPaletteResults(localEntries)
    setPaletteIndex(current => Math.min(current, Math.max(0, localEntries.length - 1)))
    setPaletteLoading(true)
    const timer = window.setTimeout(() => {
      const startedAt = performance.now()
      void window.agentsDock.workspace.search(session.id, paletteQuery.trim(), 100)
        .then(page => {
          if (!mountedRef.current || sequence !== requestSequence.current) return
          const mergedEntries = collectPaletteEntries(page.entries)
          setPaletteResults(mergedEntries)
          setPaletteTruncated(page.truncated)
          setPaletteIndex(current => Math.min(current, Math.max(0, mergedEntries.length - 1)))
          setPaletteLoading(false)
          logWorkspaceFile('search completed', {
            sessionId: session.id,
            query: paletteQuery.trim(),
            results: mergedEntries.length,
            remoteResults: page.entries.length,
            scanned: page.scanned,
            truncated: page.truncated,
            durationMs: Math.round(performance.now() - startedAt)
          })
        })
        .catch(error => {
          if (!mountedRef.current || sequence !== requestSequence.current) return
          const fallbackEntries = collectPaletteEntries()
          setPaletteResults(fallbackEntries)
          setPaletteLoading(false)
          setPaletteTruncated(false)
          setPaletteError(fallbackEntries.length
            ? t('editor.showingOpenAndLoadedFilesOnlyBecauseWorkspaceSearchIsUnavailable')
            : errorMessage(error))
        })
    }, paletteQuery ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [available, directories, openPathsKey, paletteOpen, palettePathInput, paletteQuery, session.id])

  useEffect(() => {
    if (activePath) void ensureFileLoaded(activePath)
    if (secondaryPath && secondaryPath !== activePath) void ensureFileLoaded(secondaryPath)
  }, [activePath, secondaryPath, session.id])

  useEffect(() => {
    if (!absoluteWritesAvailable) {
      setOpenFiles(current => current.map(file => (
        file.origin === 'external' && file.writable
          ? { ...file, writable: false }
          : file
      )))
    }
    if (!absoluteReadsAvailable) return
    for (const file of openFilesRef.current) {
      if (file.origin === 'external') void ensureFileLoaded(file.path, true)
    }
  }, [absoluteReadsAvailable, absoluteWritesAvailable, session.id])

  useEffect(() => {
    if (!activeFile?.loaded) return
    logWorkspaceFile('editor render requested', {
      sessionId: session.id,
      path: activeFile.path,
      size: activeFile.size,
      writable: activeFile.writable
    })
  }, [activeFile?.loaded, activeFile?.path, activeFile?.size, activeFile?.writable, session.id])

  function beginArtifactRead(path: string, file: AgentFile): { requestId: string; promise: Promise<AgentTextFile> } {
    const previous = artifactReadRequestsRef.current.get(path)
    if (previous) void window.agentsDock.files.cancelReadText(session.id, previous)
    const requestId = `artifact:${Date.now()}:${++artifactReadSequence.current}`
    artifactReadRequestsRef.current.set(path, requestId)
    return {
      requestId,
      promise: window.agentsDock.files.readText(session.id, file, requestId)
    }
  }

  function isCurrentArtifactRead(path: string, requestId: string): boolean {
    return artifactReadRequestsRef.current.get(path) === requestId
  }

  function finishArtifactRead(path: string, requestId: string): boolean {
    if (!isCurrentArtifactRead(path, requestId)) return false
    artifactReadRequestsRef.current.delete(path)
    return true
  }

  function cancelArtifactRead(path: string): void {
    const requestId = artifactReadRequestsRef.current.get(path)
    if (!requestId) return
    artifactReadRequestsRef.current.delete(path)
    void window.agentsDock.files.cancelReadText(session.id, requestId)
  }

  function workspaceMutationBlocks(path: string): boolean {
    const mutation = workspaceMutationRef.current
    return Boolean(mutation && workspacePathIsWithin(path, mutation.path))
  }

  function reportWorkspaceMutationBlock(): void {
    const mutation = workspaceMutationRef.current
    if (!mutation) return
    setWorkspaceError(t('editor.waitForOperation', { operation: t(`editor.operation.${mutation.kind}`) }))
  }

  function beginWorkspaceFileOperation(
    path: string,
    kind: PendingWorkspaceFileOperation['kind']
  ): PendingWorkspaceFileOperation | null {
    if (workspaceMutationBlocks(path) || workspaceFileOperationsRef.current.has(path)) return null
    const operation = { kind, token: Symbol(`${kind}:${path}`) }
    workspaceFileOperationsRef.current.set(path, operation)
    return operation
  }

  function finishWorkspaceFileOperation(path: string, operation: PendingWorkspaceFileOperation): void {
    if (workspaceFileOperationsRef.current.get(path)?.token === operation.token) {
      workspaceFileOperationsRef.current.delete(path)
    }
  }

  function isCurrentWorkspaceFileOperation(
    path: string,
    operation: PendingWorkspaceFileOperation
  ): boolean {
    return workspaceFileOperationsRef.current.get(path)?.token === operation.token
  }

  function cancelWorkspaceFileRead(path: string): void {
    const operation = workspaceFileOperationsRef.current.get(path)
    if (operation?.kind === 'read' || operation?.kind === 'reload') {
      workspaceFileOperationsRef.current.delete(path)
    }
  }

  function beginWorkspaceMetadataSync(path: string): symbol {
    const token = Symbol(`metadata:${path}`)
    const current = workspaceMetadataSyncsRef.current.get(path)
    if (current) current.add(token)
    else workspaceMetadataSyncsRef.current.set(path, new Set([token]))
    return token
  }

  function finishWorkspaceMetadataSync(path: string, token: symbol): void {
    const current = workspaceMetadataSyncsRef.current.get(path)
    if (!current) return
    current.delete(token)
    if (!current.size) workspaceMetadataSyncsRef.current.delete(path)
  }

  function workspaceEntryHasPendingFileOperation(path: string): boolean {
    return (
      [...workspaceFileOperationsRef.current.keys()].some(operationPath => (
        workspacePathIsWithin(operationPath, path)
      ))
      || [...workspaceMetadataSyncsRef.current.keys()].some(operationPath => (
        workspacePathIsWithin(operationPath, path)
      ))
    )
  }

  async function ensureFileLoaded(path: string, refreshExternal = false): Promise<void> {
    const existing = openFilesRef.current.find(file => file.path === path)
    const refreshingLoadedExternal = refreshExternal && existing?.origin === 'external'
    if (!existing || existing.loading || existing.loaded && !refreshingLoadedExternal) return
    if (existing.viewerKind === 'image' || existing.viewerKind === 'pdf') return
    if (existing.origin === 'external' && !absoluteReadsAvailable) return
    if (existing.origin === 'workspace' && workspaceMutationBlocks(path)) {
      reportWorkspaceMutationBlock()
      return
    }
    const directFile = existing.origin === 'workspace' || existing.origin === 'external'
    const workspaceOperation = directFile
      ? beginWorkspaceFileOperation(path, 'read')
      : null
    if (directFile && !workspaceOperation) return
    setOpenFiles(current => current.map(file => file.path === path ? { ...file, loading: true, error: null } : file))
    const startedAt = performance.now()
    logWorkspaceFile('restored tab read requested', { sessionId: session.id, path })
    let artifactRequestId: string | null = null
    try {
      if (existing.origin === 'artifact' && existing.artifact) {
        const read = beginArtifactRead(path, existing.artifact)
        artifactRequestId = read.requestId
        const snapshot = await read.promise
        if (!mountedRef.current || !isCurrentArtifactRead(path, read.requestId)) return
        setOpenFiles(current => current.map(file => file.path === path
          ? openArtifactTextFile(existing.artifact as AgentFile, snapshot)
          : file))
        return
      }
      const disk = existing.origin === 'external'
        ? await window.agentsDock.workspace.readAbsolute(session.id, path)
        : await window.agentsDock.workspace.read(session.id, path)
      logWorkspaceFile('restored tab read completed', {
        sessionId: session.id,
        path,
        durationMs: Math.round(performance.now() - startedAt),
        size: disk.size,
        writable: disk.writable
      })
      if (!mountedRef.current || !workspaceOperation || !isCurrentWorkspaceFileOperation(path, workspaceOperation)) return
      setOpenFiles(current => current.map(file => {
        if (file.path !== path) return file
        if (!file.dirty) return existing.origin === 'external'
          ? openExternalFile(disk, absoluteWritesAvailable)
          : openWorkspaceFile(disk)
        const conflicted = Boolean(file.revision && file.revision !== disk.revision)
        return {
          ...file,
          ...disk,
          writable: existing.origin === 'external'
            ? absoluteWritesAvailable && disk.writable === true
            : disk.writable,
          draft: file.draft,
          saved: disk.content,
          dirty: true,
          loading: false,
          loaded: true,
          conflicted,
          revision: disk.revision,
          lines: countLines(file.draft),
          error: conflicted
            ? t('editor.thisFileChangedOnDiskWhileAgentsdockWasClosedRevertTheLocalDraftOrReloadFromDiskBeforeSavi')
            : null
        }
      }))
    } catch (error) {
      const message = errorMessage(error)
      logWorkspaceFile('restored tab read failed', {
        sessionId: session.id,
        path,
        durationMs: Math.round(performance.now() - startedAt),
        error: message
      })
      if (
        mountedRef.current
        && (
          artifactRequestId
            ? isCurrentArtifactRead(path, artifactRequestId)
            : Boolean(workspaceOperation && isCurrentWorkspaceFileOperation(path, workspaceOperation))
        )
        && openFilesRef.current.some(file => file.path === path)
      ) {
        setOpenFiles(current => current.map(file => file.path === path
          ? { ...file, loading: false, error: message }
          : file))
      }
    } finally {
      if (artifactRequestId) finishArtifactRead(path, artifactRequestId)
      if (workspaceOperation) finishWorkspaceFileOperation(path, workspaceOperation)
    }
  }

  const loadDirectory = (
    path: string,
    append = false,
    requestedGeneration = directoryGeneration.current
  ): Promise<void> => {
    const current = directoriesRef.current[path]
    const offset = append ? current?.entries.length ?? 0 : 0
    const loadKey = `${requestedGeneration}\0${path}\0${offset}`
    const pending = directoryLoadsRef.current.get(loadKey)
    if (pending) return pending
    const markLoading = (state: Record<string, DirectoryState>) => ({
      ...state,
      [path]: {
        entries: append ? state[path]?.entries ?? [] : [],
        total: append ? state[path]?.total ?? 0 : 0,
        loading: true,
        error: null
      }
    })
    directoriesRef.current = markLoading(directoriesRef.current)
    setDirectories(markLoading)
    const request = (async () => {
      try {
        const page = await window.agentsDock.workspace.entries(
          session.id,
          path,
          offset,
          WORKSPACE_DIRECTORY_PAGE_SIZE
        )
        if (!mountedRef.current || requestedGeneration !== directoryGeneration.current) return
        setWorkspaceRoot(page.root)
        const applyPage = (state: Record<string, DirectoryState>) => ({
          ...state,
          [path]: {
            entries: append ? mergeWorkspaceEntries(state[path]?.entries ?? [], page.entries) : page.entries,
            total: page.total,
            loading: false,
            error: null
          }
        })
        directoriesRef.current = applyPage(directoriesRef.current)
        setDirectories(applyPage)
      } catch (error) {
        if (!mountedRef.current || requestedGeneration !== directoryGeneration.current) return
        const applyError = (state: Record<string, DirectoryState>) => ({
          ...state,
          [path]: {
            entries: state[path]?.entries ?? [],
            total: state[path]?.total ?? 0,
            loading: false,
            error: errorMessage(error)
          }
        })
        directoriesRef.current = applyError(directoriesRef.current)
        setDirectories(applyError)
      }
    })()
    directoryLoadsRef.current.set(loadKey, request)
    void request.finally(() => {
      if (directoryLoadsRef.current.get(loadKey) === request) directoryLoadsRef.current.delete(loadKey)
    })
    return request
  }

  const revealWorkspaceFile = async (
    path: string,
    requestedGeneration = directoryGeneration.current
  ): Promise<void> => {
    const request = ++revealRequestSequence.current
    const parents = workspaceParentDirectories(path)
    const steps = workspaceRevealSteps(path)
    let directoryLoadsRemaining = MAX_AUTO_REVEAL_DIRECTORY_LOADS
    setExpandedDirectories(current => {
      const next = new Set(current)
      for (const parent of parents) next.add(parent)
      return equalStringSets(current, next) ? current : next
    })
    for (const { directory, child } of steps.slice(0, MAX_AUTO_REVEAL_STEPS)) {
      if (request !== revealRequestSequence.current || requestedGeneration !== directoryGeneration.current) return
      let state = directoriesRef.current[directory]
      if (state?.loading) {
        const pending = [...directoryLoadsRef.current.entries()].find(([key]) => (
          key.startsWith(`${requestedGeneration}\0${directory}\0`)
        ))?.[1]
        if (pending) await pending
        if (request !== revealRequestSequence.current || requestedGeneration !== directoryGeneration.current) return
        state = directoriesRef.current[directory]
      }
      if (!state || state.error) {
        if (directoryLoadsRemaining <= 0) {
          logWorkspaceFile('tree reveal request budget reached', {
            sessionId: session.id,
            path,
            directory,
            limit: MAX_AUTO_REVEAL_DIRECTORY_LOADS
          })
          break
        }
        directoryLoadsRemaining -= 1
        await loadDirectory(directory, false, requestedGeneration)
        state = directoriesRef.current[directory]
      }
      let extraPages = 0
      while (
        state
        && !state.error
        && !state.entries.some(entry => entry.path === child)
        && state.entries.length < state.total
        && extraPages < MAX_AUTO_REVEAL_EXTRA_PAGES
        && directoryLoadsRemaining > 0
      ) {
        directoryLoadsRemaining -= 1
        await loadDirectory(directory, true, requestedGeneration)
        extraPages += 1
        if (request !== revealRequestSequence.current || requestedGeneration !== directoryGeneration.current) return
        const nextState = directoriesRef.current[directory]
        if (!nextState || nextState.entries.length <= state.entries.length) break
        state = nextState
      }
      if (
        state
        && !state.error
        && !state.entries.some(entry => entry.path === child)
        && state.entries.length < state.total
      ) {
        logWorkspaceFile(directoryLoadsRemaining <= 0
          ? 'tree reveal request budget reached'
          : 'tree reveal page budget reached', {
          sessionId: session.id,
          path,
          directory,
          loaded: state.entries.length,
          total: state.total,
          limit: directoryLoadsRemaining <= 0
            ? MAX_AUTO_REVEAL_DIRECTORY_LOADS
            : MAX_AUTO_REVEAL_EXTRA_PAGES
        })
        if (directoryLoadsRemaining <= 0) break
      }
    }
    if (steps.length > MAX_AUTO_REVEAL_STEPS) {
      logWorkspaceFile('tree reveal depth budget reached', {
        sessionId: session.id,
        path,
        steps: steps.length,
        limit: MAX_AUTO_REVEAL_STEPS
      })
    }
  }

  useEffect(() => {
    if (available !== true || !focusedPath || activeFile?.origin !== 'workspace') return
    void revealWorkspaceFile(focusedPath)
  }, [activeFile?.origin, available, focusedPath, session.id])

  useEffect(() => {
    if (
      available !== true
      || !activeFile
      || activeFile.origin === 'workspace'
      || directoriesRef.current['']
    ) return
    void loadDirectory('')
  }, [activeFile?.origin, activeFile?.path, available, session.id])

  const toggleDirectory = (path: string) => {
    setExpandedDirectories(current => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
    if (!directories[path]) void loadDirectory(path)
  }

  const refreshExplorer = () => {
    if (workspaceMutationRef.current) {
      reportWorkspaceMutationBlock()
      return
    }
    const generation = directoryGeneration.current + 1
    directoryGeneration.current = generation
    revealRequestSequence.current += 1
    directoryLoadsRef.current.clear()
    directoriesRef.current = {}
    setDirectories({})
    if (focusedPath && activeFile?.origin === 'workspace') {
      void revealWorkspaceFile(focusedPath, generation)
    } else {
      setExpandedDirectories(new Set())
      void loadDirectory('', false, generation)
    }
  }

  const reloadExplorerAfterMutation = (
    nextExpanded: Set<string>,
    nextActivePath: string | null
  ) => {
    const generation = directoryGeneration.current + 1
    directoryGeneration.current = generation
    revealRequestSequence.current += 1
    directoryLoadsRef.current.clear()
    directoriesRef.current = {}
    setDirectories({})
    setExpandedDirectories(nextExpanded)
    const activeWorkspaceFile = nextActivePath
      ? openFilesRef.current.find(file => file.path === nextActivePath && file.origin === 'workspace')
      : null
    if (activeWorkspaceFile) {
      void revealWorkspaceFile(activeWorkspaceFile.path, generation)
      return
    }
    void loadDirectory('', false, generation)
    for (const path of nextExpanded) void loadDirectory(path, false, generation)
  }

  const createUntitledFile = (directory = '') => {
    if (!creationAvailable) {
      setWorkspaceError(session.archived
        ? t('editor.archivedChatsAreReadOnly')
        : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders'))
      return
    }
    const currentFiles = openFilesRef.current
    if (currentFiles.length >= MAX_OPEN_TABS) {
      setWorkspaceError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
      return
    }
    const existingNames = new Set(currentFiles.map(file => file.name))
    let sequence = untitledSequenceRef.current
    let name = ''
    do {
      sequence += 1
      name = `Untitled-${sequence}`
    } while (existingNames.has(name))
    untitledSequenceRef.current = sequence
    const path = `untitled://${instanceId}/${Date.now()}-${sequence}`
    const file = openUntitledFile(workspaceRoot || cwd, path, name, directory)
    const nextFiles = [...currentFiles, file]
    openFilesRef.current = nextFiles
    setOpenFiles(nextFiles)
    referenceRequestSequence.current += 1
    openRequestSequence.current += 1
    activateFilePath(path)
    setPendingClosePath(null)
    setWorkspaceError(null)
    setEditorNavigation({
      path,
      line: 1,
      column: 1,
      requestId: ++editorNavigationSequence.current
    })
  }

  const requestNewWorkspaceFile = (target?: WorkspaceEntry | null) => {
    const directory = target === null
      ? ''
      : target
        ? target.kind === 'directory' ? target.path : workspaceParentDirectory(target.path)
        : (() => {
            const path = currentFocusedPath()
            const file = path ? openFilesRef.current.find(candidate => candidate.path === path) : null
            if (file?.origin === 'workspace') return workspaceParentDirectory(file.path)
            return file?.origin === 'untitled' ? file.saveDirectory ?? '' : ''
          })()
    createUntitledFile(directory)
  }

  const requestCreateWorkspaceEntry = (
    kind: WorkspaceCreateKind,
    target?: WorkspaceEntry | null
  ) => {
    if (pendingCreateRef.current) {
      window.dispatchEvent(new Event('agentsdock:focus-pending-create'))
      return
    }
    if (!creationAvailable) {
      setWorkspaceError(session.archived
        ? t('editor.archivedChatsAreReadOnly')
        : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders'))
      return
    }
    if (workspaceMutationRef.current) {
      setWorkspaceError(t('editor.waitForTheCurrentWorkspaceOperationToFinish'))
      return
    }
    const directory = target === null
      ? ''
      : target
        ? target.kind === 'directory' ? target.path : workspaceParentDirectory(target.path)
        : (() => {
            const path = currentFocusedPath()
            const file = path ? openFilesRef.current.find(candidate => candidate.path === path) : null
            return file?.origin === 'workspace' ? workspaceParentDirectory(file.path) : ''
          })()
    setWorkspaceError(null)
    setPendingCreate({
      directory,
      kind,
      creating: false,
      error: null
    })
    const directoryAncestors = directory
      ? workspaceParentDirectories(`${directory}/.agentsdock-new-entry`)
      : []
    setExpandedDirectories(current => {
      const next = new Set(current)
      for (const ancestor of directoryAncestors) next.add(ancestor)
      return next
    })
    for (const candidate of ['', ...directoryAncestors]) {
      if (!directoriesRef.current[candidate]) void loadDirectory(candidate)
    }
  }

  const createWorkspaceEntry = async (name: string) => {
    const pending = pendingCreate
    if (!pending || pending.creating) return
    const validationError = workspaceEntryNameError(name)
    if (validationError) {
      setPendingCreate(current => current ? { ...current, error: validationError } : current)
      return
    }
    if (!creationAvailable) {
      setPendingCreate(current => current ? {
        ...current,
        error: session.archived
          ? t('editor.archivedChatsAreReadOnly')
          : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')
      } : current)
      return
    }
    if (workspaceMutationRef.current) {
      setPendingCreate(current => current ? {
        ...current,
        error: t('editor.waitForTheCurrentWorkspaceOperationToFinish')
      } : current)
      return
    }
    const path = [pending.directory, name].filter(Boolean).join('/')
    const mutation: PendingWorkspaceMutation = { kind: 'create', path }
    workspaceMutationRef.current = mutation
    setWorkspaceMutationPath(path)
    setPendingCreate(current => current ? { ...current, creating: true, error: null } : current)
    setWorkspaceError(null)
    try {
      const result = await window.agentsDock.workspace.create(session.id, path, pending.kind)
      setWorkspaceRoot(result.root)
      const parentState = directoriesRef.current[pending.directory]
      if (parentState && parentState.entries.length < parentState.total) {
        // A locally inserted row would shift the next server offset and skip an
        // entry. Refresh the first page instead and keep server paging exact.
        void loadDirectory(pending.directory, false)
      } else {
        const applyCreatedEntry = (state: Record<string, DirectoryState>) => {
          const directory = state[pending.directory]
          if (!directory) return state
          const existed = directory.entries.some(entry => entry.path === result.entry.path)
          const entries = sortWorkspaceEntries(mergeWorkspaceEntries(directory.entries, [result.entry]))
          return {
            ...state,
            [pending.directory]: {
              ...directory,
              entries,
              total: Math.max(entries.length, directory.total + (existed ? 0 : 1)),
              error: null
            }
          }
        }
        directoriesRef.current = applyCreatedEntry(directoriesRef.current)
        setDirectories(directoriesRef.current)
      }
      setExpandedDirectories(current => {
        const next = new Set(current)
        if (pending.directory) next.add(pending.directory)
        if (result.entry.kind === 'directory') next.add(result.entry.path)
        return next
      })
      if (result.entry.kind === 'directory') {
        const emptyDirectory: DirectoryState = {
          entries: [],
          total: 0,
          loading: false,
          error: null
        }
        directoriesRef.current = {
          ...directoriesRef.current,
          [result.entry.path]: emptyDirectory
        }
        setDirectories(directoriesRef.current)
      } else if (result.file) {
        const currentFiles = openFilesRef.current
        const existingIndex = currentFiles.findIndex(file => file.path === result.file?.path)
        if (existingIndex < 0 && currentFiles.length >= MAX_OPEN_TABS) {
          setWorkspaceError(t('editor.createdTabLimit', { path: result.entry.path, count: MAX_OPEN_TABS }))
        } else {
          const opened = openWorkspaceFile(result.file)
          const nextFiles = existingIndex < 0
            ? [...currentFiles, opened]
            : currentFiles.map((file, index) => index === existingIndex ? opened : file)
          openFilesRef.current = nextFiles
          setOpenFiles(nextFiles)
          activateFilePath(opened.path)
          setEditorNavigation({
            path: opened.path,
            line: 1,
            column: 1,
            requestId: ++editorNavigationSequence.current
          })
        }
      }
      setPendingCreate(null)
    } catch (error) {
      const message = errorMessage(error)
      setPendingCreate(current => current ? { ...current, creating: false, error: message } : current)
    } finally {
      if (workspaceMutationRef.current === mutation) {
        workspaceMutationRef.current = null
        if (mountedRef.current) setWorkspaceMutationPath(null)
      }
    }
  }

  useEffect(() => {
    const createOnActiveSurface = (event: Event) => {
      if (document.querySelector('[aria-modal="true"]')) {
        event.preventDefault()
        return
      }
      if (!currentFocusedPath()) return
      const focusedElement = document.activeElement
      const editorOwnsFocus = focusedElement instanceof Node
        && Boolean(editorPanelRef.current?.contains(focusedElement))
      const fileTabOwnsFocus = focusedElement instanceof Element
        && Boolean(focusedElement.closest('.workspace-editor-file-tab'))
      if (
        filePresentationRef.current !== 'full'
        && !editorOwnsFocus
        && !fileTabOwnsFocus
      ) return
      event.preventDefault()
      requestNewWorkspaceFile()
    }
    window.addEventListener('agentsdock:new-active-surface', createOnActiveSurface)
    return () => window.removeEventListener('agentsdock:new-active-surface', createOnActiveSurface)
  }, [capabilityVersion, creationAvailable, focusedPath, session.archived])

  const copyWorkspaceEntryPath = async (entry: WorkspaceEntry, relative: boolean) => {
    const value = relative ? entry.path : absoluteWorkspacePath(workspaceRoot, entry.path)
    try {
      await window.agentsDock.native.writeClipboard(value)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    }
  }

  const downloadWorkspaceEntry = async (entry: WorkspaceEntry) => {
    if (entry.kind !== 'file') return
    setWorkspaceError(null)
    try {
      await window.agentsDock.workspace.download(session.id, entry.path)
    } catch (error) {
      if (mountedRef.current) setWorkspaceError(errorMessage(error))
    }
  }

  const requestRenameWorkspaceEntry = (entry: WorkspaceEntry) => {
    setWorkspaceError(null)
    setRenameValue(entry.name)
    setPendingRenameEntry(entry)
  }

  const renameWorkspaceEntry = async () => {
    const entry = pendingRenameEntry
    if (!entry || renamingEntry) return
    const validationError = workspaceEntryNameError(renameValue)
    if (validationError) {
      setWorkspaceError(validationError)
      return
    }
    if (!mutationsAvailable || !entry.revision) {
      setWorkspaceError(t('editor.updateAgentsserverToRenameWorkspaceFilesAndFolders'))
      return
    }
    if (workspaceMutationRef.current) {
      setWorkspaceError(t('editor.waitForTheCurrentWorkspaceOperationToFinish'))
      return
    }
    const affectedFiles = openFilesRef.current.filter(file => (
      file.origin === 'workspace' && workspacePathIsWithin(file.path, entry.path)
    ))
    const proposedPath = [
      workspaceParentDirectory(entry.path),
      renameValue
    ].filter(Boolean).join('/')
    if (
      entry.kind === 'file'
      && affectedFiles.some(file => (
        file.dirty
        && file.viewerKind !== workspaceFileViewerKind(proposedPath)
      ))
    ) {
        setWorkspaceError(t('editor.saveBeforeChangingType'))
      return
    }
    if (
      affectedFiles.some(file => file.saving || file.loading)
      || workspaceEntryHasPendingFileOperation(entry.path)
      || [...pendingOpenPathsRef.current.keys()].some(path => workspacePathIsWithin(path, entry.path))
    ) {
      setWorkspaceError(t('editor.waitForThisFileOperationToFinishBeforeRenamingIt'))
      return
    }
    const mutation: PendingWorkspaceMutation = { kind: 'rename', path: entry.path }
    workspaceMutationRef.current = mutation
    setWorkspaceMutationPath(entry.path)
    setRenamingEntry(true)
    setWorkspaceError(null)
    try {
      const result = await window.agentsDock.workspace.rename(
        session.id,
        entry.path,
        renameValue,
        entry.revision
      )
      const previousPath = result.previous_path
      const nextPath = result.entry.path
      setWorkspaceRoot(result.root)
      const nextFiles = openFilesRef.current.map(file => {
        if (file.origin !== 'workspace' || !workspacePathIsWithin(file.path, previousPath)) return file
        const path = remapWorkspacePath(file.path, previousPath, nextPath)
        const viewerKind = workspaceFileViewerKind(path)
        const wasMedia = file.viewerKind === 'image' || file.viewerKind === 'pdf'
        const isMedia = viewerKind === 'image' || viewerKind === 'pdf'
        const renamed = {
          ...file,
          root: result.root,
          path,
          name: fileName(path),
          viewerKind,
          displayPath: undefined
        }
        if (wasMedia === isMedia) return renamed
        if (isMedia) {
          return {
            ...renamed,
            content: '',
            draft: '',
            saved: '',
            dirty: false,
            writable: false,
            loaded: true,
            lines: 0,
            error: null
          }
        }
        return {
          ...renamed,
          content: '',
          draft: '',
          saved: '',
          dirty: false,
          writable: false,
          loaded: false,
          lines: 1,
          error: null
        }
      })
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      const currentActivePath = activePathRef.current
      const nextActivePath = currentActivePath && workspacePathIsWithin(currentActivePath, previousPath)
        ? remapWorkspacePath(currentActivePath, previousPath, nextPath)
        : currentActivePath
      activePathRef.current = nextActivePath
      setActivePath(nextActivePath)
      const currentSecondaryPath = secondaryPathRef.current
      const nextSecondaryPath = currentSecondaryPath && workspacePathIsWithin(currentSecondaryPath, previousPath)
        ? remapWorkspacePath(currentSecondaryPath, previousPath, nextPath)
        : currentSecondaryPath
      secondaryPathRef.current = nextSecondaryPath
      setSecondaryPath(nextSecondaryPath)
      setPendingClosePath(current => current && workspacePathIsWithin(current, previousPath)
        ? remapWorkspacePath(current, previousPath, nextPath)
        : current)
      setPendingReloadPath(current => current && workspacePathIsWithin(current, previousPath)
        ? remapWorkspacePath(current, previousPath, nextPath)
        : current)
      setOpeningPath(current => current && workspacePathIsWithin(current, previousPath)
        ? remapWorkspacePath(current, previousPath, nextPath)
        : current)
      setEditorNavigation(current => current && workspacePathIsWithin(current.path, previousPath)
        ? { ...current, path: remapWorkspacePath(current.path, previousPath, nextPath) }
        : current)
      viewStatesRef.current = remapWorkspaceViewStates(viewStatesRef.current, previousPath, nextPath)
      const nextExpanded = remapWorkspaceExpandedPaths(expandedDirectories, previousPath, nextPath)
      setPendingRenameEntry(null)
      reloadExplorerAfterMutation(nextExpanded, activeGroupRef.current === 'secondary' ? nextSecondaryPath : nextActivePath)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      if (workspaceMutationRef.current === mutation) {
        workspaceMutationRef.current = null
        if (mountedRef.current) setWorkspaceMutationPath(null)
      }
      if (mountedRef.current) setRenamingEntry(false)
    }
  }

  const deleteWorkspaceEntry = async () => {
    const entry = pendingDeleteEntry
    if (!entry || deletingEntry) return
    if (!mutationsAvailable || !entry.revision) {
      setWorkspaceError(t('editor.updateAgentsserverToDeleteWorkspaceFilesAndFolders'))
      return
    }
    if (workspaceMutationRef.current) {
      setWorkspaceError(t('editor.waitForTheCurrentWorkspaceOperationToFinish'))
      return
    }
    const affectedFiles = openFilesRef.current.filter(file => (
      file.origin === 'workspace' && workspacePathIsWithin(file.path, entry.path)
    ))
    if (
      affectedFiles.some(file => file.saving || file.loading)
      || workspaceEntryHasPendingFileOperation(entry.path)
      || [...pendingOpenPathsRef.current.keys()].some(path => workspacePathIsWithin(path, entry.path))
    ) {
      setWorkspaceError(t('editor.waitForThisFileOperationToFinishBeforeDeletingIt'))
      return
    }
    const mutation: PendingWorkspaceMutation = { kind: 'delete', path: entry.path }
    workspaceMutationRef.current = mutation
    setWorkspaceMutationPath(entry.path)
    setDeletingEntry(true)
    setWorkspaceError(null)
    try {
      const result = await window.agentsDock.workspace.remove(
        session.id,
        entry.path,
        entry.revision,
        entry.kind === 'directory'
      )
      setWorkspaceRoot(result.root)
      const nextFiles = openFilesRef.current.filter(file => (
        file.origin !== 'workspace' || !workspacePathIsWithin(file.path, entry.path)
      ))
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      const currentActivePath = activePathRef.current
      let nextActivePath = currentActivePath && workspacePathIsWithin(currentActivePath, entry.path)
        ? null
        : currentActivePath
      const currentSecondaryPath = secondaryPathRef.current
      let nextSecondaryPath = currentSecondaryPath && workspacePathIsWithin(currentSecondaryPath, entry.path)
        ? null
        : currentSecondaryPath
      if (!nextActivePath && nextSecondaryPath) {
        nextActivePath = nextSecondaryPath
        nextSecondaryPath = null
      }
      activePathRef.current = nextActivePath
      setActivePath(nextActivePath)
      secondaryPathRef.current = nextSecondaryPath
      setSecondaryPath(nextSecondaryPath)
      if (!nextSecondaryPath && activeGroupRef.current === 'secondary') {
        activeGroupRef.current = 'primary'
        setActiveGroup('primary')
      }
      setPendingClosePath(current => current && workspacePathIsWithin(current, entry.path) ? null : current)
      setPendingReloadPath(current => current && workspacePathIsWithin(current, entry.path) ? null : current)
      setEditorNavigation(current => current && workspacePathIsWithin(current.path, entry.path) ? null : current)
      for (const key of [...viewStatesRef.current.keys()]) {
        const path = parseEditorViewStateKey(key)?.path ?? key
        if (workspacePathIsWithin(path, entry.path)) viewStatesRef.current.delete(key)
      }
      const nextExpanded = new Set(
        [...expandedDirectories].filter(path => !workspacePathIsWithin(path, entry.path))
      )
      setPendingDeleteEntry(null)
      reloadExplorerAfterMutation(nextExpanded, activeGroupRef.current === 'secondary' ? nextSecondaryPath : nextActivePath)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      if (workspaceMutationRef.current === mutation) {
        workspaceMutationRef.current = null
        if (mountedRef.current) setWorkspaceMutationPath(null)
      }
      if (mountedRef.current) setDeletingEntry(false)
    }
  }

  const requestEditorNavigation = (
    path: string,
    location?: Pick<OpenWorkspacePathDetail, 'line' | 'column'>
  ) => {
    if (!location?.line) return
    setEditorNavigation({
      path,
      line: location.line,
      column: location.column,
      requestId: ++editorNavigationSequence.current
    })
  }

  const openFile = async (
    path: string,
    fallbackArtifact?: AgentFile,
    location?: Pick<OpenWorkspacePathDetail, 'line' | 'column'>,
    options: OpenWorkspaceFileOptions = {}
  ): Promise<boolean> => {
    const paletteLease = options.paletteLease
    const requestIsCurrent = (request: number): boolean => (
      paletteLease
        ? paletteLeaseIsCurrent(paletteLease)
        : request === openRequestSequence.current
    )
    const reportOpenError = (message: string): void => {
      if (!paletteLeaseIsCurrent(paletteLease)) return
      if (options.quiet) return
      if (options.errorSurface === 'palette') {
        setPaletteError(message)
        setWorkspaceError(null)
        return
      }
      setWorkspaceError(message)
    }
    const targetGroup = paletteLease?.targetGroup ?? options.targetGroup ?? (
      activePathRef.current && activeGroupRef.current === 'secondary' ? 'secondary' : 'primary'
    )
    if (!paletteLeaseIsCurrent(paletteLease)) return false
    if (workspaceMutationBlocks(path)) {
      if (!options.quiet) reportWorkspaceMutationBlock()
      return false
    }
    if (!options.preserveReferenceRequest) referenceRequestSequence.current += 1
    requestEditorNavigation(path, location)
    const existing = openFilesRef.current.find(file => file.path === path)
    if (existing) {
      if (!paletteLeaseIsCurrent(paletteLease)) return false
      const alreadyActive = currentFocusedPath() === path
      if (!paletteLease) openRequestSequence.current += 1
      activateFilePath(path, targetGroup)
      if (paletteLease) commitPaletteSelection(paletteLease)
      else {
        paletteOpenRef.current = false
        setPaletteOpen(false)
        setPaletteQuery('')
      }
      setPendingClosePath(null)
      setWorkspaceError(null)
      void ensureFileLoaded(path)
      if (alreadyActive && existing.origin === 'workspace' && available === true) {
        void revealWorkspaceFile(path)
      }
      return true
    }
    const pendingOutcome = pendingOpenOutcomesRef.current.get(path)
    if (pendingOutcome) {
      const waiterOpenRequest = paletteLease ? null : ++openRequestSequence.current
      const outcome = await pendingOutcome
      const current = paletteLease
        ? paletteLeaseIsCurrent(paletteLease)
        : waiterOpenRequest === openRequestSequence.current
      if (outcome.kind === 'stale' && mountedRef.current && current) {
        return openFile(path, fallbackArtifact, location, options)
      }
      if (outcome.kind === 'failed' && current) reportOpenError(outcome.error)
      const opened = outcome.kind === 'opened'
      if (opened && current) {
        requestEditorNavigation(outcome.path, location)
        activateFilePath(outcome.path, targetGroup)
        if (paletteLease) commitPaletteSelection(paletteLease)
      }
      return opened && current
    }
    if (openFilesRef.current.length + pendingOpenCount(paletteLease) >= MAX_OPEN_TABS) {
      reportOpenError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
      return false
    }
    const viewerKind = workspaceFileViewerKind(path)
    if (viewerKind === 'image' || viewerKind === 'pdf') {
      if (capabilityVersion < 3) {
        if (!options.quiet) {
          const message = t('editor.updateAgentsserverToPreviewWorkspaceImagesAndPdfs')
          reportOpenError(message)
        }
        return false
      }
      const openRequest = paletteLease?.generation ?? ++openRequestSequence.current
      setOpeningPath(path)
      setPaletteError(null)
      setWorkspaceError(null)
      try {
        // Workspace references originating from an attached file need one
        // existence check so a stale source_path can fall back to the snapshot.
        // Explorer/palette paths already came from the workspace and open
        // immediately, avoiding an extra round trip before the actual preview.
        if (fallbackArtifact) {
          if (!profileScope) throw new Error(t('editor.theActiveServerProfileIsUnavailable'))
          const available = await window.agentsDock.workspace.previewAvailable(profileScope, session.id, path)
          if (!available) throw new Error(t('editor.workspacePreviewIsUnavailable'))
        }
        if (
          !mountedRef.current
          || !requestIsCurrent(openRequest)
        ) return false
        const currentFiles = openFilesRef.current
        if (!currentFiles.some(candidate => candidate.path === path) && currentFiles.length >= MAX_OPEN_TABS) {
          if (!options.quiet) {
            reportOpenError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
          }
          return false
        }
        const entry = workspaceEntryForPath(directoriesRef.current, path)
        const nextFiles = currentFiles.some(candidate => candidate.path === path)
          ? currentFiles
          : [
              ...currentFiles,
              openWorkspacePreviewFile(workspaceRoot || cwd, path, viewerKind, entry)
            ]
        openFilesRef.current = nextFiles
        setOpenFiles(nextFiles)
        activateFilePath(path, targetGroup)
        if (paletteLease) commitPaletteSelection(paletteLease)
        else {
          paletteOpenRef.current = false
          setPaletteOpen(false)
          setPaletteQuery('')
        }
        setPendingClosePath(null)
        setWorkspaceError(null)
        if (available === true) void revealWorkspaceFile(path)
        return true
      } catch (error) {
        if (
          mountedRef.current
          && fallbackArtifact
          && requestIsCurrent(openRequest)
        ) {
          await openArtifactFile(fallbackArtifact, location, targetGroup)
          return true
        }
        if (
          mountedRef.current
          && requestIsCurrent(openRequest)
          && !options.quiet
        ) {
          reportOpenError(errorMessage(error))
        }
        return false
      } finally {
        if (mountedRef.current) setOpeningPath(current => current === path ? null : current)
      }
    }
    const openRequest = paletteLease?.generation ?? ++openRequestSequence.current
    const workspaceOperation = beginWorkspaceFileOperation(path, 'read')
    if (!workspaceOperation) {
      if (workspaceMutationBlocks(path) && !options.quiet) reportWorkspaceMutationBlock()
      return false
    }
    const pendingReservation = reservePendingOpen(path, paletteLease)
    let resolvePendingOutcome!: (outcome: PendingOpenOutcome) => void
    const outcomePromise = new Promise<PendingOpenOutcome>(resolve => { resolvePendingOutcome = resolve })
    pendingOpenOutcomesRef.current.set(path, outcomePromise)
    let opened = false
    let pendingOutcomeState: PendingOpenOutcome = { kind: 'stale' }
    setOpeningPath(path)
    setPaletteError(null)
    setWorkspaceError(null)
    const startedAt = performance.now()
    logWorkspaceFile('open requested', { sessionId: session.id, path, openRequest })
    try {
      const file = await window.agentsDock.workspace.read(session.id, path)
      logWorkspaceFile('read completed', {
        sessionId: session.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        size: file.size,
        writable: file.writable
      })
      if (!mountedRef.current || !paletteLeaseIsCurrent(paletteLease)) return false
      const currentFiles = openFilesRef.current
      if (!currentFiles.some(candidate => candidate.path === path) && currentFiles.length >= MAX_OPEN_TABS) {
        if (requestIsCurrent(openRequest)) {
          reportOpenError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
          pendingOutcomeState = {
            kind: 'failed',
            error: t('editor.tabLimit', { count: MAX_OPEN_TABS })
          }
        }
        return false
      }
      const nextFiles = currentFiles.some(candidate => candidate.path === path)
        ? currentFiles
        : [...currentFiles, openWorkspaceFile(file)]
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      if (requestIsCurrent(openRequest)) {
        activateFilePath(path, targetGroup)
        if (paletteLease) commitPaletteSelection(paletteLease)
        else {
          paletteOpenRef.current = false
          setPaletteOpen(false)
          setPaletteQuery('')
        }
        setPendingClosePath(null)
      }
      opened = true
      pendingOutcomeState = { kind: 'opened', path }
      return true
    } catch (error) {
      const message = errorMessage(error)
      if (mountedRef.current) pendingOutcomeState = { kind: 'failed', error: message }
      logWorkspaceFile('open failed', {
        sessionId: session.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        error: message
      })
      if (
        mountedRef.current
        && fallbackArtifact
        && requestIsCurrent(openRequest)
      ) {
        releasePendingOpen(path, pendingReservation)
        await openArtifactFile(fallbackArtifact, location, targetGroup)
        opened = true
        pendingOutcomeState = { kind: 'opened', path: artifactTabPath(fallbackArtifact) }
        return true
      } else if (
        mountedRef.current
        && requestIsCurrent(openRequest)
      ) {
        if (!options.quiet) {
          reportOpenError(message)
        }
      }
      return false
    } finally {
      resolvePendingOutcome(pendingOutcomeState)
      if (pendingOpenOutcomesRef.current.get(path) === outcomePromise) {
        pendingOpenOutcomesRef.current.delete(path)
      }
      releasePendingOpen(path, pendingReservation)
      finishWorkspaceFileOperation(path, workspaceOperation)
      if (mountedRef.current) setOpeningPath(current => current === path ? null : current)
    }
  }

  const openAbsoluteFile = async (
    path: string,
    location?: Pick<OpenWorkspacePathDetail, 'line' | 'column'>,
    errorSurface: 'palette' | 'workspace' = 'workspace',
    paletteLease?: PaletteOpenLease
  ): Promise<boolean> => {
    const requestIsCurrent = (request: number): boolean => (
      paletteLease
        ? paletteLeaseIsCurrent(paletteLease)
        : request === openRequestSequence.current
    )
    const reportOpenError = (message: string): void => {
      if (!paletteLeaseIsCurrent(paletteLease)) return
      if (errorSurface === 'palette') {
        setPaletteError(message)
        setWorkspaceError(null)
        return
      }
      setWorkspaceError(message)
    }
    if (!absoluteReadsAvailable) {
      const message = t('editor.updateAgentsserverToOpenExplicitAbsolutePathsOutsideTheWorkspace')
      reportOpenError(message)
      return false
    }
    if (!paletteLeaseIsCurrent(paletteLease)) return false
    const targetGroup = paletteLease?.targetGroup ?? activeGroupRef.current
    referenceRequestSequence.current += 1
    requestEditorNavigation(path, location)
    const existing = openFilesRef.current.find(file => file.path === path)
    if (existing) {
      if (!paletteLeaseIsCurrent(paletteLease)) return false
      if (!paletteLease) openRequestSequence.current += 1
      activateFilePath(path, targetGroup)
      if (paletteLease) commitPaletteSelection(paletteLease)
      else {
        paletteOpenRef.current = false
        setPaletteOpen(false)
        setPaletteQuery('')
      }
      setPendingClosePath(null)
      setWorkspaceError(null)
      void ensureFileLoaded(path)
      return true
    }
    const pendingOutcome = pendingOpenOutcomesRef.current.get(path)
    if (pendingOutcome) {
      const waiterOpenRequest = paletteLease ? null : ++openRequestSequence.current
      const outcome = await pendingOutcome
      const current = paletteLease
        ? paletteLeaseIsCurrent(paletteLease)
        : waiterOpenRequest === openRequestSequence.current
      if (outcome.kind === 'stale' && mountedRef.current && current) {
        return openAbsoluteFile(path, location, errorSurface, paletteLease)
      }
      if (outcome.kind === 'failed' && current) reportOpenError(outcome.error)
      const opened = outcome.kind === 'opened'
      if (opened && current) {
        requestEditorNavigation(outcome.path, location)
        activateFilePath(outcome.path, targetGroup)
        if (paletteLease) commitPaletteSelection(paletteLease)
      }
      return opened && current
    }
    if (openFilesRef.current.length + pendingOpenCount(paletteLease) >= MAX_OPEN_TABS) {
      reportOpenError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
      return false
    }
    const openRequest = paletteLease?.generation ?? ++openRequestSequence.current
    const operation = beginWorkspaceFileOperation(path, 'read')
    if (!operation) return false
    const pendingReservation = reservePendingOpen(path, paletteLease)
    let resolvePendingOutcome!: (outcome: PendingOpenOutcome) => void
    const outcomePromise = new Promise<PendingOpenOutcome>(resolve => { resolvePendingOutcome = resolve })
    pendingOpenOutcomesRef.current.set(path, outcomePromise)
    let opened = false
    let pendingOutcomeState: PendingOpenOutcome = { kind: 'stale' }
    setOpeningPath(path)
    setPaletteError(null)
    setWorkspaceError(null)
    const startedAt = performance.now()
    logWorkspaceFile('absolute read requested', { sessionId: session.id, path, openRequest })
    try {
      const file = await window.agentsDock.workspace.readAbsolute(session.id, path)
      if (
        !mountedRef.current
        || !isCurrentWorkspaceFileOperation(path, operation)
        || !paletteLeaseIsCurrent(paletteLease)
      ) return false
      const resolvedPath = file.path || path
      if (resolvedPath !== path) requestEditorNavigation(resolvedPath, location)
      const currentFiles = openFilesRef.current
      if (!currentFiles.some(candidate => candidate.path === resolvedPath) && currentFiles.length >= MAX_OPEN_TABS) {
        if (requestIsCurrent(openRequest)) {
          setPaletteError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
          pendingOutcomeState = {
            kind: 'failed',
            error: t('editor.tabLimit', { count: MAX_OPEN_TABS })
          }
        }
        return false
      }
      const externalFile = openExternalFile(file, absoluteWritesAvailable)
      const nextFiles = currentFiles.some(candidate => candidate.path === resolvedPath)
        ? currentFiles
        : [...currentFiles, externalFile]
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      if (requestIsCurrent(openRequest)) {
        activateFilePath(resolvedPath, targetGroup)
        if (paletteLease) commitPaletteSelection(paletteLease)
        else {
          paletteOpenRef.current = false
          setPaletteOpen(false)
          setPaletteQuery('')
        }
        setPendingClosePath(null)
      }
      logWorkspaceFile('absolute read completed', {
        sessionId: session.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        size: file.size,
        writable: externalFile.writable
      })
      opened = true
      pendingOutcomeState = { kind: 'opened', path: resolvedPath }
      return true
    } catch (error) {
      const message = errorMessage(error)
      if (mountedRef.current) pendingOutcomeState = { kind: 'failed', error: message }
      logWorkspaceFile('absolute read failed', {
        sessionId: session.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        error: message
      })
      if (
        mountedRef.current
        && requestIsCurrent(openRequest)
      ) {
        reportOpenError(message)
      }
      return false
    } finally {
      resolvePendingOutcome(pendingOutcomeState)
      if (pendingOpenOutcomesRef.current.get(path) === outcomePromise) {
        pendingOpenOutcomesRef.current.delete(path)
      }
      releasePendingOpen(path, pendingReservation)
      finishWorkspaceFileOperation(path, operation)
      if (mountedRef.current) setOpeningPath(current => current === path ? null : current)
    }
  }

  const openArtifactFile = async (
    file: AgentFile,
    location?: Pick<OpenWorkspacePathDetail, 'line' | 'column'>,
    targetGroup: EditorGroupId = activeGroupRef.current
  ) => {
    if (!agentFileBelongsToSession(file, session.id)) {
      setWorkspaceError(t('editor.thatFileBelongsToADifferentChat'))
      return
    }
    const path = artifactTabPath(file)
    const viewerKind = internalFileViewerKind(file)
    referenceRequestSequence.current += 1
    requestEditorNavigation(path, location)
    const existing = openFilesRef.current.find(candidate => candidate.path === path)
    if (existing) {
      openRequestSequence.current += 1
      activateFilePath(path, targetGroup)
      setPendingClosePath(null)
      setWorkspaceError(null)
      void ensureFileLoaded(path)
      return
    }
    if (pendingOpenPathsRef.current.has(path)) return
    if (openFilesRef.current.length + pendingOpenPathsRef.current.size >= MAX_OPEN_TABS) {
      setWorkspaceError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
      return
    }
    if (viewerKind === 'image' || viewerKind === 'pdf') {
      openRequestSequence.current += 1
      const nextFiles = [...openFilesRef.current, openArtifactPreviewFile(file, viewerKind)]
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      activateFilePath(path, targetGroup)
      setPendingClosePath(null)
      setWorkspaceError(null)
      return
    }
    if (viewerKind === 'unsupported') {
      setWorkspaceError(t('editor.previewUnsupported', { name: file.filename }))
      return
    }
    const openRequest = ++openRequestSequence.current
    const pendingReservation = reservePendingOpen(path)
    const placeholder = loadingArtifactTextFile(file)
    const pendingFiles = [...openFilesRef.current, placeholder]
    openFilesRef.current = pendingFiles
    setOpenFiles(pendingFiles)
    activateFilePath(path, targetGroup)
    setPendingClosePath(null)
    setOpeningPath(path)
    setWorkspaceError(null)
    const startedAt = performance.now()
    logWorkspaceFile('artifact open requested', { sessionId: session.id, fileId: file.id, path, openRequest })
    const read = beginArtifactRead(path, file)
    try {
      const snapshot = await read.promise
      if (!mountedRef.current || !isCurrentArtifactRead(path, read.requestId)) return
      const currentFiles = openFilesRef.current
      if (!currentFiles.some(candidate => candidate.path === path) && currentFiles.length >= MAX_OPEN_TABS) {
        if (openRequest === openRequestSequence.current) {
          setWorkspaceError(t('editor.tabLimit', { count: MAX_OPEN_TABS }))
        }
        return
      }
      const nextFiles = currentFiles.map(candidate => candidate.path === path
        ? openArtifactTextFile(file, snapshot)
        : candidate)
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      logWorkspaceFile('artifact read completed', {
        sessionId: session.id,
        fileId: file.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        size: snapshot.size
      })
    } catch (error) {
      const message = errorMessage(error)
      logWorkspaceFile('artifact open failed', {
        sessionId: session.id,
        fileId: file.id,
        path,
        openRequest,
        durationMs: Math.round(performance.now() - startedAt),
        error: message
      })
      if (mountedRef.current && isCurrentArtifactRead(path, read.requestId) && openFilesRef.current.some(candidate => candidate.path === path)) {
        updateFile(path, current => ({
          ...current,
          loading: false,
          loaded: false,
          error: message
        }))
        if (openRequest === openRequestSequence.current) setWorkspaceError(message)
      }
    } finally {
      if (finishArtifactRead(path, read.requestId)) {
        releasePendingOpen(path, pendingReservation)
        if (mountedRef.current) setOpeningPath(current => current === path ? null : current)
      }
    }
  }

  const openWorkspaceReference = async (detail: OpenWorkspacePathDetail) => {
    if (workspaceMutationRef.current) {
      reportWorkspaceMutationBlock()
      return
    }
    const sequence = ++referenceRequestSequence.current
    const pathInput = resolveWorkspacePathInput(cwd, detail.path)
    if (pathInput.kind === 'workspace-file') {
      await openFile(pathInput.path, undefined, detail, { preserveReferenceRequest: true })
      return
    }
    if (pathInput.kind === 'absolute-file') {
      await openAbsoluteFile(pathInput.path, detail)
      return
    }
    if (pathInput.kind === 'outside-workspace') {
      setWorkspaceError(t('editor.thatFileReferenceIsOutsideThisChatSWorkingDirectory'))
      return
    }

    const reference = normalizeWorkspaceReference(detail.path)
    if (!reference) {
      setWorkspaceError(t('editor.thatFileReferenceIsNotASafeWorkspacePath'))
      return
    }
    setWorkspaceError(null)
    const openedExactPath = await openFile(reference, undefined, detail, {
      quiet: true,
      preserveReferenceRequest: true
    })
    if (!mountedRef.current || sequence !== referenceRequestSequence.current) return
    if (openedExactPath) return
    setEditorNavigation(current => current?.path === reference ? null : current)
    try {
      const page = await window.agentsDock.workspace.search(session.id, reference, 100)
      if (!mountedRef.current || sequence !== referenceRequestSequence.current) return
      const resolution = resolveWorkspaceReference(reference, page.entries)
      if (resolution.kind === 'match') {
        await openFile(resolution.path, undefined, detail, { preserveReferenceRequest: true })
        return
      }
      if (resolution.kind === 'ambiguous') {
        const generation = advancePaletteGeneration()
        paletteOpenRef.current = true
        paletteCloseReasonRef.current = 'cancel'
        paletteSeedResultsRef.current = { generation, entries: resolution.matches }
        paletteReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const ownerGroup = currentEditorGroup()
        paletteGroupRef.current = ownerGroup
        setPaletteGroup(ownerGroup)
        paletteNavigationRef.current = { line: detail.line, column: detail.column }
        setPaletteQuery(reference)
        setPaletteResults(resolution.matches)
        setPaletteIndex(0)
        setPaletteError(null)
        setPaletteOpen(true)
        setWorkspaceError(t('editor.ambiguousReference', { reference: reference }))
        return
      }
      setWorkspaceError(t('editor.referenceNotFound', { reference: reference }))
    } catch (error) {
      if (mountedRef.current && sequence === referenceRequestSequence.current) {
        setWorkspaceError(errorMessage(error))
      }
    }
  }

  const openPaletteFile = (path: string) => {
    if (!paletteOpenRef.current) return
    const generation = advancePaletteGeneration()
    // A concrete selection is newer file-opening intent than any generic read
    // already in flight. Merely opening, typing in, or cancelling the palette
    // intentionally does not supersede those reads.
    openRequestSequence.current += 1
    setPaletteLoading(false)
    setPaletteTruncated(false)
    const paletteLease: PaletteOpenLease = {
      generation,
      targetGroup: paletteGroupRef.current === 'secondary' && secondaryPathRef.current
        ? 'secondary'
        : 'primary'
    }
    const location = paletteNavigationRef.current ?? undefined
    paletteNavigationRef.current = null
    if (palettePathInput.kind === 'absolute-file' && palettePathInput.path === path) {
      void openAbsoluteFile(path, location, 'palette', paletteLease)
      return
    }
    const exactPathQuery = palettePathInput.kind === 'workspace-file'
      && palettePathInput.path === path
    if (!exactPathQuery) {
      void openFile(path, undefined, location, { errorSurface: 'palette', paletteLease })
      return
    }

    // Slash-containing input is offered immediately as an exact path so files
    // excluded from the workspace index remain openable. If that optimistic
    // read fails, still resolve the input through search: users commonly paste
    // a workspace-relative suffix while the actual workspace has an additional
    // repository/container prefix. Inline agent links already use this
    // exact-then-search behavior; Cmd+O should be equally forgiving.
    const sequence = ++referenceRequestSequence.current
    void openFile(path, undefined, location, {
      preserveReferenceRequest: true,
      errorSurface: 'palette',
      paletteLease
    })
      .then(async opened => {
        if (opened || !mountedRef.current || sequence !== referenceRequestSequence.current) return
        try {
          const page = await window.agentsDock.workspace.search(session.id, path, 100)
          if (!mountedRef.current || sequence !== referenceRequestSequence.current) return
          const resolution = resolveWorkspaceReference(path, page.entries)
          if (resolution.kind === 'match' && resolution.path !== path) {
            await openFile(resolution.path, undefined, location, {
              preserveReferenceRequest: true,
              errorSurface: 'palette',
              paletteLease
            })
            return
          }
          if (resolution.kind === 'ambiguous') {
            paletteSeedResultsRef.current = {
              generation: paletteLease.generation,
              entries: resolution.matches
            }
            setPaletteQuery(fileName(path))
            setPaletteResults(resolution.matches)
            setPaletteIndex(0)
            setPaletteError(t('editor.exactPathFailed', { name: fileName(path) }))
          }
        } catch (error) {
          if (mountedRef.current && sequence === referenceRequestSequence.current) {
            setPaletteError(errorMessage(error))
          }
        }
      })
  }

  const openFileToSide = (path: string): void => {
    void openFile(path, undefined, undefined, { targetGroup: 'secondary' })
  }

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenWorkspacePathDetail>).detail
      if (!detail || detail.sessionId !== session.id || !detail.path) return
      initialWorkspaceOpenPendingRef.current = false
      if (available !== true) {
        setWorkspaceError(capabilityMessage)
        return
      }
      if (detail.resolve) void openWorkspaceReference(detail)
      else {
        const pathInput = resolveWorkspacePathInput(cwd, detail.path)
        if (pathInput.kind === 'outside-workspace') {
        setWorkspaceError(t('editor.fileOutsideDirectory'))
          return
        }
        if (pathInput.kind === 'absolute-file') {
          void openAbsoluteFile(pathInput.path, detail)
          return
        }
        void openFile(pathInput.kind === 'workspace-file' ? pathInput.path : detail.path, undefined, detail)
      }
    }
    window.addEventListener('agentsdock:open-workspace-path', open)
    return () => window.removeEventListener('agentsdock:open-workspace-path', open)
  }, [absoluteReadsAvailable, absoluteWritesAvailable, available, capabilityMessage, cwd, session.id])

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<OpenAgentFileDetail>).detail
      if (!detail || detail.sessionId !== session.id || !detail.file?.id) return
      initialWorkspaceOpenPendingRef.current = false
      if (!agentFileBelongsToSession(detail.file, session.id)) {
        setWorkspaceError(t('editor.thatFileBelongsToADifferentChat'))
        return
      }
      const workspacePath = workspacePathForAgentFile(detail.file, cwd)
      if (workspacePath && available === true) {
        void openFile(workspacePath, detail.file, detail)
        return
      }
      void openArtifactFile(detail.file, detail)
    }
    window.addEventListener('agentsdock:open-agent-file', open)
    return () => window.removeEventListener('agentsdock:open-agent-file', open)
  }, [available, cwd, session.id])

  useEffect(() => {
    onReady?.()
  }, [onReady, session.id])

  const updateFile = (path: string, update: (file: OpenWorkspaceFile) => OpenWorkspaceFile) => {
    setOpenFiles(current => current.map(file => file.path === path ? update(file) : file))
  }

  async function refreshWorkspaceEntryAfterSave(path: string): Promise<boolean> {
    const generation = directoryGeneration.current
    const directory = workspaceParentDirectory(path)
    const state = directoriesRef.current[directory]
    const entryIndex = state?.entries.findIndex(entry => entry.path === path) ?? -1
    if (entryIndex < 0) return true
    const offset = Math.floor(entryIndex / WORKSPACE_DIRECTORY_PAGE_SIZE) * WORKSPACE_DIRECTORY_PAGE_SIZE
    const page = await window.agentsDock.workspace.entries(
      session.id,
      directory,
      offset,
      WORKSPACE_DIRECTORY_PAGE_SIZE
    )
    if (!mountedRef.current || generation !== directoryGeneration.current) return true
    setWorkspaceRoot(page.root)
    const refreshedEntry = page.entries.find(entry => entry.path === path)
    if (!refreshedEntry) return false
    const replaceEntry = (current: Record<string, DirectoryState>) => {
      const currentDirectory = current[directory]
      if (!currentDirectory) return current
      return {
        ...current,
        [directory]: {
          ...currentDirectory,
          total: page.total,
          entries: currentDirectory.entries.map(entry => (
            entry.path === path ? refreshedEntry : entry
          ))
        }
      }
    }
    directoriesRef.current = replaceEntry(directoriesRef.current)
    setDirectories(replaceEntry)
    setPendingRenameEntry(current => current?.path === path ? refreshedEntry : current)
    setPendingDeleteEntry(current => current?.path === path ? refreshedEntry : current)
    return true
  }

  function invalidateWorkspaceEntryRevision(path: string): void {
    const directory = workspaceParentDirectory(path)
    const invalidateEntry = (current: Record<string, DirectoryState>) => {
      const currentDirectory = current[directory]
      if (!currentDirectory?.entries.some(entry => entry.path === path)) return current
      return {
        ...current,
        [directory]: {
          ...currentDirectory,
          entries: currentDirectory.entries.map(entry => (
            entry.path === path ? { ...entry, revision: undefined } : entry
          ))
        }
      }
    }
    directoriesRef.current = invalidateEntry(directoriesRef.current)
    setDirectories(invalidateEntry)
    setPendingRenameEntry(current => current?.path === path ? { ...current, revision: undefined } : current)
    setPendingDeleteEntry(current => current?.path === path ? { ...current, revision: undefined } : current)
  }

  function refreshWorkspaceMetadataAfterSave(path: string): void {
    const metadataSync = beginWorkspaceMetadataSync(path)
    void refreshWorkspaceEntryAfterSave(path)
      .then(refreshed => {
        if (!refreshed && mountedRef.current) {
          invalidateWorkspaceEntryRevision(path)
          setWorkspaceError(t('editor.theFileWasSavedButItsExplorerMetadataChangedRefreshTheExplorerBeforeRenamingOrDeletingIt'))
        }
      })
      .catch(error => {
        if (mountedRef.current) {
          invalidateWorkspaceEntryRevision(path)
          setWorkspaceError(t('editor.savedRefreshFailed', { detail: errorMessage(error) }))
        }
      })
      .finally(() => finishWorkspaceMetadataSync(path, metadataSync))
  }

  async function reloadFile(path: string): Promise<void> {
    const file = openFilesRef.current.find(candidate => candidate.path === path)
    if (!file || file.saving) return
    if (file.origin === 'workspace' && workspaceMutationBlocks(path)) {
      reportWorkspaceMutationBlock()
      return
    }
    const directFile = file.origin === 'workspace' || file.origin === 'external'
    const workspaceOperation = directFile
      ? beginWorkspaceFileOperation(path, 'reload')
      : null
    if (directFile && !workspaceOperation) return
    const draftBeforeReload = file.draft
    updateFile(path, current => ({ ...current, loading: true, error: null }))
    let artifactRequestId: string | null = null
    try {
      if (file.origin === 'artifact' && file.artifact) {
        const read = beginArtifactRead(path, file.artifact)
        artifactRequestId = read.requestId
        const snapshot = await read.promise
        if (!mountedRef.current || !isCurrentArtifactRead(path, read.requestId)) return
        updateFile(path, () => openArtifactTextFile(file.artifact as AgentFile, snapshot))
        setPendingReloadPath(null)
        return
      }
      const disk = file.origin === 'external'
        ? await window.agentsDock.workspace.readAbsolute(session.id, path)
        : await window.agentsDock.workspace.read(session.id, path)
      if (
        !mountedRef.current
        || directFile
        && (!workspaceOperation || !isCurrentWorkspaceFileOperation(path, workspaceOperation))
      ) return
      updateFile(path, current => current.draft === draftBeforeReload
        ? file.origin === 'external' ? openExternalFile(disk, absoluteWritesAvailable) : openWorkspaceFile(disk)
        : {
            ...current,
            loading: false,
            error: t('editor.reloadFinishedAfterThisFileWasEditedYourLocalChangesWereKept')
          })
      setPendingReloadPath(null)
    } catch (error) {
      if (
        mountedRef.current
        && (
          artifactRequestId
            ? isCurrentArtifactRead(path, artifactRequestId)
            : Boolean(workspaceOperation && isCurrentWorkspaceFileOperation(path, workspaceOperation))
        )
        && openFilesRef.current.some(candidate => candidate.path === path)
      ) {
        updateFile(path, current => ({ ...current, loading: false, error: errorMessage(error) }))
      }
    } finally {
      if (artifactRequestId) finishArtifactRead(path, artifactRequestId)
      if (workspaceOperation) finishWorkspaceFileOperation(path, workspaceOperation)
    }
  }

  function requestUntitledSave(file: OpenWorkspaceFile, closeAfterSave = false): void {
    if (pendingUntitledSave?.saving) return
    if (closeAfterSave) setPendingClosePath(null)
    setPendingUntitledSave({
      path: file.path,
      directory: file.saveDirectory ?? '',
      name: file.name,
      saving: false,
      closeAfterSave,
      overwriteConfirmed: false,
      error: null
    })
    const directory = file.saveDirectory ?? ''
    if (!directoriesRef.current[directory]) void loadDirectory(directory)
  }

  function currentCreationAuthorityError(): string | null {
    const authority = creationAuthorityRef.current
    if (authority.archived) return t('editor.archivedChatsAreReadOnly')
    if (authority.available !== true || authority.capabilityVersion < 4) {
      return t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')
    }
    return null
  }

  async function commitUntitledSave(): Promise<void> {
    const pending = pendingUntitledSave
    if (!pending || pending.saving) return
    const file = openFilesRef.current.find(candidate => candidate.path === pending.path)
    if (!file || file.origin !== 'untitled') {
      setPendingUntitledSave(null)
      return
    }
    const nameError = workspaceEntryNameError(pending.name)
    if (nameError) {
      setPendingUntitledSave(current => current ? { ...current, error: nameError } : current)
      return
    }
    const targetPath = [pending.directory, pending.name.trim()].filter(Boolean).join('/')
    const viewerKind = workspaceFileViewerKind(targetPath)
    if (viewerKind === 'image' || viewerKind === 'pdf') {
      setPendingUntitledSave(current => current ? {
        ...current,
        error: t('editor.chooseATextOrCodeFilenameForThisEditorBuffer')
      } : current)
      return
    }
    if (openFilesRef.current.some(candidate => candidate.path === targetPath && candidate.path !== pending.path)) {
      setPendingUntitledSave(current => current ? {
        ...current,
        error: t('editor.targetAlreadyOpen', { path: targetPath })
      } : current)
      return
    }
    const initialAuthorityError = currentCreationAuthorityError()
    if (initialAuthorityError) {
      setPendingUntitledSave(current => current ? {
        ...current,
        saving: false,
        error: initialAuthorityError
      } : current)
      return
    }
    const knownTarget = directoriesRef.current[pending.directory]?.entries.find(entry => (
      entry.kind === 'file' && entry.name === pending.name.trim()
    ))
    if (knownTarget && !pending.overwriteConfirmed) {
      setPendingUntitledSave(current => current ? {
        ...current,
        overwriteConfirmed: true,
        error: t('editor.targetExists', { path: targetPath })
      } : current)
      return
    }
    if (workspaceMutationRef.current) {
      setPendingUntitledSave(current => current ? {
        ...current,
        saving: false,
        error: t('editor.waitForTheCurrentWorkspaceOperationToFinish')
      } : current)
      return
    }
    const workspaceOperation = beginWorkspaceFileOperation(pending.path, 'save')
    if (!workspaceOperation) return
    const reservation: PendingWorkspaceMutation = { kind: 'save-as', path: targetPath }
    workspaceMutationRef.current = reservation
    setWorkspaceMutationPath(targetPath)
    const draft = file.draft
    let createdTarget: WorkspaceCreateResult | null = null
    let writeCompleted = false
    const assertCreationAuthority = () => {
      const authorityError = currentCreationAuthorityError()
      if (authorityError) throw new Error(authorityError)
    }
    setPendingUntitledSave(current => current ? { ...current, saving: true, error: null } : current)
    updateFile(pending.path, current => ({ ...current, saving: true, error: null }))
    try {
      let target: WorkspaceFile
      if (pending.overwriteConfirmed) {
        assertCreationAuthority()
        target = await window.agentsDock.workspace.read(session.id, targetPath)
      } else {
        try {
          assertCreationAuthority()
          const created = await window.agentsDock.workspace.create(session.id, targetPath, 'file')
          createdTarget = created
          setWorkspaceRoot(created.root)
          if (created.file) {
            target = created.file
          } else {
            assertCreationAuthority()
            target = await window.agentsDock.workspace.read(session.id, targetPath)
          }
        } catch (createError) {
          if (createdTarget) throw createError
          assertCreationAuthority()
          try {
            await window.agentsDock.workspace.read(session.id, targetPath)
          } catch {
            throw createError
          }
          updateFile(pending.path, current => ({ ...current, saving: false }))
          setPendingUntitledSave(current => current ? {
            ...current,
            saving: false,
            overwriteConfirmed: true,
            error: t('editor.targetExists', { path: targetPath })
          } : current)
          return
        }
      }
      assertCreationAuthority()
      const saved = await window.agentsDock.workspace.write(
        session.id,
        targetPath,
        draft,
        target.revision
      )
      writeCompleted = true
      if (!mountedRef.current) return
      const currentFiles = openFilesRef.current
      const currentUntitled = currentFiles.find(candidate => candidate.path === pending.path)
      if (!currentUntitled) return
      const replacement: OpenWorkspaceFile = {
        ...openWorkspaceFile(saved),
        draft: currentUntitled.draft,
        saved: draft,
        dirty: currentUntitled.draft !== draft,
        lines: countLines(currentUntitled.draft)
      }
      const nextFiles = currentFiles.map(candidate => candidate.path === pending.path ? replacement : candidate)
      openFilesRef.current = nextFiles
      setOpenFiles(nextFiles)
      viewStatesRef.current = remapWorkspaceViewStates(viewStatesRef.current, pending.path, targetPath)
      setMarkdownViewModes(current => {
        if (!current.has(pending.path)) return current
        const next = new Map(current)
        const mode = next.get(pending.path)
        next.delete(pending.path)
        if (mode) next.set(targetPath, mode)
        markdownViewModesRef.current = next
        return next
      })
      if (activePathRef.current === pending.path) {
        activePathRef.current = targetPath
        setActivePath(targetPath)
      }
      if (secondaryPathRef.current === pending.path) {
        secondaryPathRef.current = targetPath
        setSecondaryPath(targetPath)
      }
      setPendingClosePath(current => current === pending.path ? targetPath : current)
      setPendingReloadPath(current => current === pending.path ? targetPath : current)
      setEditorNavigation(current => current?.path === pending.path ? { ...current, path: targetPath } : current)
      setWorkspaceRoot(saved.root)
      const nextExpanded = new Set(expandedDirectories)
      for (const directory of workspaceParentDirectories(targetPath)) nextExpanded.add(directory)
      reloadExplorerAfterMutation(nextExpanded, targetPath)
      setPendingUntitledSave(null)
      if (pending.closeAfterSave && currentUntitled.draft === draft) commitClose(targetPath)
    } catch (error) {
      let failure = errorMessage(error)
      if (createdTarget && !writeCompleted) {
        const createdRevision = createdTarget.entry.revision
        const canSafelyRemove = (
          createdTarget.entry.kind === 'file'
          && createdTarget.entry.path === targetPath
          && typeof createdRevision === 'string'
          && createdRevision.length > 0
        )
        if (canSafelyRemove) {
          try {
            await window.agentsDock.workspace.remove(
              session.id,
              targetPath,
              createdRevision,
              false
            )
            failure = t('editor.saveCleanupComplete', { detail: failure, path: targetPath })
          } catch (cleanupError) {
            failure = t('editor.saveCleanupFailed', { detail: failure, path: targetPath, cleanupDetail: errorMessage(cleanupError) })
          }
        } else {
          failure = t('editor.saveCleanupUnsafe', { detail: failure, path: targetPath })
        }
      }
      if (mountedRef.current) {
        updateFile(pending.path, current => ({
          ...current,
          saving: false,
          error: failure
        }))
        setPendingUntitledSave(current => current ? {
          ...current,
          saving: false,
          error: failure
        } : current)
      }
    } finally {
      finishWorkspaceFileOperation(pending.path, workspaceOperation)
      if (workspaceMutationRef.current === reservation) {
        workspaceMutationRef.current = null
        if (mountedRef.current) setWorkspaceMutationPath(null)
      }
    }
  }

  async function saveFile(
    path: string,
    options: SaveWorkspaceFileOptions = {}
  ): Promise<string | null> {
    const file = openFilesRef.current.find(candidate => candidate.path === path)
    const overwriteConflict = Boolean(
      options.overwriteConflict
      && (file?.origin === 'workspace' || file?.origin === 'external')
      && file.conflicted
    )
    if (
      !file
      || !file.loaded
      || !file.dirty
      || file.saving
      || file.loading
      || !file.writable
      || (file.conflicted && !overwriteConflict)
      || session.archived
    ) return null
    if (file.origin === 'untitled') {
      requestUntitledSave(file)
      return null
    }
    if (file.origin === 'workspace' && workspaceMutationBlocks(path)) {
      reportWorkspaceMutationBlock()
      return null
    }
    const workspaceOperation = beginWorkspaceFileOperation(path, 'save')
    if (!workspaceOperation) return null
    const draft = file.draft
    updateFile(path, current => ({ ...current, saving: true, error: null }))
    try {
      const saved = file.origin === 'external'
        ? overwriteConflict
          ? await window.agentsDock.workspace.overwriteAbsolute(session.id, path, draft)
          : await window.agentsDock.workspace.writeAbsolute(session.id, path, draft, file.revision)
        : overwriteConflict
          ? await window.agentsDock.workspace.overwrite(session.id, path, draft)
          : await window.agentsDock.workspace.write(session.id, path, draft, file.revision)
      if (!mountedRef.current) return null
      const stillCurrent = openFilesRef.current.find(current => current.path === path)?.draft === draft
      updateFile(path, current => ({
        ...current,
        ...saved,
        draft: current.draft,
        saved: draft,
        dirty: current.draft !== draft,
        saving: false,
        loading: false,
        loaded: true,
        conflicted: false,
        lines: current.lines,
        error: null
      }))
      finishWorkspaceFileOperation(path, workspaceOperation)
      if (file.origin === 'workspace') refreshWorkspaceMetadataAfterSave(path)
      return stillCurrent ? path : null
    } catch (error) {
      if (mountedRef.current) {
        const message = errorMessage(error)
        updateFile(path, current => ({
          ...current,
          saving: false,
          conflicted: current.conflicted || isWorkspaceConflictError(message),
          error: message
        }))
      }
      return null
    } finally {
      finishWorkspaceFileOperation(path, workspaceOperation)
    }
  }

  const closeFile = (path: string) => {
    const file = openFilesRef.current.find(candidate => candidate.path === path)
    if (!file || file.saving) return
    if (
      paletteOpenRef.current
      && (
        (paletteGroupRef.current === 'secondary' && secondaryPathRef.current === path)
        || (paletteGroupRef.current === 'primary' && activePathRef.current === path)
      )
    ) cancelPalette()
    if (file.dirty) {
      setPendingClosePath(path)
      return
    }
    commitClose(path)
  }

  const commitClose = (path: string) => {
    const files = openFilesRef.current
    const closingIndex = files.findIndex(file => file.path === path)
    if (closingIndex < 0) return
    if (
      paletteOpenRef.current
      && (
        (paletteGroupRef.current === 'secondary' && secondaryPathRef.current === path)
        || (paletteGroupRef.current === 'primary' && activePathRef.current === path)
      )
    ) cancelPalette()
    cancelArtifactRead(path)
    cancelWorkspaceFileRead(path)
    pendingOpenPathsRef.current.delete(path)
    const remaining = files.filter(file => file.path !== path)
    openFilesRef.current = remaining
    deleteEditorViewStates(viewStatesRef.current, path)
    setOpenFiles(remaining)
    if (activePathRef.current === path) {
      const promoted = secondaryPathRef.current && secondaryPathRef.current !== path
        ? secondaryPathRef.current
        : null
      const next = promoted ?? remaining[closingIndex]?.path ?? remaining[closingIndex - 1]?.path ?? null
      activePathRef.current = next
      setActivePath(next)
      secondaryPathRef.current = null
      setSecondaryPath(null)
      activeGroupRef.current = 'primary'
      setActiveGroup('primary')
      if (next === null) onReturnToChat?.()
    } else if (secondaryPathRef.current === path) {
      secondaryPathRef.current = null
      setSecondaryPath(null)
      activeGroupRef.current = 'primary'
      setActiveGroup('primary')
    }
    setPendingClosePath(current => current === path ? null : current)
    setPendingReloadPath(current => current === path ? null : current)
    setOpeningPath(current => current === path ? null : current)
  }

  const chatTabId = `${instanceId}-chat-tab`
  const chatPanelId = `${instanceId}-chat-panel`
  const editorPanelId = `${instanceId}-editor-panel`
  const fileActive = activePath !== null
  const editorOnly = fileActive && (filePresentation === 'full' || Boolean(onReturnToChat))
  const splitActive = fileActive && filePresentation === 'split' && !onReturnToChat
  const splitStyle = splitActive
    ? { '--workspace-editor-width': `${editorSplit.editorPercent}%` } as CSSProperties
    : undefined
  const explorerMaximum = maximumExplorerWidth(
    editorPanelWidth || undefined,
    editorSplit.explorerWidth
  )
  const effectiveExplorerWidth = clampExplorerWidth(
    editorSplit.explorerWidth,
    editorPanelWidth || undefined
  )
  const compactExplorer = editorPanelWidth > 0
    && editorPanelWidth <= COMPACT_EXPLORER_PANEL_WIDTH
  const explorerStyle = {
    '--workspace-explorer-width': `${effectiveExplorerWidth}px`
  } as CSSProperties
  const resizeSplitFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 5 : 2
    setEditorSplit(current => ({
      ...current,
      editorPercent: event.key === 'Home'
        ? MIN_EDITOR_SPLIT_PERCENT
        : event.key === 'End'
          ? MAX_EDITOR_SPLIT_PERCENT
          : clampEditorSplitPercent(
            current.editorPercent
            + (event.key === 'ArrowRight' ? 1 : -1)
            * (current.side === 'left' ? step : -step)
          )
    }))
  }
  const updateSplitFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current
    const container = splitContainerRef.current
    if (!drag || drag.pointerId !== event.pointerId || !container) return
    const bounds = container.getBoundingClientRect()
    if (bounds.width <= 0) return
    const editorPixels = editorSplit.side === 'left'
      ? event.clientX - bounds.left
      : bounds.right - event.clientX
    drag.editorPercent = clampEditorSplitPercent(editorPixels / bounds.width * 100)
    if (splitFrameRef.current !== null) return
    splitFrameRef.current = window.requestAnimationFrame(() => {
      splitFrameRef.current = null
      const latest = splitDragRef.current
      if (!latest) return
      splitTabStripRef.current?.style.setProperty('--workspace-editor-width', `${latest.editorPercent}%`)
      splitContainerRef.current?.style.setProperty('--workspace-editor-width', `${latest.editorPercent}%`)
    })
  }
  const finishSplitPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    splitDragRef.current = null
    if (splitFrameRef.current !== null) {
      window.cancelAnimationFrame(splitFrameRef.current)
      splitFrameRef.current = null
    }
    splitTabStripRef.current?.style.setProperty('--workspace-editor-width', `${drag.editorPercent}%`)
    splitContainerRef.current?.style.setProperty('--workspace-editor-width', `${drag.editorPercent}%`)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setEditorSplit(current => ({ ...current, editorPercent: drag.editorPercent }))
    setSplitDragging(false)
  }
  const resizeExplorerFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const panelWidth = editorPanelRef.current?.getBoundingClientRect().width
    const step = event.shiftKey ? 32 : 12
    setEditorSplit(current => {
      const currentEffectiveWidth = clampExplorerWidth(current.explorerWidth, panelWidth)
      return {
        ...current,
        explorerWidth: event.key === 'Home'
          ? MIN_EXPLORER_WIDTH
          : event.key === 'End'
            ? maximumExplorerWidth(panelWidth, currentEffectiveWidth)
            : clampExplorerWidth(
              currentEffectiveWidth + (event.key === 'ArrowRight' ? step : -step),
              panelWidth
            )
      }
    })
  }
  const updateExplorerFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = explorerDragRef.current
    const panel = editorPanelRef.current
    if (!drag || drag.pointerId !== event.pointerId || !panel) return
    const bounds = panel.getBoundingClientRect()
    if (bounds.width <= 0) return
    drag.width = clampExplorerWidth(event.clientX - bounds.left, bounds.width)
    if (explorerFrameRef.current !== null) return
    explorerFrameRef.current = window.requestAnimationFrame(() => {
      explorerFrameRef.current = null
      const latest = explorerDragRef.current
      if (!latest) return
      editorPanelRef.current?.style.setProperty('--workspace-explorer-width', `${latest.width}px`)
    })
  }
  const finishExplorerPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = explorerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    explorerDragRef.current = null
    if (explorerFrameRef.current !== null) {
      window.cancelAnimationFrame(explorerFrameRef.current)
      explorerFrameRef.current = null
    }
    editorPanelRef.current?.style.setProperty('--workspace-explorer-width', `${drag.width}px`)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setEditorSplit(current => ({ ...current, explorerWidth: drag.width }))
    setExplorerDragging(false)
  }
  const chatWorkspaceTab = <button
    key="chat"
    type="button"
    id={chatTabId}
    className={`workspace-editor-tab workspace-editor-chat-tab${activePath === null ? ' workspace-editor-tab-active' : ''}`}
    aria-pressed={activePath === null}
    aria-controls={chatPanelId}
    aria-label={t('editor.chatPinned')}
    title={t('editor.chat1')}
    onClick={() => {
      referenceRequestSequence.current += 1
      openRequestSequence.current += 1
      showChat()
    }}
  >
    <MessageSquare size={13} aria-hidden="true" />
    <span>{t('editor.chat')}</span>
    <span className="workspace-editor-pinned-label">{t('editor.pinned')}</span>
  </button>
  const handleFileTabWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    const tabList = event.currentTarget
    const maxScrollLeft = Math.max(0, tabList.scrollWidth - tabList.clientWidth)
    if (maxScrollLeft === 0) return
    const delta = event.deltaMode === 1
      ? event.deltaY * 32
      : event.deltaMode === 2
        ? event.deltaY * Math.max(1, tabList.clientWidth)
        : event.deltaY
    const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, tabList.scrollLeft + delta))
    if (nextScrollLeft === tabList.scrollLeft) return
    event.preventDefault()
    tabList.scrollLeft = nextScrollLeft
  }
  const fileWorkspaceTabs = <div key="files" className="workspace-editor-file-tabs">
    <div className="workspace-editor-tab-list" role="tablist" aria-label={t('editor.openFiles')} onWheel={handleFileTabWheel}>
      {openFiles.map((file, index) => {
        const dirty = file.dirty
        const selected = file.path === focusedPath
        const visible = file.path === activePath || file.path === secondaryPath
        const id = `${instanceId}-${pathToken(file.path)}-tab`
        const label = file.name || fileName(file.path)
        const title = file.displayPath || file.path
        return <div className={`workspace-editor-file-tab${selected ? ' workspace-editor-file-tab-active' : ''}${visible ? ' workspace-editor-file-tab-visible' : ''}`} key={file.path} role="presentation">
          <button
            type="button"
            id={id}
            className="workspace-editor-tab"
            role="tab"
            aria-selected={selected}
            aria-controls={editorPanelId}
            aria-label={label}
            tabIndex={selected || (activePath === null && index === 0) ? 0 : -1}
            title={index < 8 ? `${title} · ⌘${index + 2}` : title}
            onKeyDown={handleTabKeyDown}
            onClick={() => {
              if (paletteOpenRef.current) cancelPalette()
              referenceRequestSequence.current += 1
              openRequestSequence.current += 1
              activateFilePath(file.path, activeGroupRef.current)
              setPendingClosePath(null)
            }}
          >
            {file.viewerKind === 'image'
              ? <FileImage size={13} aria-hidden="true" />
              : file.viewerKind === 'pdf'
                ? <FileText size={13} aria-hidden="true" />
                : <FileCode2 size={13} aria-hidden="true" />}
            <span>{label}</span>
          </button>
          <button
            type="button"
            className="workspace-editor-close-tab"
            aria-label={dirty ? t('editor.closeUnsaved', { name: label }) : t('editor.closeNamed', { name: label })}
            title={dirty ? t('editor.closeResolveUnsaved', { name: title }) : t('editor.closeNamed', { name: title })}
            disabled={file.saving}
            onClick={() => closeFile(file.path)}
          >
            {dirty
              ? <span className="workspace-editor-dirty-dot" aria-hidden="true">●</span>
              : <X size={12} aria-hidden="true" />}
          </button>
        </div>
      })}
    </div>
    <button type="button" className="workspace-editor-command-button" onClick={() => { trackEvent('open_file_clicked'); requestOpenPalette() }}><Search size={13} aria-hidden="true" />{t('editor.openFile')}<ShortcutKey shortcut="openWorkspaceFile" /></button>
  </div>

  const renderEditorGroup = (file: OpenWorkspaceFile | null, group: EditorGroupId) => {
    const focused = activeGroup === group
    const mutationPending = Boolean(
      file?.origin === 'workspace'
      && workspaceMutationPath
      && workspacePathIsWithin(file.path, workspaceMutationPath)
    )
    const largeTextPreview = Boolean(file?.truncated)
    const markdownMode = file?.viewerKind === 'markdown'
      ? largeTextPreview ? 'source' : markdownViewModes.get(file.path) ?? 'split'
      : null
    const setMarkdownMode = (mode: MarkdownViewMode) => {
      if (!file) return
      setMarkdownViewModes(current => {
        const next = new Map(current)
        next.set(file.path, mode)
        markdownViewModesRef.current = next
        return next
      })
    }
    const sourceEditor = file && (
      <Suspense fallback={<div className="workspace-editor-loading"><LoaderCircle className="spin" size={17} /> {t('editor.loadingSyntaxHighlighting')}</div>}>
        <LazyCodeMirrorEditor
          key={`${group}:${file.path}`}
          path={file.path}
          value={file.draft}
          theme={editorAppearance.theme}
          fontSize={editorAppearance.fontSize}
          readOnly={file.saving || file.loading || mutationPending || !file.writable || Boolean(session.archived)}
          ariaLabel={t('editor.contentsOf', { name: editorContentLabel(file) })}
          maxBytes={maxEditableFileBytes}
          initialViewState={viewStatesRef.current.get(editorViewStateKey(group, file.path))}
          navigationRequest={focused && editorNavigation?.path === file.path ? editorNavigation : undefined}
          onLimitExceeded={() => updateFile(file.path, current => ({
            ...current,
            error: t('editor.editSizeLimit', { size: formatByteSize(maxEditableFileBytes) })
          }))}
          onNavigationHandled={requestId => setEditorNavigation(current => (
            current?.requestId === requestId ? null : current
          ))}
          onScrollElementChange={file.viewerKind === 'markdown'
            ? markdownSourceScrollElementCallbacks[group]
            : undefined}
          onChange={(value, lines) => {
            updateFile(file.path, current => ({
              ...current,
              draft: value,
              dirty: current.origin === 'untitled' || value !== current.saved,
              conflicted: current.conflicted && value !== current.saved,
              lines,
              error: current.conflicted && value !== current.saved ? current.error : null
            }))
          }}
          onViewStateChange={state => viewStatesRef.current.set(editorViewStateKey(group, file.path), state)}
        />
      </Suspense>
    )
    const mediaSource = file && (file.viewerKind === 'image' || file.viewerKind === 'pdf')
      ? workspaceMediaSource(file, profileScope, session.id)
      : null
    return <section
      ref={element => { editorGroupRefs.current[group] = element }}
      className={`workspace-editor-editor${focused ? ' workspace-editor-editor-focused' : ''}`}
      aria-label={group === 'primary' ? t('editor.primaryFileEditor') : t('editor.secondaryFileEditor')}
      tabIndex={-1}
      onMouseDownCapture={() => {
        activeGroupRef.current = group
        setActiveGroup(group)
      }}
      onFocusCapture={() => {
        activeGroupRef.current = group
        setActiveGroup(group)
      }}
    >
      {file
        ? <>
          <header className="workspace-editor-editor-toolbar">
            <div
              className="workspace-editor-breadcrumb"
              aria-label={t('editor.currentFile', { name: file.name || fileName(file.path) })}
              title={file.displayPath || file.path}
            >{breadcrumb(file.displayPath || file.path, file.name)}</div>
            <div className="workspace-editor-editor-actions">
              {file.viewerKind === 'markdown' && !largeTextPreview && <div className="workspace-editor-markdown-controls" role="group" aria-label={t('editor.markdownViewMode')}>
                <button type="button" aria-pressed={markdownMode === 'source'} onClick={() => setMarkdownMode('source')}><FileCode2 size={12} />{t('editor.source')}</button>
                <button type="button" aria-pressed={markdownMode === 'split'} onClick={() => setMarkdownMode('split')}><Columns2 size={12} />{t('editor.split')}</button>
                <button type="button" aria-pressed={markdownMode === 'preview'} onClick={() => setMarkdownMode('preview')}><Eye size={12} />{t('editor.preview')}</button>
              </div>}
              {file.truncated && file.artifact && <button
                type="button"
                className="workspace-editor-expand-button"
                onClick={() => {
                  void window.agentsDock.files.open(session.id, file.artifact as AgentFile).catch(error => {
                    updateFile(file.path, current => ({ ...current, error: errorMessage(error) }))
                  })
                }}
              >{t('editor.openCompleteFile')}</button>}
              {group === 'primary' && !secondaryPath && <button
                type="button"
                className="workspace-editor-expand-button"
                aria-label={t('editor.splitEditorRight')}
                title={t('editor.splitEditorRight')}
                onClick={() => {
                  secondaryPathRef.current = file.path
                  setSecondaryPath(file.path)
                  activeGroupRef.current = 'secondary'
                  setActiveGroup('secondary')
                }}
              ><Columns2 size={13} aria-hidden="true" /><span className="workspace-editor-expand-label">{t('editor.splitRight')}</span></button>}
              {group === 'secondary' && <button
                type="button"
                className="workspace-editor-expand-button"
                aria-label={t('editor.closeSecondaryEditor')}
                title={t('editor.closeSecondaryEditor')}
                onClick={() => {
                  if (paletteOpenRef.current && paletteGroupRef.current === 'secondary') cancelPalette()
                  secondaryPathRef.current = null
                  setSecondaryPath(null)
                  activeGroupRef.current = 'primary'
                  setActiveGroup('primary')
                }}
              ><PanelRightClose size={13} aria-hidden="true" /></button>}
              {focused && !editorOnly && <div className="workspace-editor-split-controls" role="group" aria-label={t('editor.editorSplitPosition')}>
                <button
                  type="button"
                  aria-pressed={editorSplit.side === 'left'}
                  className={editorSplit.side === 'left' ? 'workspace-editor-split-position-active' : ''}
                  onClick={() => setEditorSplit(current => ({ ...current, side: 'left' }))}
                >{t('editor.editorLeft')}</button>
                <button
                  type="button"
                  aria-pressed={editorSplit.side === 'right'}
                  className={editorSplit.side === 'right' ? 'workspace-editor-split-position-active' : ''}
                  onClick={() => setEditorSplit(current => ({ ...current, side: 'right' }))}
                >{t('editor.editorRight')}</button>
              </div>}
              {focused && onReturnToChat && <button
                type="button"
                className="workspace-editor-expand-button"
                aria-label={t('editor.returnToSplitChats')}
                title={t('editor.returnToSplitChats')}
                onClick={showChat}
              >
                <Minimize2 size={13} aria-hidden="true" />
                <span className="workspace-editor-expand-label">{t('editor.showChats')}</span>
              </button>}
              {focused && !onReturnToChat && <button
                type="button"
                className="workspace-editor-expand-button"
                aria-label={editorOnly ? t('editor.restoreChatSplitView') : t('editor.showFileWorkspaceFullScreen')}
                aria-pressed={editorOnly}
                title={editorOnly ? t('editor.restoreChatSplitView') : t('editor.showFileWorkspaceFullScreen')}
                onClick={() => {
                  filePresentationTouchedRef.current = true
                  setFilePresentation(current => {
                    const next = current === 'full' ? 'split' : 'full'
                    filePresentationRef.current = next
                    return next
                  })
                }}
              >
                {editorOnly
                  ? <Minimize2 size={13} aria-hidden="true" />
                  : <Maximize2 size={13} aria-hidden="true" />}
                <span className="workspace-editor-expand-label">{editorOnly ? t('editor.showChat') : t('editor.fullScreen')}</span>
              </button>}
              {(file.viewerKind === 'text' || file.viewerKind === 'markdown') && file.origin !== 'untitled' && <>
                <button
                  type="button"
                  className="workspace-editor-revert-button"
                  disabled={!file.dirty || file.saving || file.loading || !file.loaded || mutationPending}
                  onClick={() => updateFile(file.path, current => ({
                    ...current,
                    draft: current.saved,
                    dirty: false,
                    conflicted: false,
                    lines: countLines(current.saved),
                    error: null
                  }))}
                ><RotateCcw size={13} aria-hidden="true" />{t('editor.revert')}</button>
                <button
                  type="button"
                  className="workspace-editor-reload-button"
                  disabled={file.saving || file.loading || mutationPending}
                  onClick={() => file.dirty ? setPendingReloadPath(file.path) : void reloadFile(file.path)}
                ><RefreshCw size={13} aria-hidden="true" />{t('editor.reload')}</button>
              </>}
            </div>
          </header>
          {!file.loaded
            ? <div className="workspace-editor-loading">
              {file.loading && <LoaderCircle className="spin" size={17} />}
              <span>{file.error || t('editor.loadingFile')}</span>
              {!file.loading && <button type="button" onClick={() => void ensureFileLoaded(file.path)}>{t('editor.retry')}</button>}
            </div>
            : file.viewerKind === 'image'
              ? mediaSource
                ? <WorkspaceImageViewer source={mediaSource} label={editorContentLabel(file)} />
                : <div className="workspace-editor-loading">{t('editor.thisImageSourceIsUnavailable')}</div>
              : file.viewerKind === 'pdf'
                ? mediaSource
                  ? <WorkspacePdfViewer source={mediaSource} label={editorContentLabel(file)} />
                  : <div className="workspace-editor-loading">{t('editor.thisPdfSourceIsUnavailable')}</div>
                : file.viewerKind === 'markdown'
                  ? <WorkspaceMarkdownView
                    mode={markdownMode ?? 'split'}
                    sourceEditor={sourceEditor}
                    value={file.draft}
                    file={file}
                    profileScope={profileScope}
                    sessionId={session.id}
                    sourcePercent={editorSplit.markdownSourcePercent}
                    onSourcePercentChange={percent => {
                      setEditorSplit(current => ({ ...current, markdownSourcePercent: percent }))
                      window.requestAnimationFrame(() => (
                        markdownScrollSyncRef.current?.[group].syncFromSource()
                      ))
                    }}
                    previewScrollElementRef={markdownPreviewScrollElementCallbacks[group]}
                  />
                  : sourceEditor}
          <footer className="workspace-editor-status-bar">
            {(file.viewerKind === 'text' || file.viewerKind === 'markdown') && <div className="workspace-editor-appearance-controls">
              <label>{t('editor.theme')}<select aria-label={t('editor.editorColorTheme')} value={editorAppearance.theme} onChange={event => setEditorAppearance(current => writeEditorAppearance({ ...current, theme: event.target.value }))}>
                <option value="app">{t('editor.matchApp')}</option>
                {EDITOR_THEMES.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
              </select></label>
              <label>{t('editor.font')}<select aria-label={t('editor.editorFontSize')} value={editorAppearance.fontSize} onChange={event => setEditorAppearance(current => writeEditorAppearance({ ...current, fontSize: Number(event.target.value) }))}>
                {Array.from({ length: EDITOR_FONT_SIZE_MAX - EDITOR_FONT_SIZE_MIN + 1 }, (_, index) => EDITOR_FONT_SIZE_MIN + index)
                  .map(size => <option key={size} value={size}>{size}px</option>)}
              </select></label>
            </div>}
            <span>{languageLabel(file.path)}</span>
            {file.lines > 0 && <span>{t('editor.lineCount', { count: file.lines })}</span>}
            {file.truncated && <span
              className="workspace-editor-preview-warning"
              title={t('editor.theCompleteAttachmentIsNotLoadedIntoTheEditorToKeepAgentsdockResponsive')}
            >{t('editor.partialPreviewSize', { shown: formatByteSize(file.previewSize ?? utf8Bytes(file.draft)), total: formatByteSize(file.size) })}</span>}
            <span>{file.origin === 'artifact' ? t('editor.attachedSnapshot') : file.origin === 'untitled' ? t('editor.untitled') : largeTextPreview ? t('editor.largeFilePreview') : file.writable && !session.archived ? t('editor.editable') : t('editor.preview')}</span>
            {file.error && <span className="workspace-editor-file-error" title={file.error}>{file.error}</span>}
          </footer>
        </>
        : <div className="workspace-editor-empty-state"><FileText size={24} aria-hidden="true" /><strong>{t('editor.noFileIsOpen')}</strong><span>{t('editor.openHintBeforeShortcut')}<ShortcutKey shortcut="openWorkspaceFile" />{t('editor.openHintAfterShortcut')}</span></div>}
      {paletteOpen && paletteRenderGroup === group && renderFilePalette()}
    </section>
  }

  const workspaceErrorNotice = workspaceError
    ? <div className="workspace-editor-workspace-error" role="alert" aria-atomic="true"><span>{workspaceError}</span><button type="button" aria-label={t('editor.dismissWorkspaceError')} onClick={() => setWorkspaceError(null)}><X size={13} /></button></div>
    : null

  const renderFilePalette = () => <div
    ref={paletteDialogRef}
    className={`workspace-editor-palette${workspaceError ? ' workspace-editor-palette-with-alert' : ''}`}
    role="dialog"
    aria-modal="true"
    aria-label={t('editor.openWorkspaceFile')}
    onKeyDown={event => handleModalKeyDown(event, cancelPalette)}
  >
    <label className="workspace-editor-palette-search">
      <Search size={14} aria-hidden="true" />
      <span className="workspace-editor-visually-hidden">{t('editor.findAWorkspaceFile')}</span>
      <input
        ref={paletteInputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={paletteResultsId}
        aria-activedescendant={activePaletteOptionId}
        value={paletteQuery}
        onChange={event => {
          advancePaletteGeneration()
          setPaletteQuery(event.target.value)
          setPaletteIndex(0)
        }}
        onKeyDown={event => handlePaletteKeyDown(
          event,
          palettePaths,
          paletteIndex,
          setPaletteIndex,
          openPaletteFile,
          cancelPalette
        )}
        placeholder={t('editor.searchWorkspaceOrPasteAFullPath')}
      />
    </label>
    {workspaceErrorNotice}
    <div className="workspace-editor-palette-root" title={cwd}>
      <FolderOpen size={12} />{cwd || t('editor.noWorkingDirectory')}
    </div>
    <div id={paletteResultsId} className="workspace-editor-palette-results" role="listbox" aria-label={t('editor.workspaceFiles')}>
      {palettePathInput.kind === 'workspace-file' && <button
        type="button"
        role="option"
        aria-selected="true"
        aria-label={t('editor.openFullPath', { path: palettePathInput.path })}
        tabIndex={-1}
        id={`${instanceId}-file-picker-option-0`}
        key={palettePathInput.path}
        className="workspace-editor-palette-result workspace-editor-palette-result-active"
        disabled={openingPath === palettePathInput.path}
        onMouseEnter={() => setPaletteIndex(0)}
        onClick={() => openPaletteFile(palettePathInput.path)}
      >
        <FileCode2 size={13} aria-hidden="true" />
        <span>{palettePathInput.path}</span>
        <small>{t('editor.exactPath')}</small>
        {openingPath === palettePathInput.path ? <LoaderCircle className="spin" size={12} /> : <kbd>↵</kbd>}
      </button>}
      {palettePathInput.kind === 'absolute-file' && absoluteReadsAvailable && <button
        type="button"
        role="option"
        aria-selected="true"
        aria-label={t(absoluteWritesAvailable ? 'editor.openNamed' : 'editor.openReadOnly', { path: palettePathInput.path })}
        tabIndex={-1}
        id={`${instanceId}-file-picker-option-0`}
        key={palettePathInput.path}
        className="workspace-editor-palette-result workspace-editor-palette-result-active"
        disabled={openingPath === palettePathInput.path}
        onMouseEnter={() => setPaletteIndex(0)}
        onClick={() => openPaletteFile(palettePathInput.path)}
      >
        <FileCode2 size={13} aria-hidden="true" />
        <span>{palettePathInput.path}</span>
        <small>{absoluteWritesAvailable ? t('editor.fullPath') : t('editor.readOnly')}</small>
        {openingPath === palettePathInput.path ? <LoaderCircle className="spin" size={12} /> : <kbd>↵</kbd>}
      </button>}
      {palettePathInput.kind === 'search' && paletteResults.map((file, index) => <button
        type="button"
        role="option"
        aria-selected={index === paletteIndex}
        tabIndex={-1}
        id={`${instanceId}-file-picker-option-${index}`}
        key={file.path}
        className={`workspace-editor-palette-result${index === paletteIndex ? ' workspace-editor-palette-result-active' : ''}`}
        disabled={openingPath === file.path}
        onMouseEnter={() => setPaletteIndex(index)}
        onClick={() => openPaletteFile(file.path)}
      >
        <FileCode2 size={13} aria-hidden="true" />
        <span>{file.path}</span>
        {openPaths.has(file.path) && <small>{t('editor.openTab')}</small>}
        {openingPath === file.path ? <LoaderCircle className="spin" size={12} /> : index === paletteIndex && <kbd>↵</kbd>}
      </button>)}
      {paletteLoading && <p className="workspace-editor-palette-empty" role="status"><LoaderCircle className="spin" size={13} /> {t('editor.searchingWorkspace')}</p>}
      {!paletteLoading && paletteError && <p className="workspace-editor-palette-empty workspace-editor-palette-error">{paletteError}</p>}
      {!paletteLoading && !paletteError && palettePathInput.kind === 'outside-workspace' && <p className="workspace-editor-palette-empty workspace-editor-palette-error" role="status" aria-live="polite">{t('editor.thatFullPathIsOutsideThisChatSWorkingDirectory')}</p>}
      {!paletteLoading && !paletteError && palettePathInput.kind === 'absolute-file' && !absoluteReadsAvailable && <p className="workspace-editor-palette-empty workspace-editor-palette-error" role="status" aria-live="polite">{t('editor.updateAgentsserverToOpenExplicitAbsolutePathsOutsideTheWorkspace')}</p>}
      {!paletteLoading && !paletteError && palettePathInput.kind === 'search' && paletteResults.length === 0 && <p className="workspace-editor-palette-empty">{paletteTruncated ? t('editor.workspaceSearchReachedItsScanLimitPasteTheFullPathToOpenItDirectly') : t('editor.noMatchingWorkspaceFiles')}</p>}
    </div>
    <button type="button" className="workspace-editor-palette-close" aria-label={t('editor.closeFilePicker')} onClick={cancelPalette}><X size={14} aria-hidden="true" /></button>
  </div>

  return <>
    <nav
      ref={splitTabStripRef}
      className={`workspace-editor-tab-strip${splitActive ? ` workspace-editor-tab-strip-split workspace-editor-${editorSplit.side}` : ''}`}
      aria-label={t('editor.workspaceTabs')}
      style={splitStyle}
    >
      {splitActive && editorSplit.side === 'left'
        ? <>{fileWorkspaceTabs}{chatWorkspaceTab}</>
        : <>{chatWorkspaceTab}{fileWorkspaceTabs}</>}
    </nav>

    <section
      ref={splitContainerRef}
      className={`workspace-editor-content${splitActive ? ` workspace-editor-content-split workspace-editor-${editorSplit.side}${splitDragging ? ' workspace-editor-split-dragging' : ''}` : ''}${editorOnly ? ' workspace-editor-content-editor-only' : ''}`}
      style={splitStyle}
    >
      <div
        id={chatPanelId}
        className="workspace-editor-chat-panel"
        role="region"
        aria-labelledby={chatTabId}
        hidden={editorOnly}
      >{chatContent}</div>

      {splitActive && <div
        className="workspace-editor-split-handle"
        role="separator"
        aria-label={t('editor.resizeChatAndFileEditor')}
        aria-orientation="vertical"
        aria-valuemin={MIN_EDITOR_SPLIT_PERCENT}
        aria-valuemax={MAX_EDITOR_SPLIT_PERCENT}
        aria-valuenow={Math.round(editorSplit.editorPercent)}
        aria-valuetext={t('editor.editorPercent', { percent: Math.round(editorSplit.editorPercent) })}
        tabIndex={0}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.button !== 0 || event.isPrimary === false) return
          event.preventDefault()
          splitDragRef.current = {
            pointerId: event.pointerId,
            editorPercent: editorSplit.editorPercent
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
          setSplitDragging(true)
        }}
        onPointerMove={updateSplitFromPointer}
        onPointerUp={finishSplitPointer}
        onPointerCancel={finishSplitPointer}
        onLostPointerCapture={finishSplitPointer}
        onKeyDown={resizeSplitFromKeyboard}
      ><span aria-hidden="true" /></div>}

      <div
        ref={editorPanelRef}
        id={editorPanelId}
        className={`workspace-editor-editor-panel${explorerDragging ? ' workspace-editor-explorer-dragging' : ''}${compactExplorer ? ' workspace-editor-explorer-compact' : ''}`}
        role="tabpanel"
        tabIndex={-1}
        aria-labelledby={activeFile ? `${instanceId}-${pathToken(activeFile.path)}-tab` : undefined}
        hidden={activePath === null}
        style={explorerStyle}
      >
        <Explorer
          root={workspaceLabel}
          cwd={workspaceRoot}
          activePath={focusedPath}
          openPaths={openPaths}
          directories={directories}
          expanded={expandedDirectories}
          mutationsAvailable={mutationsAvailable && !workspaceMutationPath}
          creationAvailable={creationAvailable && !workspaceMutationPath}
          pendingCreate={pendingCreate}
          onOpen={path => void openFile(path)}
          onOpenToSide={openFileToSide}
          onToggle={toggleDirectory}
          onLoadMore={path => void loadDirectory(path, true)}
          onRefresh={refreshExplorer}
          onRequestCreate={(kind, target) => {
            if (kind === 'file') requestNewWorkspaceFile(target)
            else requestCreateWorkspaceEntry(kind, target)
          }}
          onCreateCommit={name => void createWorkspaceEntry(name)}
          onCreateErrorClear={() => setPendingCreate(current => (
            current?.error ? { ...current, error: null } : current
          ))}
          onCreateCancel={() => {
            if (!pendingCreate?.creating) setPendingCreate(null)
          }}
          onCopyPath={(entry, relative) => void copyWorkspaceEntryPath(entry, relative)}
          onDownload={entry => void downloadWorkspaceEntry(entry)}
          onRename={requestRenameWorkspaceEntry}
          onDelete={entry => {
            setWorkspaceError(null)
            setPendingDeleteEntry(entry)
          }}
        />
        <div
          className="workspace-editor-explorer-resize-handle"
          role="separator"
          aria-label={t('editor.resizeFileExplorer')}
          aria-orientation="vertical"
          aria-valuemin={MIN_EXPLORER_WIDTH}
          aria-valuemax={Math.round(explorerMaximum)}
          aria-valuenow={Math.round(effectiveExplorerWidth)}
          tabIndex={0}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0 || event.isPrimary === false) return
            event.preventDefault()
            explorerDragRef.current = {
              pointerId: event.pointerId,
              width: effectiveExplorerWidth
            }
            event.currentTarget.setPointerCapture?.(event.pointerId)
            setExplorerDragging(true)
          }}
          onPointerMove={updateExplorerFromPointer}
          onPointerUp={finishExplorerPointer}
          onPointerCancel={finishExplorerPointer}
          onLostPointerCapture={finishExplorerPointer}
          onKeyDown={resizeExplorerFromKeyboard}
        ><span aria-hidden="true" /></div>
        <div className={`workspace-editor-editor-groups${secondaryFile ? ' workspace-editor-editor-groups-split' : ''}`}>
          {renderEditorGroup(primaryFile, 'primary')}
          {secondaryFile && <>
            <div className="workspace-editor-group-divider" role="separator" aria-label={t('editor.editorGroupDivider')} aria-orientation="vertical" />
            {renderEditorGroup(secondaryFile, 'secondary')}
          </>}
        </div>
      </div>

      {!paletteOpen && workspaceErrorNotice}

      {paletteOpen && paletteRenderGroup === null && renderFilePalette()}

      {pendingUntitledSave && <form
        className="workspace-editor-save-picker"
        role="dialog"
        aria-modal="true"
        aria-label={t('editor.saveNamed', { name: openFiles.find(file => file.path === pendingUntitledSave.path)?.name ?? t('editor.untitledFile') })}
        onSubmit={event => {
          event.preventDefault()
          void commitUntitledSave()
        }}
        onKeyDown={event => handleModalKeyDown(event, () => {
          if (!pendingUntitledSave.saving) setPendingUntitledSave(null)
        })}
      >
        <header>
          <div><strong>{t('editor.saveAs')}</strong><span>{t('editor.chooseAFolderInThisChatSRemoteWorkspace')}</span></div>
          <button type="button" aria-label={t('editor.closeSaveAs')} disabled={pendingUntitledSave.saving} onClick={() => setPendingUntitledSave(null)}><X size={14} /></button>
        </header>
        <div className="workspace-editor-save-location" title={absoluteWorkspacePath(workspaceRoot || cwd, pendingUntitledSave.directory)}>
          <FolderOpen size={13} aria-hidden="true" />
          <span>{workspaceLabel}{pendingUntitledSave.directory ? ` / ${pendingUntitledSave.directory}` : ''}</span>
        </div>
        <div className="workspace-editor-save-browser" role="list" aria-label={t('editor.workspaceFoldersAndFiles')}>
          {pendingUntitledSave.directory && <button
            type="button"
            className="workspace-editor-save-entry"
            onClick={() => {
              const directory = workspaceParentDirectory(pendingUntitledSave.directory)
              setPendingUntitledSave(current => current ? {
                ...current,
                directory,
                overwriteConfirmed: false,
                error: null
              } : current)
              if (!directoriesRef.current[directory]) void loadDirectory(directory)
            }}
          ><FolderOpen size={13} aria-hidden="true" /><span>..</span><small>{t('editor.parentFolder')}</small></button>}
          {untitledSaveDirectory?.entries.map(entry => <button
            type="button"
            key={entry.path}
            className="workspace-editor-save-entry"
            onClick={() => {
              if (entry.kind === 'directory') {
                setPendingUntitledSave(current => current ? {
                  ...current,
                  directory: entry.path,
                  overwriteConfirmed: false,
                  error: null
                } : current)
                if (!directoriesRef.current[entry.path]) void loadDirectory(entry.path)
                return
              }
              if (entry.kind === 'file') {
                setPendingUntitledSave(current => current ? {
                  ...current,
                  name: entry.name,
                  overwriteConfirmed: false,
                  error: null
                } : current)
              }
            }}
          >
            {entry.kind === 'directory'
              ? <Folder size={13} aria-hidden="true" />
              : <FileCode2 size={13} aria-hidden="true" />}
            <span>{entry.name}</span>
            {entry.kind === 'directory' && <ChevronRight size={12} aria-hidden="true" />}
          </button>)}
          {untitledSaveDirectory?.loading && <p className="workspace-editor-tree-status"><LoaderCircle className="spin" size={12} /> {t('editor.loadingFolder')}</p>}
          {untitledSaveDirectory?.error && <p className="workspace-editor-tree-status workspace-editor-tree-error">{untitledSaveDirectory.error}</p>}
          {untitledSaveDirectory && !untitledSaveDirectory.loading && untitledSaveDirectory.entries.length < untitledSaveDirectory.total && <button
            type="button"
            className="workspace-editor-load-more"
            onClick={() => void loadDirectory(pendingUntitledSave.directory, true)}
          >{t('editor.loadMore')}</button>}
          {untitledSaveDirectory && !untitledSaveDirectory.loading && !untitledSaveDirectory.error && untitledSaveDirectory.entries.length === 0 && <p className="workspace-editor-tree-status">{t('editor.thisFolderIsEmpty')}</p>}
        </div>
        <label className="workspace-editor-save-name">
          <span>{t('editor.fileName')}</span>
          <input
            autoFocus
            value={pendingUntitledSave.name}
            disabled={pendingUntitledSave.saving}
            onFocus={event => selectWorkspaceEntryStem(event.currentTarget)}
            onChange={event => setPendingUntitledSave(current => current ? {
              ...current,
              name: event.target.value,
              overwriteConfirmed: false,
              error: null
            } : current)}
          />
        </label>
        {pendingUntitledSave.error && <p className="workspace-editor-save-error" role="alert">{pendingUntitledSave.error}</p>}
        <footer>
          <button type="button" disabled={pendingUntitledSave.saving} onClick={() => setPendingUntitledSave(null)}>{t('editor.cancel')}</button>
          <button type="submit" className="workspace-editor-confirm-save" disabled={pendingUntitledSave.saving || Boolean(workspaceEntryNameError(pendingUntitledSave.name))}>
            {pendingUntitledSave.saving
              ? t('editor.saving')
              : pendingUntitledSave.overwriteConfirmed ? t('editor.replace') : t('editor.save')}
          </button>
        </footer>
      </form>}

      {pendingCloseFile && <div className="workspace-editor-close-confirmation" role="alertdialog" aria-modal="true" aria-label={t('editor.unsavedNamed', { name: pendingCloseFile.name })} onKeyDown={event => handleModalKeyDown(event, () => setPendingClosePath(null))}>
        <div><strong>{t('editor.confirmSave', { name: pendingCloseFile.name })}</strong><span>{pendingCloseSaveMessage(pendingCloseFile, Boolean(session.archived))}</span></div>
        <button type="button" className="workspace-editor-confirm-save" disabled={!pendingCloseCanSave} onClick={() => {
          if (pendingCloseFile.origin === 'untitled') {
            requestUntitledSave(pendingCloseFile, true)
            return
          }
          void saveFile(pendingCloseFile.path, {
            overwriteConflict: pendingCloseFile.conflicted
          }).then(savedPath => { if (savedPath) commitClose(savedPath) })
        }}>
          {pendingCloseFile.saving
            ? (pendingCloseFile.conflicted ? t('editor.overwriting') : t('editor.saving'))
            : (pendingCloseFile.conflicted ? t('editor.overwriteAndClose') : t('editor.saveAndClose'))}
        </button>
        <button type="button" className="workspace-editor-confirm-discard" disabled={pendingCloseFile.saving} onClick={() => commitClose(pendingCloseFile.path)}>{t('editor.discard')}</button>
        <button type="button" className="workspace-editor-confirm-cancel" disabled={pendingCloseFile.saving} autoFocus onClick={() => setPendingClosePath(null)}>{t('editor.cancel')}</button>
      </div>}

      {pendingReloadFile && <div className="workspace-editor-close-confirmation" role="alertdialog" aria-modal="true" aria-label={t('editor.reloadNamed', { name: fileName(pendingReloadFile.path) })} onKeyDown={event => handleModalKeyDown(event, () => setPendingReloadPath(null))}>
        <div><strong>{t('editor.confirmReload', { name: fileName(pendingReloadFile.path) })}</strong><span>{t('editor.theLatestVersionWillBeReadFromTheWorkspace')}</span></div>
        <button type="button" className="workspace-editor-confirm-discard" disabled={pendingReloadFile.loading} onClick={() => void reloadFile(pendingReloadFile.path)}>{t('editor.discardAndReload')}</button>
        <button type="button" className="workspace-editor-confirm-cancel" disabled={pendingReloadFile.loading} autoFocus onClick={() => setPendingReloadPath(null)}>{t('editor.cancel')}</button>
      </div>}

      {pendingRenameEntry && <form className="workspace-editor-close-confirmation workspace-editor-entry-dialog" role="dialog" aria-modal="true" aria-label={t('editor.renameNamed', { name: pendingRenameEntry.name })} onSubmit={event => {
        event.preventDefault()
        void renameWorkspaceEntry()
      }} onKeyDown={event => handleModalKeyDown(event, () => {
        if (!renamingEntry) setPendingRenameEntry(null)
      })}>
        <div>
          <strong>{t('editor.renameNamed', { name: pendingRenameEntry.name })}</strong>
          <label className="workspace-editor-entry-name"><span className="workspace-editor-visually-hidden">{t('editor.newName')}</span><input value={renameValue} disabled={renamingEntry} autoFocus onFocus={event => selectWorkspaceEntryStem(event.currentTarget)} onChange={event => setRenameValue(event.target.value)} /></label>
        </div>
        <button type="submit" className="workspace-editor-confirm-save" disabled={renamingEntry || Boolean(workspaceEntryNameError(renameValue))}>{renamingEntry ? t('editor.renaming') : t('editor.rename')}</button>
        <button type="button" className="workspace-editor-confirm-cancel" disabled={renamingEntry} onClick={() => setPendingRenameEntry(null)}>{t('editor.cancel')}</button>
      </form>}

      {pendingDeleteEntry && <div className="workspace-editor-close-confirmation workspace-editor-entry-dialog" role="alertdialog" aria-modal="true" aria-label={t('editor.deleteNamed', { name: pendingDeleteEntry.name })} onKeyDown={event => handleModalKeyDown(event, () => {
        if (!deletingEntry) setPendingDeleteEntry(null)
      })}>
        <div>
          <strong>{t('editor.confirmDelete', { name: pendingDeleteEntry.name })}</strong>
          <span>{workspaceDeleteMessage(pendingDeleteEntry, openFiles)}</span>
        </div>
        <button type="button" className="workspace-editor-confirm-discard" disabled={deletingEntry} onClick={() => void deleteWorkspaceEntry()}>{deletingEntry ? t('editor.deleting') : t('editor.deletePermanently')}</button>
        <button type="button" className="workspace-editor-confirm-cancel" disabled={deletingEntry} autoFocus onClick={() => setPendingDeleteEntry(null)}>{t('editor.cancel')}</button>
      </div>}
    </section>
  </>
}

const Explorer = memo(function Explorer({
  root,
  cwd,
  activePath,
  openPaths,
  directories,
  expanded,
  mutationsAvailable,
  creationAvailable,
  pendingCreate,
  onOpen,
  onOpenToSide,
  onToggle,
  onLoadMore,
  onRefresh,
  onRequestCreate,
  onCreateCommit,
  onCreateErrorClear,
  onCreateCancel,
  onCopyPath,
  onDownload,
  onRename,
  onDelete
}: {
  root: string
  cwd: string
  activePath: string | null
  openPaths: Set<string>
  directories: Record<string, DirectoryState>
  expanded: Set<string>
  mutationsAvailable: boolean
  creationAvailable: boolean
  pendingCreate: PendingWorkspaceCreate | null
  onOpen: (path: string) => void
  onOpenToSide: (path: string) => void
  onToggle: (path: string) => void
  onLoadMore: (path: string) => void
  onRefresh: () => void
  onRequestCreate: (kind: WorkspaceCreateKind, target?: WorkspaceEntry | null) => void
  onCreateCommit: (name: string) => void
  onCreateErrorClear: () => void
  onCreateCancel: () => void
  onCopyPath: (entry: WorkspaceEntry, relative: boolean) => void
  onDownload: (entry: WorkspaceEntry) => void
  onRename: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
}) {
  useLocale()
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  const lastScrolledPathRef = useRef<string | null>(null)
  const [contextEntryPath, setContextEntryPath] = useState<string | null>(null)
  const entryByPath = useMemo(() => {
    const entries = new Map<string, WorkspaceEntry>()
    for (const directory of Object.values(directories)) {
      for (const entry of directory.entries) entries.set(entry.path, entry)
    }
    return entries
  }, [directories])
  const contextEntry = contextEntryPath ? entryByPath.get(contextEntryPath) ?? null : null
  useEffect(() => {
    const row = activeRowRef.current
    if (!activePath || !row) {
      lastScrolledPathRef.current = null
      return
    }
    if (lastScrolledPathRef.current === activePath) return
    row.scrollIntoView?.({ block: 'nearest' })
    lastScrolledPathRef.current = activePath
  }, [activePath, directories, expanded])
  const creationUnavailableTitle = t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')
  return <aside className="workspace-editor-explorer" aria-label={t('editor.fileExplorer')}>
    <header className="workspace-editor-explorer-header">
      <strong>{t('editor.explorer')}</strong>
      <div className="workspace-editor-explorer-actions">
        <button type="button" aria-label={t('editor.newFile')} title={creationAvailable ? t('editor.newFileN') : creationUnavailableTitle} disabled={!creationAvailable} onClick={() => onRequestCreate('file', null)}><FilePlus2 size={13} /></button>
        <button type="button" aria-label={t('editor.newFolder')} title={creationAvailable ? t('editor.newFolder115') : creationUnavailableTitle} disabled={!creationAvailable} onClick={() => onRequestCreate('directory', null)}><FolderPlus size={13} /></button>
        <button type="button" aria-label={t('editor.refreshFileExplorer')} title={t('editor.refreshExplorer')} onClick={onRefresh}><RefreshCw size={12} /></button>
      </div>
    </header>
    <div className="workspace-editor-explorer-root" title={cwd}><FolderOpen size={14} aria-hidden="true" /><strong>{root}</strong></div>
    <ContextMenu.Root onOpenChange={open => { if (!open) setContextEntryPath(null) }}>
      <ContextMenu.Trigger asChild>
        <div className="workspace-editor-tree" onContextMenuCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
          const target = event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-workspace-entry-path]')
            : null
          const path = target?.dataset.workspaceEntryPath
          if (!path || !entryByPath.has(path)) {
            setContextEntryPath('')
            return
          }
          setContextEntryPath(path)
        }}>
          <DirectoryRows
            path=""
            depth={0}
            activePath={activePath}
            openPaths={openPaths}
            directories={directories}
            expanded={expanded}
            pendingCreate={pendingCreate}
            activeRowRef={activeRowRef}
            onOpen={onOpen}
            onToggle={onToggle}
            onLoadMore={onLoadMore}
            onCreateCommit={onCreateCommit}
            onCreateErrorClear={onCreateErrorClear}
            onCreateCancel={onCreateCancel}
          />
        </div>
      </ContextMenu.Trigger>
      {contextEntry && <WorkspaceEntryContextMenu
        entry={contextEntry}
        expanded={contextEntry.kind === 'directory' ? expanded.has(contextEntry.path) : undefined}
        mutationsAvailable={mutationsAvailable}
        creationAvailable={creationAvailable}
        onOpen={contextEntry.kind === 'file'
          ? () => onOpen(contextEntry.path)
          : contextEntry.kind === 'directory'
            ? () => onToggle(contextEntry.path)
            : undefined}
        onOpenToSide={contextEntry.kind === 'file'
          ? () => onOpenToSide(contextEntry.path)
          : undefined}
        onRequestCreate={kind => onRequestCreate(kind, contextEntry)}
        onCopyPath={onCopyPath}
        onDownload={contextEntry.kind === 'file' ? () => onDownload(contextEntry) : undefined}
        onRename={onRename}
        onDelete={onDelete}
      />}
      {contextEntryPath === '' && <WorkspaceRootContextMenu
        creationAvailable={creationAvailable}
        onRequestCreate={kind => onRequestCreate(kind, null)}
        onRefresh={onRefresh}
      />}
    </ContextMenu.Root>
    <p className="workspace-editor-explorer-note">{t('editor.filesAreLoadedFromTheChatWorkingDirectoryOnAgentsserver')}</p>
  </aside>
}, (previous, next) => (
  previous.root === next.root
  && previous.cwd === next.cwd
  && previous.activePath === next.activePath
  && previous.openPaths === next.openPaths
  && previous.directories === next.directories
  && previous.expanded === next.expanded
  && previous.mutationsAvailable === next.mutationsAvailable
  && previous.creationAvailable === next.creationAvailable
  && previous.pendingCreate === next.pendingCreate
))

function DirectoryRows({
  path,
  depth,
  activePath,
  openPaths,
  directories,
  expanded,
  pendingCreate,
  activeRowRef,
  onOpen,
  onToggle,
  onLoadMore,
  onCreateCommit,
  onCreateErrorClear,
  onCreateCancel
}: {
  path: string
  depth: number
  activePath: string | null
  openPaths: Set<string>
  directories: Record<string, DirectoryState>
  expanded: Set<string>
  pendingCreate: PendingWorkspaceCreate | null
  activeRowRef: RefObject<HTMLButtonElement | null>
  onOpen: (path: string) => void
  onToggle: (path: string) => void
  onLoadMore: (path: string) => void
  onCreateCommit: (name: string) => void
  onCreateErrorClear: () => void
  onCreateCancel: () => void
}) {
  useLocale()
  const directory = directories[path]
  if (!directory) return <p className="workspace-editor-tree-status"><LoaderCircle className="spin" size={12} /> {t('editor.loadingFiles')}</p>
  if (directory.error) return <p className="workspace-editor-tree-status workspace-editor-tree-error">{directory.error}</p>
  return <>
    {pendingCreate?.directory === path && <WorkspaceCreateRow
      key={`${pendingCreate.directory}\0${pendingCreate.kind}`}
      depth={depth}
      pending={pendingCreate}
      onCommit={onCreateCommit}
      onErrorClear={onCreateErrorClear}
      onCancel={onCreateCancel}
    />}
    {directory.entries.map(entry => {
      if (entry.kind === 'directory') {
        const open = expanded.has(entry.path)
        return <div key={entry.path}>
          <button type="button" data-workspace-entry-path={entry.path} className="workspace-editor-tree-row workspace-editor-folder" style={{ paddingLeft: `${8 + depth * 13}px` }} title={entry.path} aria-expanded={open} onClick={() => onToggle(entry.path)}>
            <ChevronRight className={open ? 'workspace-editor-chevron-open' : ''} size={12} aria-hidden="true" />
            <Folder size={13} aria-hidden="true" />
            <span>{entry.name}</span>
          </button>
          {open && <DirectoryRows path={entry.path} depth={depth + 1} activePath={activePath} openPaths={openPaths} directories={directories} expanded={expanded} pendingCreate={pendingCreate} activeRowRef={activeRowRef} onOpen={onOpen} onToggle={onToggle} onLoadMore={onLoadMore} onCreateCommit={onCreateCommit} onCreateErrorClear={onCreateErrorClear} onCreateCancel={onCreateCancel} />}
        </div>
      }
      if (entry.kind === 'symlink') {
        return <div key={entry.path} data-workspace-entry-path={entry.path} className="workspace-editor-tree-row workspace-editor-symlink" style={{ paddingLeft: `${21 + depth * 13}px` }} title={t('editor.symlinkUnavailable', { path: entry.path })}><Link2 size={12} /><span>{entry.name}</span></div>
      }
      const active = activePath === entry.path
      return <button
        ref={active ? activeRowRef : undefined}
        type="button"
        key={entry.path}
        data-workspace-entry-path={entry.path}
        className={`workspace-editor-tree-row workspace-editor-tree-file${active ? ' workspace-editor-tree-file-active' : ''}`}
        style={{ paddingLeft: `${21 + depth * 13}px` }}
        title={entry.path}
        aria-label={t('editor.openNamed', { path: entry.path })}
        aria-current={active ? 'page' : undefined}
        onClick={() => onOpen(entry.path)}
      ><FileCode2 size={13} aria-hidden="true" /><span>{entry.name}</span>{openPaths.has(entry.path) && <span className="workspace-editor-open-mark" aria-label={t('editor.openState')}>•</span>}</button>
    })}
    {directory.loading && <p className="workspace-editor-tree-status"><LoaderCircle className="spin" size={12} /> {t('editor.loading')}</p>}
    {!directory.loading && directory.entries.length < directory.total && <button type="button" className="workspace-editor-load-more" onClick={() => onLoadMore(path)}>{t('editor.loadMore')}</button>}
  </>
}

function WorkspaceCreateRow({
  depth,
  pending,
  onCommit,
  onErrorClear,
  onCancel
}: {
  depth: number
  pending: PendingWorkspaceCreate
  onCommit: (name: string) => void
  onErrorClear: () => void
  onCancel: () => void
}) {
  useLocale()
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const Icon = pending.kind === 'directory' ? Folder : FileCode2
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('agentsdock:focus-pending-create', focus)
    return () => window.removeEventListener('agentsdock:focus-pending-create', focus)
  }, [])
  return <form
    className="workspace-editor-create-row"
    style={{ paddingLeft: `${21 + depth * 13}px` }}
    onSubmit={event => {
      event.preventDefault()
      onCommit(name)
    }}
  >
    <Icon size={13} aria-hidden="true" />
    <div>
      <input
        ref={inputRef}
        value={name}
        disabled={pending.creating}
        autoFocus
        aria-label={pending.kind === 'directory' ? t('editor.newFolderName') : t('editor.newFileName')}
        placeholder={pending.kind === 'directory' ? 'folder name' : 'file name'}
        onChange={event => {
          setName(event.target.value)
          if (pending.error) onErrorClear()
        }}
        onKeyDown={event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }}
      />
      {pending.error && <span role="alert">{pending.error}</span>}
    </div>
    {pending.creating && <LoaderCircle className="spin" size={12} aria-label={t('editor.creating')} />}
  </form>
}

function WorkspaceEntryContextMenu({
  entry,
  expanded,
  mutationsAvailable,
  creationAvailable,
  onOpen,
  onOpenToSide,
  onRequestCreate,
  onCopyPath,
  onDownload,
  onRename,
  onDelete,
}: {
  entry: WorkspaceEntry
  expanded?: boolean
  mutationsAvailable: boolean
  creationAvailable: boolean
  onOpen?: () => void
  onOpenToSide?: () => void
  onRequestCreate: (kind: WorkspaceCreateKind) => void
  onCopyPath: (entry: WorkspaceEntry, relative: boolean) => void
  onDownload?: () => void
  onRename: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
}) {
  useLocale()
  const canMutate = mutationsAvailable && Boolean(entry.revision)
  return <ContextMenu.Portal>
    <ContextMenu.Content className="menu-content workspace-editor-tree-menu">
      <ContextMenu.Item className="menu-item" title={creationAvailable ? undefined : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')} disabled={!creationAvailable} onSelect={() => onRequestCreate('file')}><FilePlus2 size={14} aria-hidden="true" />{t('editor.newFile125')}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item" title={creationAvailable ? undefined : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')} disabled={!creationAvailable} onSelect={() => onRequestCreate('directory')}><FolderPlus size={14} aria-hidden="true" />{t('editor.newFolder126')}</ContextMenu.Item>
      <ContextMenu.Separator className="menu-separator" />
      {onOpen && <ContextMenu.Item className="menu-item" onSelect={onOpen}>
        {entry.kind === 'directory'
          ? <FolderOpen size={14} aria-hidden="true" />
          : <FileCode2 size={14} aria-hidden="true" />}
        {entry.kind === 'directory' ? (expanded ? t('editor.collapseFolder') : t('editor.expandFolder')) : t('editor.open')}
      </ContextMenu.Item>}
      {onOpenToSide && <ContextMenu.Item className="menu-item" onSelect={onOpenToSide}>
        <Columns2 size={14} aria-hidden="true" />
        {t('editor.openToTheSide')}</ContextMenu.Item>}
      {onDownload && <ContextMenu.Item className="menu-item" onSelect={onDownload}>
        <Download size={14} aria-hidden="true" />
        {t('editor.download')}</ContextMenu.Item>}
      {onOpen && <ContextMenu.Separator className="menu-separator" />}
      <ContextMenu.Item className="menu-item" onSelect={() => onCopyPath(entry, false)}><Copy size={14} aria-hidden="true" />{t('editor.copyPath')}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item" onSelect={() => onCopyPath(entry, true)}><Copy size={14} aria-hidden="true" />{t('editor.copyRelativePath')}</ContextMenu.Item>
      <ContextMenu.Separator className="menu-separator" />
      <ContextMenu.Item className="menu-item" disabled={!canMutate} onSelect={() => onRename(entry)}><Pencil size={14} aria-hidden="true" />{t('editor.rename133')}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item danger" disabled={!canMutate} onSelect={() => onDelete(entry)}><Trash2 size={14} aria-hidden="true" />{t('editor.deletePermanently134')}</ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
}

function WorkspaceRootContextMenu({
  creationAvailable,
  onRequestCreate,
  onRefresh
}: {
  creationAvailable: boolean
  onRequestCreate: (kind: WorkspaceCreateKind) => void
  onRefresh: () => void
}) {
  useLocale()
  return <ContextMenu.Portal>
    <ContextMenu.Content className="menu-content workspace-editor-tree-menu">
      <ContextMenu.Item className="menu-item" title={creationAvailable ? undefined : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')} disabled={!creationAvailable} onSelect={() => onRequestCreate('file')}><FilePlus2 size={14} aria-hidden="true" />{t('editor.newFile135')}</ContextMenu.Item>
      <ContextMenu.Item className="menu-item" title={creationAvailable ? undefined : t('editor.updateAgentsserverToCreateWorkspaceFilesAndFolders')} disabled={!creationAvailable} onSelect={() => onRequestCreate('directory')}><FolderPlus size={14} aria-hidden="true" />{t('editor.newFolder136')}</ContextMenu.Item>
      <ContextMenu.Separator className="menu-separator" />
      <ContextMenu.Item className="menu-item" onSelect={onRefresh}><RefreshCw size={14} aria-hidden="true" />{t('editor.refreshExplorer')}</ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
}

function handlePaletteKeyDown(
  event: ReactKeyboardEvent<HTMLInputElement>,
  paths: string[],
  selectedIndex: number,
  selectIndex: (index: number) => void,
  openFile: (path: string) => void,
  close: () => void
) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && paths.length > 0) {
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    selectIndex((selectedIndex + direction + paths.length) % paths.length)
  } else if (event.key === 'Enter' && paths[selectedIndex]) {
    event.preventDefault()
    openFile(paths[selectedIndex])
  }
}

function handleModalKeyDown<T extends HTMLElement>(event: ReactKeyboardEvent<T>, close: () => void): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ))
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function pendingCloseSaveMessage(file: OpenWorkspaceFile, archived = false): string {
  if (archived || !file.writable) return t('editor.thisWorkspaceIsReadOnlyDiscardTheDraftOrCancelClosing')
  if (!file.loaded) return t('editor.theFileHasNotFinishedLoadingWaitDiscardTheDraftOrCancelClosing')
  if (file.error) return file.error
  if (file.conflicted) return t('editor.theFileChangedOnDiskOverwriteItWithThisDraftDiscardTheDraftOrCancelClosing')
  return t('editor.theFileHasUnsavedEditsInThisChatWorkspace')
}

function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabList = event.currentTarget.closest('[role="tablist"]')
  const tabs = tabList ? Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')) : []
  const current = tabs.indexOf(event.currentTarget)
  if (current < 0 || tabs.length === 0) return
  event.preventDefault()
  const next = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}

function openWorkspaceFile(file: WorkspaceFile): OpenWorkspaceFile {
  return {
    ...file,
    origin: 'workspace',
    viewerKind: workspaceFileViewerKind(file.path),
    draft: file.content,
    saved: file.content,
    dirty: false,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: countLines(file.content),
    error: null
  }
}

function openExternalFile(file: WorkspaceFile, writesAvailable = false): OpenWorkspaceFile {
  const inferredViewer = workspaceFileViewerKind(file.path)
  return {
    ...file,
    writable: writesAvailable && file.writable === true,
    scope: 'absolute',
    origin: 'external',
    viewerKind: inferredViewer === 'markdown' ? 'markdown' : 'text',
    displayPath: file.path,
    draft: file.content,
    saved: file.content,
    dirty: false,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: countLines(file.content),
    error: null
  }
}

function openUntitledFile(
  root: string,
  path: string,
  name: string,
  saveDirectory: string,
  draft = '',
  dirty = true
): OpenWorkspaceFile {
  return {
    root,
    path,
    name,
    content: draft,
    revision: '',
    size: utf8Bytes(draft),
    mtime_ns: 0,
    writable: true,
    origin: 'untitled',
    viewerKind: 'text',
    displayPath: name,
    saveDirectory,
    draft,
    saved: '',
    dirty,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: countLines(draft),
    error: null
  }
}

function openArtifactTextFile(file: AgentFile, snapshot: AgentTextFile): OpenWorkspaceFile {
  const viewerKind = internalFileViewerKind(file)
  return {
    root: t('editor.agentsdockArtifacts'),
    path: artifactTabPath(file),
    name: snapshot.filename,
    content: '',
    revision: snapshot.revision,
    size: snapshot.size,
    mtime_ns: 0,
    writable: false,
    origin: 'artifact',
    viewerKind: viewerKind === 'markdown' ? 'markdown' : 'text',
    artifact: file,
    displayPath: file.source_path || file.title || snapshot.filename,
    draft: snapshot.content,
    saved: '',
    dirty: false,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: countLines(snapshot.content),
    error: null,
    previewSize: snapshot.preview_size,
    truncated: snapshot.truncated
  }
}

function loadingArtifactTextFile(file: AgentFile): OpenWorkspaceFile {
  const viewerKind = internalFileViewerKind(file)
  return {
    root: t('editor.agentsdockArtifacts'),
    path: artifactTabPath(file),
    name: file.filename,
    content: '',
    revision: '',
    size: file.size ?? 0,
    mtime_ns: 0,
    writable: false,
    origin: 'artifact',
    viewerKind: viewerKind === 'markdown' ? 'markdown' : 'text',
    artifact: file,
    displayPath: file.source_path || file.title || file.filename,
    draft: '',
    saved: '',
    dirty: false,
    saving: false,
    loading: true,
    loaded: false,
    conflicted: false,
    lines: 1,
    error: null
  }
}

function restoredWorkspaceFile(cwd: string, tab: PersistedTab): OpenWorkspaceFile {
  const viewerKind = workspaceFileViewerKind(tab.path)
  if (viewerKind === 'image' || viewerKind === 'pdf') {
    return openWorkspacePreviewFile(cwd, tab.path, viewerKind)
  }
  const hasDraft = typeof tab.draft === 'string'
  const draft = tab.draft ?? ''
  return {
    root: cwd,
    path: tab.path,
    name: fileName(tab.path),
    content: '',
    revision: tab.revision ?? '',
    size: utf8Bytes(draft),
    mtime_ns: 0,
    writable: false,
    origin: 'workspace',
    viewerKind,
    draft,
    saved: '',
    dirty: hasDraft,
    saving: false,
    loading: false,
    loaded: false,
    conflicted: false,
    lines: countLines(draft),
    error: null
  }
}

function restoredExternalFile(tab: PersistedTab): OpenWorkspaceFile {
  const viewerKind = workspaceFileViewerKind(tab.path)
  const hasDraft = typeof tab.draft === 'string'
  const draft = tab.draft ?? ''
  return {
    root: '',
    path: tab.path,
    name: fileName(tab.path),
    content: '',
    revision: tab.revision ?? '',
    size: utf8Bytes(draft),
    mtime_ns: 0,
    writable: false,
    scope: 'absolute',
    origin: 'external',
    viewerKind: viewerKind === 'markdown' ? 'markdown' : 'text',
    displayPath: tab.path,
    draft,
    saved: '',
    dirty: hasDraft,
    saving: false,
    loading: false,
    loaded: false,
    conflicted: false,
    lines: countLines(draft),
    error: null
  }
}

function restoredUntitledFile(cwd: string, tab: PersistedTab): OpenWorkspaceFile {
  const name = tab.name?.trim() || fileName(tab.path) || t('editor.untitled')
  return openUntitledFile(
    cwd,
    tab.path,
    name,
    tab.saveDirectory ?? '',
    tab.draft ?? '',
    tab.dirty ?? true
  )
}

function restoredArtifactFile(file: AgentFile): OpenWorkspaceFile {
  const viewerKind = internalFileViewerKind(file)
  if (viewerKind === 'image' || viewerKind === 'pdf') return openArtifactPreviewFile(file, viewerKind)
  return {
    ...loadingArtifactTextFile(file),
    loading: false
  }
}

function openWorkspacePreviewFile(
  root: string,
  path: string,
  viewerKind: 'image' | 'pdf',
  entry?: WorkspaceEntry
): OpenWorkspaceFile {
  return {
    root,
    path,
    name: fileName(path),
    content: '',
    revision: entry?.revision ?? '',
    size: entry?.size ?? 0,
    mtime_ns: entry?.mtime_ns ?? 0,
    writable: false,
    origin: 'workspace',
    viewerKind,
    draft: '',
    saved: '',
    dirty: false,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: 0,
    error: null
  }
}

function openArtifactPreviewFile(file: AgentFile, viewerKind: 'image' | 'pdf'): OpenWorkspaceFile {
  return {
    root: t('editor.agentsdockArtifacts'),
    path: artifactTabPath(file),
    name: file.filename,
    content: '',
    revision: '',
    size: file.size ?? 0,
    mtime_ns: 0,
    writable: false,
    origin: 'artifact',
    viewerKind,
    artifact: file,
    displayPath: file.source_path || file.title || file.filename,
    draft: '',
    saved: '',
    dirty: false,
    saving: false,
    loading: false,
    loaded: true,
    conflicted: false,
    lines: 0,
    error: null
  }
}

function workspaceFileViewerKind(path: string): Exclude<InternalFileViewerKind, 'unsupported'> {
  const kind = internalFileViewerKind({ filename: fileName(path), content_type: null })
  return kind === 'unsupported' ? 'text' : kind
}

function workspaceEntryForPath(
  directories: Record<string, DirectoryState>,
  path: string
): WorkspaceEntry | undefined {
  for (const directory of Object.values(directories)) {
    const entry = directory.entries.find(candidate => candidate.path === path)
    if (entry) return entry
  }
  return undefined
}

export function mergeWorkspacePaletteEntries(
  openEntries: WorkspaceEntry[],
  knownEntries: WorkspaceEntry[],
  remoteEntries: WorkspaceEntry[],
  query: string,
  focusedPath: string | null,
  limit = 100
): WorkspaceEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const orderedOpenEntries = [...openEntries].sort((left, right) => (
    Number(right.path === focusedPath) - Number(left.path === focusedPath)
  ))
  const seen = new Set<string>()
  const matches: WorkspaceEntry[] = []
  for (const entry of [...orderedOpenEntries, ...remoteEntries, ...knownEntries]) {
    if (entry.kind !== 'file' || seen.has(entry.path)) continue
    const searchable = `${entry.name}\n${entry.path}`.toLocaleLowerCase()
    if (normalizedQuery && !searchable.includes(normalizedQuery)) continue
    seen.add(entry.path)
    matches.push(entry)
    if (matches.length >= limit) break
  }
  return matches
}

function mergeOpenWorkspaceFiles(base: OpenWorkspaceFile[], preferred: OpenWorkspaceFile[]): OpenWorkspaceFile[] {
  // A persisted restore can resolve after the user has already opened or
  // created files. Keep every live tab ahead of restored metadata so the
  // MAX_OPEN_TABS cap can never evict a current dirty/untitled buffer.
  const byPath = new Map(preferred.map(file => [file.path, file]))
  for (const file of base) {
    if (!byPath.has(file.path)) byPath.set(file.path, file)
  }
  return [...byPath.values()].slice(0, MAX_OPEN_TABS)
}

function compactWorkspaceFiles(
  files: OpenWorkspaceFile[],
  activePath: string | null,
  secondaryPath: string | null
): OpenWorkspaceFile[] {
  return files.map(file => {
    if (file.path === activePath || file.path === secondaryPath || file.dirty) {
      return { ...file, saving: false, loading: false }
    }
    return {
      ...file,
      content: '',
      draft: '',
      saved: '',
      saving: false,
      loading: false,
      loaded: false,
      conflicted: false,
      lines: 1,
      error: null
    }
  })
}

function trimWorkspaceMemory(): void {
  const bytes = () => [...workspaceMemory.values()].reduce((total, workspace) => (
    total + workspace.openFiles.reduce((fileTotal, file) => (
      fileTotal + (file.content.length + file.draft.length + file.saved.length) * 2
    ), 0)
  ), 0)
  while ((workspaceMemory.size > 8 || bytes() > MAX_MEMORY_BYTES) && workspaceMemory.size > 1) {
    workspaceMemory.delete(workspaceMemory.keys().next().value as string)
  }
}

function persistedWorkspaceState(
  cwd: string,
  activePath: string | null,
  secondaryPath: string | null,
  activeGroup: EditorGroupId,
  filePresentation: FilePresentation,
  files: OpenWorkspaceFile[],
  viewStates: ReadonlyMap<string, CodeMirrorViewState>,
  markdownViewModes: ReadonlyMap<string, MarkdownViewMode>
): PersistedWorkspaceState {
  // Absolute tabs originate only from an explicit path open. Persist their
  // per-chat identity (and dirty draft) so switching chats cannot discard an
  // edit; restore still revalidates the exact path through readAbsolute.
  const persistedFiles = files.slice(0, MAX_OPEN_TABS)
  const tabs = persistedFiles.map<PersistedTab>(file => {
    const viewState = viewStates.get(editorViewStateKey('primary', file.path))
    const secondaryViewState = viewStates.get(editorViewStateKey('secondary', file.path))
    const editorState = {
      ...(viewState ? { viewState } : {}),
      ...(secondaryViewState ? { secondaryViewState } : {}),
      ...(isMarkdownViewMode(markdownViewModes.get(file.path))
        ? { markdownViewMode: markdownViewModes.get(file.path) }
        : {})
    }
    if (file.origin === 'artifact') {
      return {
        path: file.path,
        artifact: file.artifact,
        ...editorState
      }
    }
    if (file.origin === 'untitled') {
      return {
        path: file.path,
        untitled: true,
        name: file.name,
        saveDirectory: file.saveDirectory ?? '',
        draft: file.draft,
        dirty: file.dirty,
        ...editorState
      }
    }
    if (file.origin === 'external') {
      return file.dirty
        ? { path: file.path, external: true, revision: file.revision, draft: file.draft, ...editorState }
        : { path: file.path, external: true, ...editorState }
    }
    return file.dirty
      ? { path: file.path, revision: file.revision, draft: file.draft, ...editorState }
      : { path: file.path, ...editorState }
  })
  const persistedActivePath = activePath && persistedFiles.some(file => file.path === activePath)
    ? activePath
    : null
  const persistedSecondaryPath = secondaryPath && persistedFiles.some(file => file.path === secondaryPath)
    ? secondaryPath
    : null
  return {
    version: 5,
    cwd,
    activePath: persistedActivePath,
    secondaryPath: persistedSecondaryPath,
    activeGroup: activeGroup === 'secondary' && persistedSecondaryPath ? 'secondary' : 'primary',
    filePresentation,
    tabs
  }
}

function normalizePersistedWorkspaceState(
  state: PersistedWorkspaceState | LegacyPersistedWorkspaceState
): PersistedWorkspaceState {
  if (state.version === 5) return state
  if (state.version === 4) {
    return {
      version: 5,
      cwd: state.cwd,
      activePath: state.activePath,
      secondaryPath: state.secondaryPath ?? null,
      activeGroup: state.activeGroup === 'secondary' && state.secondaryPath ? 'secondary' : 'primary',
      filePresentation: state.filePresentation ?? 'full',
      tabs: state.tabs
    }
  }
  if (state.version === 3) {
    return {
      version: 5,
      cwd: state.cwd,
      activePath: state.activePath,
      secondaryPath: state.secondaryPath ?? null,
      activeGroup: state.activeGroup === 'secondary' && state.secondaryPath ? 'secondary' : 'primary',
      filePresentation: 'full',
      tabs: state.tabs
    }
  }
  return {
    version: 5,
    cwd: state.cwd,
    activePath: state.activePath,
    secondaryPath: null,
    activeGroup: 'primary',
    filePresentation: 'full',
    tabs: state.tabs.filter(tab => !tab.path.startsWith('.agentsdock-artifacts/') || Boolean(tab.artifact))
  }
}

function workspacePersistenceTarget(scope: WorkspaceProfileScope, preferenceKey: string): string {
  return [
    scope.profileId,
    scope.profileGeneration,
    scope.serverIdentity ?? '',
    preferenceKey
  ].join('\0')
}

function equalPersistedWorkspaceState(
  previous: PersistedWorkspaceState,
  next: PersistedWorkspaceState
): boolean {
  if (
    previous.cwd !== next.cwd
    || previous.activePath !== next.activePath
    || previous.secondaryPath !== next.secondaryPath
    || previous.activeGroup !== next.activeGroup
    || previous.filePresentation !== next.filePresentation
    || previous.tabs.length !== next.tabs.length
  ) return false
  return previous.tabs.every((tab, index) => {
    const candidate = next.tabs[index]
    return (
      tab.path === candidate?.path
      && equalAgentFileReference(tab.artifact, candidate.artifact)
      && tab.untitled === candidate.untitled
      && tab.name === candidate.name
      && tab.saveDirectory === candidate.saveDirectory
      && tab.dirty === candidate.dirty
      && tab.revision === candidate.revision
      && tab.draft === candidate.draft
      && tab.markdownViewMode === candidate.markdownViewMode
      && equalCodeMirrorViewState(tab.viewState, candidate.viewState)
      && equalCodeMirrorViewState(tab.secondaryViewState, candidate.secondaryViewState)
    )
  })
}

function equalAgentFileReference(previous: AgentFile | undefined, next: AgentFile | undefined): boolean {
  return previous === next || Boolean(
    previous
    && next
    && previous.id === next.id
    && previous.filename === next.filename
    && previous.path === next.path
    && previous.source_path === next.source_path
    && previous.content_type === next.content_type
    && previous.size === next.size
    && previous.title === next.title
  )
}

function equalCodeMirrorViewState(
  previous: CodeMirrorViewState | undefined,
  next: CodeMirrorViewState | undefined
): boolean {
  return previous === next || Boolean(
    previous
    && next
    && previous.anchor === next.anchor
    && previous.head === next.head
    && previous.scrollTop === next.scrollTop
    && previous.scrollLeft === next.scrollLeft
    && equalFoldState(previous, next)
  )
}

function equalFoldState(
  previous: CodeMirrorViewState,
  next: CodeMirrorViewState
): boolean {
  const previousRanges = previous.folds ?? []
  const nextRanges = next.folds ?? []
  return previousRanges.length === nextRanges.length
    && (previousRanges.length === 0 || previous.foldDocument === next.foldDocument)
    && previousRanges.every((range, index) => (
      range.from === nextRanges[index]?.from && range.to === nextRanges[index]?.to
    ))
}

function mergeWorkspaceEntries(current: WorkspaceEntry[], incoming: WorkspaceEntry[]): WorkspaceEntry[] {
  const byPath = new Map(current.map(entry => [entry.path, entry]))
  for (const entry of incoming) byPath.set(entry.path, entry)
  return [...byPath.values()]
}

function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const kindOrder: Record<WorkspaceEntry['kind'], number> = {
    directory: 0,
    file: 1,
    symlink: 2
  }
  return [...entries].sort((left, right) => (
    kindOrder[left.kind] - kindOrder[right.kind]
    || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  ))
}

export function workspaceParentDirectories(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}

function workspaceParentDirectory(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator < 0 ? '' : path.slice(0, separator)
}

function workspaceRevealSteps(path: string): Array<{ directory: string; child: string }> {
  const parts = path.split('/').filter(Boolean)
  return parts.map((_, index) => ({
    directory: parts.slice(0, index).join('/'),
    child: parts.slice(0, index + 1).join('/')
  }))
}

function equalStringSets(previous: Set<string>, next: Set<string>): boolean {
  return previous.size === next.size && [...previous].every(value => next.has(value))
}

function workspacePathIsWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`)
}

function editorViewStateKey(group: EditorGroupId, path: string): string {
  return `${group}\0${path}`
}

function parseEditorViewStateKey(key: string): { group: EditorGroupId; path: string } | null {
  const separator = key.indexOf('\0')
  if (separator < 0) return null
  const group = key.slice(0, separator)
  const path = key.slice(separator + 1)
  return (group === 'primary' || group === 'secondary') && path
    ? { group, path }
    : null
}

function deleteEditorViewStates(
  states: Map<string, CodeMirrorViewState>,
  path: string
): void {
  states.delete(path)
  states.delete(editorViewStateKey('primary', path))
  states.delete(editorViewStateKey('secondary', path))
}

function remapWorkspacePath(path: string, previousPath: string, nextPath: string): string {
  return path === previousPath ? nextPath : `${nextPath}${path.slice(previousPath.length)}`
}

function remapWorkspaceExpandedPaths(
  expanded: Set<string>,
  previousPath: string,
  nextPath: string
): Set<string> {
  return new Set([...expanded].map(path => (
    workspacePathIsWithin(path, previousPath)
      ? remapWorkspacePath(path, previousPath, nextPath)
      : path
  )))
}

function remapWorkspaceViewStates(
  current: Map<string, CodeMirrorViewState>,
  previousPath: string,
  nextPath: string
): Map<string, CodeMirrorViewState> {
  return new Map([...current].map(([key, state]) => {
    const parsed = parseEditorViewStateKey(key)
    const path = parsed?.path ?? key
    const next = workspacePathIsWithin(path, previousPath)
      ? remapWorkspacePath(path, previousPath, nextPath)
      : path
    return [
      parsed ? editorViewStateKey(parsed.group, next) : next,
    state
    ]
  }))
}

export function absoluteWorkspacePath(root: string, relativePath: string): string {
  if (!root) return relativePath
  const windows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')
  const separator = windows ? '\\' : '/'
  const normalizedRelative = windows ? relativePath.replace(/\//g, '\\') : relativePath
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  if (!trimmedRoot && root.startsWith('/')) return `/${normalizedRelative}`
  return `${trimmedRoot}${separator}${normalizedRelative}`
}

function workspaceEntryNameError(name: string): string | null {
  if (!name.trim()) return t('editor.enterAFileOrFolderName')
  if (name === '.' || name === '..') return t('editor.thatNameIsReserved')
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return t('editor.namesCannotContainSlashes')
  }
  return null
}

function selectWorkspaceEntryStem(input: HTMLInputElement): void {
  const dot = input.value.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
}

function workspaceDeleteMessage(entry: WorkspaceEntry, files: OpenWorkspaceFile[]): string {
  const affected = files.filter(file => (
    file.origin === 'workspace' && workspacePathIsWithin(file.path, entry.path)
  ))
  const dirty = affected.filter(file => file.dirty).length
  if (dirty > 0) {
    return t(dirty === 1 ? 'editor.deleteDirtyFile' : 'editor.deleteDirtyFiles', { count: dirty })
  }
  if (entry.kind === 'directory') {
    return t('editor.thisPermanentlyDeletesTheFolderAndEverythingInsideItOnAgentsserver')
  }
  return t('editor.thisPermanentlyDeletesTheFileOnAgentsserverThisCannotBeUndone')
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function logWorkspaceFile(message: string, data: Record<string, unknown>): void {
  try {
    const request = window.agentsDock?.native?.log?.('workspace-file', message, data)
    void request?.catch(() => undefined)
  } catch {
    // Diagnostics must never affect file access.
  }
}

function isWorkspaceConflictError(message: string): boolean {
  return /workspace_file_conflict|changed (?:on disk|while it was being saved)|reload (?:it )?before saving/i.test(message)
}

function fileName(path: string): string {
  return path.split('/').at(-1) || path
}

function editorContentLabel(file: OpenWorkspaceFile): string {
  return file.origin === 'workspace' || file.origin === 'external' ? file.path : file.name
}

function artifactTabPath(file: AgentFile): string {
  const name = file.filename.split(/[\\/]/).at(-1) || 'artifact'
  return `.agentsdock-artifacts/${file.id}/${name}`
}

function workspaceMediaSource(
  file: OpenWorkspaceFile,
  scope: WorkspaceProfileScope | null,
  sessionId: string
): string | null {
  if (!scope) return null
  try {
    if (file.origin === 'artifact') {
      return file.artifact
        ? window.agentsDock.files.mediaURL(
          scope.profileId,
          scope.profileGeneration,
          sessionId,
          file.artifact.id
        )
        : null
    }
    return window.agentsDock.workspace.mediaURL(
      scope.profileId,
      scope.profileGeneration,
      sessionId,
      file.path
    )
  } catch {
    return null
  }
}

function WorkspaceImageViewer({ source, label }: { source: string; label: string }) {
  useLocale()
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])
  return <div className="workspace-editor-image-viewer">
    {failed
      ? <div className="workspace-editor-loading">{t('editor.agentsdockCouldNotDecodeThisImage')}</div>
      : <img src={source} alt={label} onError={() => setFailed(true)} />}
  </div>
}

function WorkspacePdfViewer({ source, label }: { source: string; label: string }) {
  useLocale()
  return <div className="workspace-editor-pdf-viewer">
    <iframe src={source} title={t('editor.pdfPreviewOf', { name: label })} />
  </div>
}

interface MarkdownScrollSyncController {
  setSource(element: HTMLElement | null): void
  setPreview(element: HTMLElement | null): void
  syncFromSource(): void
  destroy(): void
}

function createMarkdownScrollSyncController(): MarkdownScrollSyncController {
  let source: HTMLElement | null = null
  let preview: HTMLElement | null = null
  let frame: number | null = null
  let pending: { driver: HTMLElement; target: HTMLElement } | null = null
  let expected: { element: HTMLElement; top: number } | null = null

  const cancelPending = () => {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    pending = null
    expected = null
  }
  const flush = () => {
    frame = null
    const request = pending
    pending = null
    if (!request) return
    const driverMaximum = Math.max(0, request.driver.scrollHeight - request.driver.clientHeight)
    const targetMaximum = Math.max(0, request.target.scrollHeight - request.target.clientHeight)
    const fraction = driverMaximum > 0
      ? Math.min(1, Math.max(0, request.driver.scrollTop / driverMaximum))
      : 0
    const targetTop = fraction * targetMaximum
    if (Math.abs(request.target.scrollTop - targetTop) <= 1) return
    expected = { element: request.target, top: targetTop }
    request.target.scrollTop = targetTop
  }
  const schedule = (driver: HTMLElement | null, target: HTMLElement | null) => {
    if (!driver || !target) return
    if (expected?.element === driver) {
      const matchesExpected = Math.abs(driver.scrollTop - expected.top) <= 1
      expected = null
      if (matchesExpected) return
    }
    pending = { driver, target }
    if (frame === null) frame = window.requestAnimationFrame(flush)
  }
  const onSourceScroll = () => schedule(source, preview)
  const onPreviewScroll = () => schedule(preview, source)
  const replaceSource = (element: HTMLElement | null) => {
    if (source === element) return
    source?.removeEventListener('scroll', onSourceScroll)
    cancelPending()
    source = element
    source?.addEventListener('scroll', onSourceScroll, { passive: true })
  }
  const replacePreview = (element: HTMLElement | null) => {
    if (preview === element) return
    preview?.removeEventListener('scroll', onPreviewScroll)
    cancelPending()
    preview = element
    preview?.addEventListener('scroll', onPreviewScroll, { passive: true })
  }

  return {
    setSource: replaceSource,
    setPreview: replacePreview,
    syncFromSource: () => schedule(source, preview),
    destroy: () => {
      source?.removeEventListener('scroll', onSourceScroll)
      preview?.removeEventListener('scroll', onPreviewScroll)
      cancelPending()
      source = null
      preview = null
    }
  }
}

function WorkspaceMarkdownView({
  mode,
  sourceEditor,
  value,
  file,
  profileScope,
  sessionId,
  sourcePercent,
  onSourcePercentChange,
  previewScrollElementRef
}: {
  mode: MarkdownViewMode
  sourceEditor: ReactNode
  value: string
  file: OpenWorkspaceFile
  profileScope: WorkspaceProfileScope | null
  sessionId: string
  sourcePercent: number
  onSourcePercentChange: (percent: number) => void
  previewScrollElementRef: (element: HTMLDivElement | null) => void
}) {
  useLocale()
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; percent: number } | null>(null)
  const frameRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
  }, [])

  const applyPercent = (percent: number) => {
    containerRef.current?.style.setProperty(
      '--workspace-markdown-source-percent',
      `${clampMarkdownSourcePercent(percent)}%`
    )
  }
  const updateFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag || drag.pointerId !== event.pointerId || !container) return
    const bounds = container.getBoundingClientRect()
    if (bounds.width <= 0) return
    drag.percent = clampMarkdownSourcePercent((event.clientX - bounds.left) / bounds.width * 100)
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const latest = dragRef.current
      if (latest) applyPercent(latest.percent)
    })
  }
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    applyPercent(drag.percent)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    onSourcePercentChange(drag.percent)
  }
  const resizeFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 3
    const next = event.key === 'Home'
      ? MIN_MARKDOWN_SOURCE_PERCENT
      : event.key === 'End'
        ? MAX_MARKDOWN_SOURCE_PERCENT
        : clampMarkdownSourcePercent(sourcePercent + (event.key === 'ArrowRight' ? step : -step))
    applyPercent(next)
    onSourcePercentChange(next)
  }
  const style = mode === 'split'
    ? { '--workspace-markdown-source-percent': `${clampMarkdownSourcePercent(sourcePercent)}%` } as CSSProperties
    : undefined

  return <div
    ref={containerRef}
    className={`workspace-editor-markdown workspace-editor-markdown-${mode}${dragging ? ' workspace-editor-markdown-resizing' : ''}`}
    style={style}
  >
    {mode !== 'preview' && <div className="workspace-editor-markdown-source">{sourceEditor}</div>}
    {mode === 'split' && <div
      className="workspace-editor-markdown-resize-handle"
      role="separator"
      aria-label={t('editor.resizeMarkdownSourceAndPreview')}
      aria-orientation="vertical"
      aria-valuemin={MIN_MARKDOWN_SOURCE_PERCENT}
      aria-valuemax={MAX_MARKDOWN_SOURCE_PERCENT}
      aria-valuenow={Math.round(sourcePercent)}
      aria-valuetext={t('editor.sourcePercent', { percent: Math.round(sourcePercent) })}
      tabIndex={0}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.isPrimary === false) return
        event.preventDefault()
        dragRef.current = { pointerId: event.pointerId, percent: sourcePercent }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={updateFromPointer}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={finishPointer}
      onKeyDown={resizeFromKeyboard}
      onDoubleClick={() => {
        applyPercent(DEFAULT_MARKDOWN_SOURCE_PERCENT)
        onSourcePercentChange(DEFAULT_MARKDOWN_SOURCE_PERCENT)
      }}
    ><span aria-hidden="true" /></div>}
    {mode !== 'source' && <WorkspaceMarkdownPreview
      value={value}
      file={file}
      profileScope={profileScope}
      sessionId={sessionId}
      scrollElementRef={previewScrollElementRef}
    />}
  </div>
}

function WorkspaceMarkdownPreview({
  value,
  file,
  profileScope,
  sessionId,
  scrollElementRef
}: {
  value: string
  file: OpenWorkspaceFile
  profileScope: WorkspaceProfileScope | null
  sessionId: string
  scrollElementRef?: (element: HTMLDivElement | null) => void
}) {
  useLocale()
  const deferredValue = useDeferredValue(value)
  const resolveImageSource = useMemo(() => (
    (source: string) => resolveWorkspaceMarkdownImage(
      source,
      file,
      profileScope,
      sessionId
    )
  ), [file.origin, file.path, profileScope, sessionId])
  return <div ref={scrollElementRef} className="workspace-editor-markdown-preview" aria-label={t('editor.previewOf', { name: editorContentLabel(file) })}>
    <Suspense fallback={<div className="workspace-editor-loading"><LoaderCircle className="spin" size={17} /> {t('editor.loadingPreview')}</div>}>
      <LazySafeHtmlMarkdownContent
        text={deferredValue}
        sessionId={sessionId}
        fold={false}
        resolveImageSource={resolveImageSource}
      />
    </Suspense>
  </div>
}

function resolveWorkspaceMarkdownImage(
  source: string,
  file: OpenWorkspaceFile,
  scope: WorkspaceProfileScope | null,
  sessionId: string
): string | undefined {
  if (!source || file.origin !== 'workspace') return source || undefined
  if (/^(?:agentsdock-media:|data:image\/)/i.test(source)) return source
  if (
    !scope
    || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(source)
  ) return undefined
  const rawPath = source.split(/[?#]/, 1)[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  const parts = workspaceParentDirectory(file.path).split('/').filter(Boolean)
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  if (parts.length === 0) return undefined
  try {
    return window.agentsDock.workspace.mediaURL(
      scope.profileId,
      scope.profileGeneration,
      sessionId,
      parts.join('/')
    )
  } catch {
    return undefined
  }
}

function pathToken(path: string): string {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(path)) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  return `${fileName(path).replace(/[^a-zA-Z0-9_-]+/g, '-')}-${(hash >>> 0).toString(36)}`
}

function breadcrumb(path: string, preferredName?: string): ReactNode {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const parent = separator > 0 ? path.slice(0, separator) : ''
  const name = preferredName || (separator >= 0 ? path.slice(separator + 1) : path)
  return <>
    <strong className="workspace-editor-breadcrumb-name">{name}</strong>
    {parent && <span className="workspace-editor-breadcrumb-parent"><ChevronRight size={11} aria-hidden="true" />{parent}</span>}
  </>
}

function countLines(content: string): number {
  return content.length === 0 ? 1 : content.split('\n').length
}

function utf8Bytes(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

function resolvedWorkspaceFileByteLimit(value: number | undefined): number {
  if (value === 0) return Number.MAX_SAFE_INTEGER
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : LEGACY_MAX_EDITABLE_FILE_BYTES
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`
  const mebibytes = bytes / (1024 * 1024)
  return `${mebibytes >= 10 ? Math.round(mebibytes) : mebibytes.toFixed(1)} MiB`
}

function scheduleWhenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const request = window.requestIdleCallback(callback, { timeout: 1_200 })
    return () => window.cancelIdleCallback(request)
  }
  const timer = window.setTimeout(callback, 0)
  return () => window.clearTimeout(timer)
}

export function resolveWorkspacePathInput(cwd: string, input: string): WorkspacePathInputResolution {
  const candidate = unquotePath(input.trim())
  if (candidate.includes('\0')) return { kind: 'outside-workspace' }
  if (candidate.startsWith('~/')) {
    const homePath = normalizeHomeRelativePath(candidate)
    return homePath
      ? { kind: 'absolute-file', path: homePath }
      : { kind: 'outside-workspace' }
  }
  if (!isAbsolutePath(candidate)) {
    // A path-shaped relative query can be opened directly through the
    // workspace file endpoint. Do not make exact paths depend on the
    // workspace search scan/result limits.
    if (!candidate.includes('/') && !candidate.includes('\\')) return { kind: 'search' }
    const relativePath = normalizeWorkspaceReference(candidate)
    return relativePath
      ? { kind: 'workspace-file', path: relativePath }
      : { kind: 'outside-workspace' }
  }
  const normalizedCwd = normalizeAbsolutePath(cwd)
  const normalizedCandidate = normalizeAbsolutePath(candidate)
  if (!normalizedCandidate) {
    return { kind: 'outside-workspace' }
  }
  if (normalizedCwd && normalizedCwd.flavor !== normalizedCandidate.flavor) {
    return { kind: 'outside-workspace' }
  }
  if (normalizedCwd) {
    const sameRoot = normalizedCwd.flavor === 'windows'
      ? normalizedCwd.root.toLocaleLowerCase() === normalizedCandidate.root.toLocaleLowerCase()
      : normalizedCwd.root === normalizedCandidate.root
    const caseInsensitive = normalizedCwd.flavor === 'windows'
    const contains = sameRoot
      && normalizedCandidate.parts.length > normalizedCwd.parts.length
      && normalizedCwd.parts.every((part, index) => (
        caseInsensitive
          ? part.toLocaleLowerCase() === normalizedCandidate.parts[index]?.toLocaleLowerCase()
          : part === normalizedCandidate.parts[index]
      ))
    if (contains) {
      return {
        kind: 'workspace-file',
        path: normalizedCandidate.parts.slice(normalizedCwd.parts.length).join('/')
      }
    }
  }
  if (absolutePathContainsDotSegment(candidate, normalizedCandidate.flavor) || normalizedCandidate.parts.length === 0) {
    return { kind: 'outside-workspace' }
  }
  return { kind: 'absolute-file', path: formattedAbsolutePath(normalizedCandidate) }
}

export function resolveWorkspaceReference(
  reference: string,
  entries: WorkspaceEntry[]
): WorkspaceReferenceResolution {
  const normalized = normalizeWorkspaceReference(reference)
  if (!normalized) return { kind: 'missing' }
  const files = uniqueWorkspaceFiles(entries)
  const exact = files.filter(entry => entry.path === normalized)
  if (exact.length === 1) return { kind: 'match', path: exact[0].path }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact }

  const lower = normalized.toLocaleLowerCase()
  const caseInsensitiveExact = files.filter(entry => entry.path.toLocaleLowerCase() === lower)
  if (caseInsensitiveExact.length === 1) return { kind: 'match', path: caseInsensitiveExact[0].path }
  if (caseInsensitiveExact.length > 1) return { kind: 'ambiguous', matches: caseInsensitiveExact }

  if (normalized.includes('/')) {
    const suffix = files.filter(entry => entry.path.toLocaleLowerCase().endsWith(`/${lower}`))
    if (suffix.length === 1) return { kind: 'match', path: suffix[0].path }
    if (suffix.length > 1) return { kind: 'ambiguous', matches: suffix }
  }

  const basename = files.filter(entry => fileName(entry.path).toLocaleLowerCase() === lower)
  if (basename.length === 1) return { kind: 'match', path: basename[0].path }
  if (basename.length > 1) return { kind: 'ambiguous', matches: basename }
  return { kind: 'missing' }
}

function normalizeWorkspaceReference(reference: string): string | null {
  const normalized = unquotePath(reference.trim()).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null
  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function uniqueWorkspaceFiles(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const paths = new Set<string>()
  return entries.filter(entry => {
    if (entry.kind !== 'file' || paths.has(entry.path)) return false
    paths.add(entry.path)
    return true
  })
}

function unquotePath(path: string): string {
  if (path.length < 2) return path
  const first = path[0]
  return (first === '"' || first === "'") && path.at(-1) === first ? path.slice(1, -1) : path
}

function normalizeHomeRelativePath(path: string): string | null {
  if (!path.startsWith('~/')) return null
  const parts = path.slice(2).split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return `~/${parts.join('/')}`
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
}

function normalizeAbsolutePath(path: string): { flavor: 'posix' | 'windows'; root: string; parts: string[] } | null {
  const clean = unquotePath(path.trim())
  const windows = /^([a-zA-Z]:)[\\/]/.exec(clean)
  const flavor = windows ? 'windows' : clean.startsWith('/') ? 'posix' : null
  if (!flavor) return null
  const root = windows ? windows[1].toUpperCase() : '/'
  const remainder = windows ? clean.slice(windows[0].length) : clean.slice(1)
  const parts: string[] = []
  const rawParts = flavor === 'windows' ? remainder.split(/[\\/]+/) : remainder.split(/\/+/)
  for (const part of rawParts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return { flavor, root, parts }
}

function absolutePathContainsDotSegment(path: string, flavor: 'posix' | 'windows'): boolean {
  const remainder = flavor === 'windows'
    ? path.replace(/^[a-zA-Z]:[\\/]/, '')
    : path.slice(1)
  const parts = flavor === 'windows' ? remainder.split(/[\\/]/) : remainder.split('/')
  return parts.some(part => part === '.' || part === '..')
}

function formattedAbsolutePath(path: { flavor: 'posix' | 'windows'; root: string; parts: string[] }): string {
  return path.flavor === 'windows'
    ? `${path.root}\\${path.parts.join('\\')}`
    : `/${path.parts.join('/')}`
}

export function languageLabel(path: string): string {
  const name = fileName(path).toLocaleLowerCase()
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : ''
  const labels: Record<string, string> = {
    bash: 'Shell', c: 'C', cc: 'C++', cpp: 'C++', css: 'CSS', cts: 'TypeScript',
    fish: 'Shell', go: 'Go', h: 'C/C++', html: 'HTML', htm: 'HTML', java: 'Java',
    js: 'JavaScript', json: 'JSON', jsonc: 'JSON with comments', jsx: 'JavaScript React',
    less: 'Less', md: 'Markdown', mdx: 'MDX', mjs: 'JavaScript', mts: 'TypeScript',
    py: 'Python', rs: 'Rust', scss: 'SCSS', sh: 'Shell', sql: 'SQL', toml: 'TOML',
    ts: 'TypeScript', tsx: 'TypeScript React', txt: t('editor.plainText'), yaml: 'YAML', yml: 'YAML', zsh: 'Shell'
  }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'Dockerfile'
  if (name === 'makefile') return 'Makefile'
  return labels[extension] || t('editor.plainText')
}

export function resetWorkspaceEditorMemoryForTests(): void {
  workspaceMemory.clear()
}

function isMarkdownViewMode(value: unknown): value is MarkdownViewMode {
  return value === 'source' || value === 'split' || value === 'preview'
}

function clampEditorSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EDITOR_SPLIT_PERCENT
  return Math.min(MAX_EDITOR_SPLIT_PERCENT, Math.max(MIN_EDITOR_SPLIT_PERCENT, value))
}

function clampMarkdownSourcePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MARKDOWN_SOURCE_PERCENT
  return Math.min(MAX_MARKDOWN_SOURCE_PERCENT, Math.max(MIN_MARKDOWN_SOURCE_PERCENT, value))
}

function clampExplorerWidth(value: number, panelWidth?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_EXPLORER_WIDTH
  return Math.min(
    maximumExplorerWidth(panelWidth, value),
    Math.max(MIN_EXPLORER_WIDTH, value)
  )
}

function maximumExplorerWidth(panelWidth?: number, fallback = DEFAULT_EXPLORER_WIDTH): number {
  if (Number.isFinite(panelWidth) && Number(panelWidth) > 0) {
    return Math.max(
      MIN_EXPLORER_WIDTH,
      Number(panelWidth) - MIN_EDITOR_CONTENT_WIDTH - EXPLORER_RESIZE_HANDLE_WIDTH
    )
  }
  return Math.max(MIN_EXPLORER_WIDTH, Number.isFinite(fallback) ? fallback : DEFAULT_EXPLORER_WIDTH)
}

function readEditorSplitPreference(): EditorSplitPreference {
  try {
    const stored = JSON.parse(window.localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY) ?? 'null') as Partial<EditorSplitPreference> | null
    return {
      side: stored?.side === 'left' ? 'left' : 'right',
      editorPercent: clampEditorSplitPercent(Number(stored?.editorPercent ?? DEFAULT_EDITOR_SPLIT_PERCENT)),
      explorerWidth: clampExplorerWidth(Number(stored?.explorerWidth ?? DEFAULT_EXPLORER_WIDTH)),
      markdownSourcePercent: clampMarkdownSourcePercent(Number(
        stored?.markdownSourcePercent ?? DEFAULT_MARKDOWN_SOURCE_PERCENT
      ))
    }
  } catch {
    return {
      side: 'right',
      editorPercent: DEFAULT_EDITOR_SPLIT_PERCENT,
      explorerWidth: DEFAULT_EXPLORER_WIDTH,
      markdownSourcePercent: DEFAULT_MARKDOWN_SOURCE_PERCENT
    }
  }
}

function writeEditorSplitPreference(preference: EditorSplitPreference): void {
  try {
    window.localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, JSON.stringify({
      side: preference.side,
      editorPercent: clampEditorSplitPercent(preference.editorPercent),
      explorerWidth: clampExplorerWidth(preference.explorerWidth),
      markdownSourcePercent: clampMarkdownSourcePercent(preference.markdownSourcePercent)
    }))
  } catch {
    // The split remains usable for the current window when storage is unavailable.
  }
}
