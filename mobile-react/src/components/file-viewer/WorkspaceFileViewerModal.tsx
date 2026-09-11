import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlashList } from '@shopify/flash-list'
import * as Clipboard from 'expo-clipboard'
import * as FileSystem from 'expo-file-system/legacy'
import { ActionSheetIOS, ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { AlertCircle, ChevronLeft, ChevronRight, Download, File, FilePlus, Folder, FolderPlus, Link, MoreHorizontal, Pencil, RefreshCw, Search, Share2, Trash2, X } from 'lucide-react-native'
import type { AgentServerClient } from '../../api/AgentServerClient'
import {
  inferredMobileFileContentType,
  joinWorkspacePath,
  mobileFileViewerLayout,
  mobileFileViewerPaneVisibility,
  parentWorkspacePath,
  sortFileViewerEntries,
  workspacePathSegments,
} from '../../lib/file-viewer'
import { dismissAppKeyboard } from '../../lib/app-keyboard'
import { formatBytes } from '../../lib/format'
import { fullscreenModalPadding, type FullscreenSafeAreaInsets } from '../../lib/fullscreen-modal-layout'
import { workspaceFileDepartureDecision } from '../../lib/workspace-file-editing'
import { client, useAppStore } from '../../store/useAppStore'
import { usePalette } from '../../theme'
import type { WorkspaceEntry, WorkspaceFile, WorkspaceInfo } from '../../types'
import { Text, TextInput } from '../AppText'
import { EmptyState, IconButton, SheetCloseButton } from '../ui'
import { useTextPrompt } from '../TextPromptDialog'
import { FilePreview, type FilePreviewEditController, type LoadedFileText } from './FilePreview'
import type { WorkspaceFileViewerRequest } from './FileViewerContext'
import { workspaceTransferRequest, type FileTransferAction } from '../../lib/file-transfer'
import { useFileTransfer } from './useFileTransfer'
import { FileTransferNotice } from './FileTransferNotice'

interface WorkspaceConnectionScope {
  client: AgentServerClient
  key: string
  cacheNamespace: string
  sessionId: string
  profileId: string | null
  generation: number
}

export function WorkspaceFileViewerModal({ request, modalInsets, onClose }: { request: WorkspaceFileViewerRequest; modalInsets: FullscreenSafeAreaInsets; onClose: () => void }) {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const [dirty, setDirtyState] = useState(false)
  const dirtyRef = useRef(dirty)
  const setDirty = useCallback((nextDirty: boolean) => {
    dirtyRef.current = nextDirty
    setDirtyState(nextDirty)
  }, [])
  const editController = useRef<FilePreviewEditController | null>(null)
  const closePreparationInFlight = useRef(false)
  const handleEditControllerChange = useCallback((controller: FilePreviewEditController | null) => {
    editController.current = controller
  }, [])
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const serverIdentity = useAppStore(state => state.profiles.find(value => value.id === activeProfileId)?.serverIdentity ?? null)
  const serverURL = useAppStore(state => state.serverURL)
  const scope = useMemo<WorkspaceConnectionScope>(() => ({
    client: connection,
    key: connectionKey,
    cacheNamespace: serverIdentity || serverURL,
    sessionId: request.sessionId,
    profileId: activeProfileId,
    generation: profileGeneration,
  }), [activeProfileId, connection, connectionKey, profileGeneration, request.sessionId, serverIdentity, serverURL])
  const commitClose = useCallback(() => {
    editController.current?.blur()
    dismissAppKeyboard()
    onClose()
  }, [onClose])
  const close = useCallback(() => {
    if (closePreparationInFlight.current) return
    closePreparationInFlight.current = true
    void prepareWorkspaceEditorForDeparture(editController.current).then(prepared => {
      requestAnimationFrame(() => {
        closePreparationInFlight.current = false
        const controller = editController.current
        const departure = workspaceFileDepartureDecision(
          Boolean(controller?.isSaving()),
          !prepared || dirtyRef.current || Boolean(controller?.hasUnsavedChanges()),
          Boolean(controller?.hasNewerDraftSinceSave()),
        )
        if (departure.kind === 'confirm_saving') {
          Alert.alert(
            'File is still saving',
            departure.hasNewerDraft
              ? 'The current save does not include your newest edits. Closing now will discard those edits.'
              : 'The server has not confirmed this save yet. You can keep the editor open or close without waiting.',
            [
              { text: 'Keep Editor Open', style: 'cancel' },
              { text: 'Close Anyway', style: 'destructive', onPress: commitClose },
            ],
          )
          return
        }
        if (departure.kind === 'leave') {
          commitClose()
          return
        }
        Alert.alert('Discard unsaved changes?', 'Your edits have not been saved.', [
          { text: 'Keep Editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: commitClose },
          ...(controller?.canSave() ? [{ text: 'Save', onPress: () => { void controller.save().then(saved => { if (saved) commitClose() }) } }] : []),
        ])
      })
    })
  }, [commitClose])
  const modalPadding = fullscreenModalPadding(modalInsets, Platform.OS)
  const sessionCurrent = selectedSessionId === request.sessionId
  const connectionAvailable = connected && !connecting && !switchingProfileId && connection.isValidated
  return <Modal visible animationType="slide" presentationStyle="fullScreen" statusBarTranslucent={Platform.OS === 'android'} onRequestClose={close}>
    {sessionCurrent
      ? <ScopedWorkspaceFileViewer key={`${connectionKey}:${request.sessionId}`} request={request} connection={scope} modalPadding={modalPadding} connectionAvailable={connectionAvailable} reconnecting={connecting || Boolean(switchingProfileId)} onDirtyChange={setDirty} onEditControllerChange={handleEditControllerChange} onClose={close} />
      : <UnavailableWorkspaceViewer reconnecting={connecting || Boolean(switchingProfileId)} sessionChanged modalPadding={modalPadding} onClose={close} />}
  </Modal>
}

function ScopedWorkspaceFileViewer({ request, connection, modalPadding, connectionAvailable, reconnecting, onDirtyChange, onEditControllerChange, onClose }: { request: WorkspaceFileViewerRequest; connection: WorkspaceConnectionScope; modalPadding: ReturnType<typeof fullscreenModalPadding>; connectionAvailable: boolean; reconnecting: boolean; onDirtyChange: (dirty: boolean) => void; onEditControllerChange: (controller: FilePreviewEditController | null) => void; onClose: () => void }) {
  const colors = usePalette()
  const { promptText, textPromptDialog } = useTextPrompt()
  const { width, height } = useWindowDimensions()
  const layout = mobileFileViewerLayout(width, height)
  const [info, setInfo] = useState<WorkspaceInfo | null>(null)
  const [infoResolved, setInfoResolved] = useState(false)
  const [infoError, setInfoError] = useState('')
  const [infoRevision, setInfoRevision] = useState(0)
  const infoRef = useRef(info)
  infoRef.current = info
  const [directory, setDirectory] = useState('')
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null)
  const fileTransfer = useFileTransfer(`${connection.key}:${request.sessionId}:${selected?.path ?? ''}`)
  const [query, setQuery] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [mutationBusy, setMutationBusy] = useState<'create' | 'rename' | 'delete' | null>(null)
  const [mutationError, setMutationError] = useState('')
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false)
  const hasUnsavedEditsRef = useRef(hasUnsavedEdits)
  const [previewRevision, setPreviewRevision] = useState(0)
  const requestRevision = useRef(0)
  const previousConnectionAvailable = useRef(connectionAvailable)
  const mounted = useRef(true)
  const mutationInFlight = useRef(false)
  const departurePreparationInFlight = useRef(false)
  const editController = useRef<FilePreviewEditController | null>(null)
  const directoryRef = useRef(directory)
  directoryRef.current = directory
  const queryRef = useRef(query)
  queryRef.current = query
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const sortedEntries = useMemo(() => sortFileViewerEntries(entries), [entries])
  const paneVisibility = mobileFileViewerPaneVisibility(layout, Boolean(selected))
  const mutationsAvailable = Boolean(info && info.capability_version >= 6 && !info.read_only)
  const mutationControlsDisabled = !connectionAvailable || mutationBusy !== null
  const title = info?.name || 'Workspace files'
  const setViewerDirty = useCallback((nextDirty: boolean) => {
    hasUnsavedEditsRef.current = nextDirty
    setHasUnsavedEdits(nextDirty)
    onDirtyChange(nextDirty)
  }, [onDirtyChange])
  const setEditController = useCallback((controller: FilePreviewEditController | null) => {
    editController.current = controller
    onEditControllerChange(controller)
  }, [onEditControllerChange])
  const confirmDiscard = useCallback((action: () => void) => {
    if (departurePreparationInFlight.current) return
    departurePreparationInFlight.current = true
    void prepareWorkspaceEditorForDeparture(editController.current).then(prepared => {
      requestAnimationFrame(() => {
        departurePreparationInFlight.current = false
        if (!mounted.current) return
        const controller = editController.current
        const leaveFile = () => { setViewerDirty(false); action() }
        const departure = workspaceFileDepartureDecision(
          Boolean(controller?.isSaving()),
          !prepared || hasUnsavedEditsRef.current || Boolean(controller?.hasUnsavedChanges()),
          Boolean(controller?.hasNewerDraftSinceSave()),
        )
        if (departure.kind === 'confirm_saving') {
          Alert.alert(
            'File is still saving',
            departure.hasNewerDraft
              ? 'The current save does not include your newest edits. Leaving now will discard those edits.'
              : 'The server has not confirmed this save yet. You can stay or leave without waiting.',
            [
              { text: 'Stay Here', style: 'cancel' },
              { text: 'Leave Anyway', style: 'destructive', onPress: leaveFile },
            ],
          )
          return
        }
        if (departure.kind === 'leave') {
          action()
          return
        }
        Alert.alert('Discard unsaved changes?', 'Your edits have not been saved.', [
          { text: 'Keep Editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: leaveFile },
          ...(controller?.canSave() ? [{ text: 'Save', onPress: () => { void controller.save().then(saved => { if (saved) leaveFile() }) } }] : []),
        ])
      })
    })
  }, [setViewerDirty])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onDirtyChange(false)
      onEditControllerChange(null)
    }
  }, [onDirtyChange, onEditControllerChange])
  useEffect(() => {
    const restored = connectionAvailable && !previousConnectionAvailable.current
    previousConnectionAvailable.current = connectionAvailable
    if (restored && !hasUnsavedEdits) setPreviewRevision(value => value + 1)
  }, [connectionAvailable, hasUnsavedEdits])

  const loadDirectory = useCallback(async (path: string, offset = 0) => {
    const revision = ++requestRevision.current
    const append = offset > 0
    if (append) setLoadingMore(true)
    else {
      setLoading(true)
      setError('')
    }
    try {
      const page = await connection.client.workspaceEntries(request.sessionId, path, offset, 500)
      if (revision !== requestRevision.current || !workspaceConnectionIsCurrent(connection)) return
      setEntries(current => append ? mergeWorkspaceEntries(current, page.entries) : page.entries)
      if (!append) setSelected(current => {
        if (!current) return null
        return page.entries.find(entry => entry.path === current.path) ?? current
      })
      setTotal(page.total)
      setHasMore(page.has_more)
    } catch (cause) {
      if (revision === requestRevision.current && workspaceConnectionIsCurrent(connection)) setError(fileViewerError(cause))
    } finally {
      if (revision === requestRevision.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [connection, request.sessionId])

  useEffect(() => {
    if (!connectionAvailable || infoResolved) return
    let current = true
    setInfoError('')
    void connection.client.workspaceInfo(request.sessionId).then(value => {
      if (current && workspaceConnectionIdentityIsCurrent(connection)) {
        setInfo(value)
        setInfoResolved(true)
      }
    }).catch(cause => {
      if (current && workspaceConnectionIdentityIsCurrent(connection)) setInfoError(fileViewerError(cause))
    })
    return () => { current = false }
  }, [connection, connectionAvailable, infoResolved, infoRevision, request.sessionId])
  useEffect(() => {
    if (!connectionAvailable || query.trim()) return
    void loadDirectory(directory)
  }, [connectionAvailable, directory, loadDirectory, query])
  useEffect(() => {
    const clean = query.trim()
    if (!connectionAvailable || !clean) return
    const revision = ++requestRevision.current
    setLoading(true)
    setError('')
    const timer = setTimeout(() => {
      void connection.client.workspaceSearch(request.sessionId, clean, 200).then(page => {
        if (revision !== requestRevision.current || !workspaceConnectionIsCurrent(connection)) return
        setEntries(page.entries)
        setTotal(page.entries.length)
        setHasMore(false)
      }).catch(cause => {
        if (revision === requestRevision.current && workspaceConnectionIsCurrent(connection)) setError(fileViewerError(cause))
      }).finally(() => {
        if (revision === requestRevision.current) setLoading(false)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [connection, connectionAvailable, query, request.sessionId, searchRevision])

  const restoreCurrentDraftDirty = useCallback(() => {
    setViewerDirty(Boolean(editController.current?.hasUnsavedChanges()))
  }, [setViewerDirty])
  const refreshAfterWorkspaceMutation = useCallback((path: string, clearSearch = false) => {
    if (!mounted.current || !workspaceConnectionIsCurrent(connection)) return
    if (clearSearch && queryRef.current.trim()) {
      queryRef.current = ''
      setQuery('')
      return
    }
    if (queryRef.current.trim()) {
      setSearchRevision(value => value + 1)
      return
    }
    if (directoryRef.current === path) void loadDirectory(path)
  }, [connection, loadDirectory])
  const beginWorkspaceMutation = useCallback((kind: 'create' | 'rename' | 'delete'): boolean => {
    const currentInfo = infoRef.current
    if (!currentInfo || currentInfo.read_only || currentInfo.capability_version < 6) {
      setMutationError('Update AgentsServer to create, rename, or delete workspace entries.')
      return false
    }
    if (!workspaceConnectionIsCurrent(connection)) {
      setMutationError('Reconnect this server before changing workspace files.')
      return false
    }
    if (mutationInFlight.current) {
      setMutationError('Wait for the current workspace operation to finish.')
      return false
    }
    mutationInFlight.current = true
    setMutationBusy(kind)
    setMutationError('')
    return true
  }, [connection])
  const finishWorkspaceMutation = useCallback(() => {
    mutationInFlight.current = false
    if (mounted.current) setMutationBusy(null)
  }, [])
  const createWorkspaceEntry = useCallback(async (kind: 'file' | 'directory', name: string, targetDirectory: string) => {
    const validationError = workspaceEntryNameError(name)
    if (validationError) {
      setMutationError(validationError)
      return
    }
    if (!beginWorkspaceMutation('create')) return
    const path = joinWorkspacePath(targetDirectory, name)
    try {
      const result = await connection.client.workspaceCreateEntry(request.sessionId, path, kind)
      if (!mounted.current || !workspaceConnectionIdentityIsCurrent(connection)) return
      const created = validatedWorkspaceMutationEntry(result.entry, path, kind)
      setEntries(current => mergeWorkspaceEntries(current, [created]))
      if (kind === 'file') {
        selectedRef.current = created
        setSelected(created)
        setViewerDirty(false)
        setPreviewRevision(value => value + 1)
      }
      refreshAfterWorkspaceMutation(targetDirectory, true)
    } catch (cause) {
      if (mounted.current && workspaceConnectionIdentityIsCurrent(connection)) {
        setMutationError(fileViewerError(cause))
        restoreCurrentDraftDirty()
        refreshAfterWorkspaceMutation(targetDirectory)
      }
    } finally {
      finishWorkspaceMutation()
    }
  }, [beginWorkspaceMutation, connection, finishWorkspaceMutation, refreshAfterWorkspaceMutation, request.sessionId, restoreCurrentDraftDirty, setViewerDirty])
  const renameWorkspaceEntry = useCallback(async (entry: WorkspaceEntry, name: string) => {
    const validationError = workspaceEntryNameError(name)
    if (validationError) {
      setMutationError(validationError)
      return
    }
    if (name === entry.name) {
      setMutationError(`${entry.name} already has that name.`)
      return
    }
    if (!validWorkspaceEntryRevision(entry.revision)) {
      setMutationError('Refresh the file explorer before renaming this entry.')
      refreshAfterWorkspaceMutation(parentWorkspacePath(entry.path))
      return
    }
    if (!beginWorkspaceMutation('rename')) return
    const previousPath = entry.path
    const parent = parentWorkspacePath(previousPath)
    const nextPath = joinWorkspacePath(parent, name)
    const affectedSelected = Boolean(selectedRef.current && workspacePathIsWithin(selectedRef.current.path, previousPath))
    try {
      const result = await connection.client.workspaceRenameEntry(request.sessionId, previousPath, name, entry.revision)
      if (!mounted.current || !workspaceConnectionIdentityIsCurrent(connection)) return
      if (result.previous_path !== previousPath) throw new Error('The server renamed a different workspace entry.')
      const renamed = validatedWorkspaceMutationEntry(result.entry, nextPath, entry.kind)
      setEntries(current => current.map(value => value.path === previousPath ? renamed : value))
      const currentSelected = selectedRef.current
      if (currentSelected && workspacePathIsWithin(currentSelected.path, previousPath)) {
        const remappedPath = remapWorkspacePath(currentSelected.path, previousPath, nextPath)
        const remapped = currentSelected.path === previousPath
          ? renamed
          : { ...currentSelected, path: remappedPath, name: remappedPath.split('/').at(-1) ?? currentSelected.name }
        selectedRef.current = remapped
        setSelected(remapped)
        setViewerDirty(false)
        setPreviewRevision(value => value + 1)
      }
      if (workspacePathIsWithin(directoryRef.current, previousPath)) {
        const remappedDirectory = remapWorkspacePath(directoryRef.current, previousPath, nextPath)
        directoryRef.current = remappedDirectory
        setDirectory(remappedDirectory)
      }
      refreshAfterWorkspaceMutation(parent)
    } catch (cause) {
      if (mounted.current && workspaceConnectionIdentityIsCurrent(connection)) {
        setMutationError(fileViewerError(cause))
        if (affectedSelected) restoreCurrentDraftDirty()
        refreshAfterWorkspaceMutation(parent)
      }
    } finally {
      finishWorkspaceMutation()
    }
  }, [beginWorkspaceMutation, connection, finishWorkspaceMutation, refreshAfterWorkspaceMutation, request.sessionId, restoreCurrentDraftDirty, setViewerDirty])
  const removeWorkspaceEntry = useCallback(async (entry: WorkspaceEntry) => {
    if (!validWorkspaceEntryRevision(entry.revision)) {
      setMutationError('Refresh the file explorer before deleting this entry.')
      refreshAfterWorkspaceMutation(parentWorkspacePath(entry.path))
      return
    }
    if (!beginWorkspaceMutation('delete')) return
    const path = entry.path
    const parent = parentWorkspacePath(path)
    const affectedSelected = Boolean(selectedRef.current && workspacePathIsWithin(selectedRef.current.path, path))
    try {
      const result = await connection.client.workspaceRemoveEntry(request.sessionId, path, entry.revision, entry.kind === 'directory')
      if (!mounted.current || !workspaceConnectionIdentityIsCurrent(connection)) return
      if (!result.removed || result.path !== path || result.kind !== entry.kind) throw new Error('The server removed a different workspace entry.')
      setEntries(current => current.filter(value => !workspacePathIsWithin(value.path, path)))
      if (selectedRef.current && workspacePathIsWithin(selectedRef.current.path, path)) {
        selectedRef.current = null
        setSelected(null)
        setViewerDirty(false)
        setPreviewRevision(value => value + 1)
      }
      if (workspacePathIsWithin(directoryRef.current, path)) {
        directoryRef.current = parent
        queryRef.current = ''
        setDirectory(parent)
        setQuery('')
      }
      refreshAfterWorkspaceMutation(parent)
    } catch (cause) {
      if (mounted.current && workspaceConnectionIdentityIsCurrent(connection)) {
        setMutationError(fileViewerError(cause))
        if (affectedSelected) restoreCurrentDraftDirty()
        refreshAfterWorkspaceMutation(parent)
      }
    } finally {
      finishWorkspaceMutation()
    }
  }, [beginWorkspaceMutation, connection, finishWorkspaceMutation, refreshAfterWorkspaceMutation, request.sessionId, restoreCurrentDraftDirty, setViewerDirty])
  const protectAffectedEditor = useCallback((entry: WorkspaceEntry, action: () => void) => {
    const selectedPath = selectedRef.current?.path
    if (selectedPath && workspacePathIsWithin(selectedPath, entry.path)) confirmDiscard(action)
    else action()
  }, [confirmDiscard])
  const latestWorkspaceMutationEntry = useCallback((entry: WorkspaceEntry): WorkspaceEntry => {
    const currentSelected = selectedRef.current
    return currentSelected?.path === entry.path && currentSelected.kind === entry.kind ? currentSelected : entry
  }, [])
  const requestCreateWorkspaceEntry = useCallback((kind: 'file' | 'directory') => {
    if (mutationControlsDisabled || !mutationsAvailable) return
    dismissAppKeyboard()
    const targetDirectory = directoryRef.current
    void promptText({
      title: kind === 'file' ? 'New file' : 'New folder',
      message: `Create in ${targetDirectory || 'Workspace'}.`,
      initialValue: kind === 'file' ? 'untitled.txt' : 'untitled',
      confirmLabel: 'Create',
    }).then(value => {
      if (value == null) return
      const create = () => { void createWorkspaceEntry(kind, value, targetDirectory) }
      if (kind === 'file') confirmDiscard(create)
      else create()
    })
  }, [confirmDiscard, createWorkspaceEntry, mutationControlsDisabled, mutationsAvailable, promptText])
  const requestRenameWorkspaceEntry = useCallback((entry: WorkspaceEntry) => {
    if (mutationControlsDisabled || !mutationsAvailable) return
    dismissAppKeyboard()
    void promptText({
      title: `Rename ${entry.name}`,
      message: 'Enter one file or folder name.',
      initialValue: entry.name,
      confirmLabel: 'Rename',
    }).then(value => {
      if (value == null) return
      protectAffectedEditor(entry, () => { void renameWorkspaceEntry(latestWorkspaceMutationEntry(entry), value) })
    })
  }, [latestWorkspaceMutationEntry, mutationControlsDisabled, mutationsAvailable, promptText, protectAffectedEditor, renameWorkspaceEntry])
  const requestDeleteWorkspaceEntry = useCallback((entry: WorkspaceEntry) => {
    if (mutationControlsDisabled || !mutationsAvailable) return
    dismissAppKeyboard()
    const directoryWarning = 'This recursively deletes the folder and everything inside it. This cannot be undone.'
    const fileWarning = 'This permanently deletes the file. This cannot be undone.'
    Alert.alert(`Delete ${entry.name}?`, entry.kind === 'directory' ? directoryWarning : fileWarning, [
      { text: 'Cancel', style: 'cancel' },
      { text: entry.kind === 'directory' ? 'Delete Folder' : 'Delete File', style: 'destructive', onPress: () => protectAffectedEditor(entry, () => { void removeWorkspaceEntry(latestWorkspaceMutationEntry(entry)) }) },
    ])
  }, [latestWorkspaceMutationEntry, mutationControlsDisabled, mutationsAvailable, protectAffectedEditor, removeWorkspaceEntry])
  const showEntryWorkspaceActions = useCallback((entry: WorkspaceEntry) => {
    if (mutationControlsDisabled || !mutationsAvailable) return
    if (Platform.OS !== 'ios') {
      Alert.alert(`Actions for ${entry.name}`, undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rename', onPress: () => requestRenameWorkspaceEntry(entry) },
        { text: 'Delete', style: 'destructive', onPress: () => requestDeleteWorkspaceEntry(entry) },
      ])
      return
    }
    ActionSheetIOS.showActionSheetWithOptions({
      title: entry.name,
      options: ['Rename', 'Delete', 'Cancel'],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    }, index => {
      if (index === 0) requestRenameWorkspaceEntry(entry)
      if (index === 1) requestDeleteWorkspaceEntry(entry)
    })
  }, [mutationControlsDisabled, mutationsAvailable, requestDeleteWorkspaceEntry, requestRenameWorkspaceEntry])
  const showPhoneWorkspaceActions = useCallback(() => {
    if (mutationControlsDisabled || !mutationsAvailable) return
    const target = selectedRef.current
    const options = ['New File', 'New Folder', ...(target ? ['Rename', 'Delete'] : []), 'Cancel']
    const cancelButtonIndex = options.length - 1
    if (Platform.OS !== 'ios') {
      Alert.alert('Workspace actions', undefined, [
        { text: 'New File', onPress: () => requestCreateWorkspaceEntry('file') },
        { text: 'New Folder', onPress: () => requestCreateWorkspaceEntry('directory') },
        ...(target ? [{ text: `More for ${target.name}`, onPress: () => showEntryWorkspaceActions(target) }] : []),
      ])
      return
    }
    ActionSheetIOS.showActionSheetWithOptions({
      title: target?.name ?? (directoryRef.current || 'Workspace'),
      options,
      destructiveButtonIndex: target ? 3 : undefined,
      cancelButtonIndex,
    }, index => {
      if (index === 0) requestCreateWorkspaceEntry('file')
      if (index === 1) requestCreateWorkspaceEntry('directory')
      if (target && index === 2) requestRenameWorkspaceEntry(target)
      if (target && index === 3) requestDeleteWorkspaceEntry(target)
    })
  }, [mutationControlsDisabled, mutationsAvailable, requestCreateWorkspaceEntry, requestDeleteWorkspaceEntry, requestRenameWorkspaceEntry, showEntryWorkspaceActions])

  const openEntry = useCallback((entry: WorkspaceEntry) => {
    dismissAppKeyboard()
    if (entry.kind === 'symlink') {
      setError('Workspace symlinks cannot be opened securely.')
      return
    }
    confirmDiscard(() => {
      setViewerDirty(false)
      setPreviewRevision(value => value + 1)
      setError('')
      if (entry.kind === 'directory') {
        setDirectory(entry.path)
        setQuery('')
        setSelected(null)
        return
      }
      setSelected(entry)
    })
  }, [confirmDiscard, setViewerDirty])
  const goUp = useCallback(() => {
    confirmDiscard(() => {
      setViewerDirty(false)
      if (selected && layout === 'phone') {
        setSelected(null)
        return
      }
      setDirectory(parentWorkspacePath(directory))
      setQuery('')
      setSelected(null)
    })
  }, [confirmDiscard, directory, layout, selected, setViewerDirty])
  const openDirectory = useCallback((path: string) => {
    confirmDiscard(() => {
      setViewerDirty(false)
      setDirectory(path)
      setQuery('')
      setSelected(null)
    })
  }, [confirmDiscard, setViewerDirty])
  const refresh = useCallback(() => {
    confirmDiscard(() => {
      setViewerDirty(false)
      setPreviewRevision(value => value + 1)
      if (query.trim()) setSearchRevision(value => value + 1)
      else void loadDirectory(directory)
    })
  }, [confirmDiscard, directory, loadDirectory, query, setViewerDirty])
  const transferSelected = useCallback((action: FileTransferAction) => {
    if (!selected) return
    editController.current?.blur()
    dismissAppKeyboard()
    void fileTransfer.start(workspaceTransferRequest(selected, request.sessionId, connection.client, action, () => workspaceConnectionIsCurrent(connection)))
  }, [connection, fileTransfer.start, request.sessionId, selected])
  const downloadSelected = useCallback(() => transferSelected('download'), [transferSelected])
  const shareSelected = useCallback(() => transferSelected('share'), [transferSelected])
  const copySelectedPath = useCallback(() => {
    if (!selected) return
    editController.current?.blur()
    dismissAppKeyboard()
    void Clipboard.setStringAsync(selected.path)
  }, [selected])
  const loadSelectedText = useCallback(async (limit: number): Promise<LoadedFileText> => {
    const currentSelected = selectedRef.current
    if (!currentSelected) throw new Error('No file is selected.')
    if (typeof currentSelected.size === 'number' && Number.isFinite(currentSelected.size) && currentSelected.size >= 0 && currentSelected.size > limit) throw new Error(`This file exceeds the ${formatBytes(limit)} mobile editing limit.`)
    const path = currentSelected.path
    const file = await connection.client.workspaceFile(request.sessionId, path)
    if (!workspaceConnectionIdentityIsCurrent(connection)) throw new Error('The active server changed while opening this file.')
    if (selectedRef.current?.path !== path) throw new Error('Another file was selected while this file was loading.')
    return validatedWorkspaceText(file, path, limit)
  }, [connection, request.sessionId])
  const saveSelectedText = useCallback(async (content: string, expectedRevision: string): Promise<LoadedFileText> => {
    const currentSelected = selectedRef.current
    if (!currentSelected) throw new Error('No file is selected.')
    const currentInfo = infoRef.current
    if (!currentInfo || currentInfo.read_only || currentInfo.capability_version < 2) throw new Error('This workspace is read-only on the connected server.')
    const path = currentSelected.path
    if (!workspaceConnectionIsCurrent(connection)) throw new Error('Reconnect this server before saving the file.')
    if (selectedRef.current?.path !== path) throw new Error('Another file was selected before this file could be saved.')
    const file = await connection.client.workspaceWriteFile(request.sessionId, path, content, expectedRevision)
    if (!workspaceConnectionIdentityIsCurrent(connection)) throw new Error('The active server changed while saving this file.')
    if (selectedRef.current?.path !== path) throw new Error('Another file was selected while this file was saving.')
    const saved = validatedWorkspaceText(file, path, currentInfo.max_text_file_bytes)
    if (saved.content !== content) throw new Error('The server returned different content after saving this file.')
    return saved
  }, [connection, request.sessionId])
  const handleTextSaved = useCallback((saved: LoadedFileText, hasNewerDraft: boolean) => {
    setViewerDirty(hasNewerDraft)
    const path = selectedRef.current?.path
    if (!path) return
    setEntries(current => current.map(entry => entry.path === path ? { ...entry, revision: saved.revision, size: saved.size ?? entry.size, mtime_ns: saved.mtime_ns ?? entry.mtime_ns, writable: saved.writable ?? entry.writable } : entry))
    const currentSelected = selectedRef.current
    if (currentSelected?.path === path) {
      const updatedSelected = { ...currentSelected, revision: saved.revision, size: saved.size ?? currentSelected.size, mtime_ns: saved.mtime_ns ?? currentSelected.mtime_ns, writable: saved.writable ?? currentSelected.writable }
      selectedRef.current = updatedSelected
      setSelected(updatedSelected)
    }
  }, [setViewerDirty])
  const loadSelectedPDF = useCallback(async (): Promise<string> => {
    if (!selected) throw new Error('No file is selected.')
    const destination = `${FileSystem.cacheDirectory}workspace-preview-${scopedWorkspaceCacheKey(connection, request.sessionId, selected)}.pdf`
    await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined)
    const result = await FileSystem.downloadAsync(
      revisionedWorkspaceURL(connection.client.workspacePreviewURL(request.sessionId, selected.path), selected.revision),
      destination,
      { headers: connection.client.authHeaders() },
    )
    if (result.status < 200 || result.status >= 300) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
      throw new Error(`Preview request failed with HTTP ${result.status}.`)
    }
    if (!workspaceConnectionIsCurrent(connection)) throw new Error('The active server changed while opening this PDF.')
    return result.uri
  }, [connection, request.sessionId, selected])

  const browser = <WorkspaceBrowser
    layout={layout}
    directory={directory}
    entries={sortedEntries}
    total={total}
    hasMore={hasMore}
    query={query}
    selectedPath={selected?.path ?? null}
    loading={loading}
    loadingMore={loadingMore}
    mutationsAvailable={mutationsAvailable}
    mutationBusy={mutationBusy !== null}
    error={error}
    onQuery={setQuery}
    onDirectory={openDirectory}
    onOpen={openEntry}
    onRename={requestRenameWorkspaceEntry}
    onDelete={requestDeleteWorkspaceEntry}
    onMore={showEntryWorkspaceActions}
    onLoadMore={() => void loadDirectory(directory, entries.length)}
  />
  const preview = selected
    ? !infoResolved
      ? infoError
        ? <View accessibilityRole="alert" style={styles.previewLoading}>
            <Text style={[styles.previewProblemTitle, { color: colors.text }]}>Could not check file access</Text>
            <Text style={[styles.previewProblemBody, { color: colors.muted }]}>{infoError}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry file access" onPress={() => setInfoRevision(value => value + 1)} style={[styles.previewRetry, { backgroundColor: colors.raised }]}><RefreshCw size={16} color={colors.blue} /><Text style={{ color: colors.blue, fontWeight: '700' }}>Retry</Text></Pressable>
          </View>
        : <View style={styles.previewLoading}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Checking file access…</Text></View>
      : <WorkspacePreview
          previewRevision={previewRevision}
          entry={selected}
          layout={layout}
          previewURL={workspacePreviewAllowed(info, selected)
            ? revisionedWorkspaceURL(connection.client.workspacePreviewURL(request.sessionId, selected.path), selected.revision)
            : undefined}
          headers={connection.client.authHeaders()}
          loadText={loadSelectedText}
          saveText={info && !info.read_only && info.capability_version >= 2 ? saveSelectedText : undefined}
          maxEditableBytes={Math.min(info?.max_text_file_bytes ?? Number.MAX_SAFE_INTEGER, layout === 'pad' ? 8 * 1024 * 1024 : 2 * 1024 * 1024)}
          onDirtyChange={setViewerDirty}
          onEditControllerChange={setEditController}
          onTextSaved={handleTextSaved}
          loadLocalPreview={workspacePreviewAllowed(info, selected) ? loadSelectedPDF : undefined}
          onDownload={downloadSelected}
        />
    : <EmptyState title="Select a file" body="Choose a workspace file to preview it without leaving the chat." />

  return <View onAccessibilityEscape={onClose} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}>
    <View collapsable={false} pointerEvents="auto" style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <SheetCloseButton onPress={onClose} label="Close workspace files" testID="workspace-file-viewer-close" activateOnPressIn />
      {layout === 'phone' && selected ? <IconButton icon={ChevronLeft} touchSize={44} onPress={goUp} label="Back to workspace files" activateOnPressIn /> : null}
      <View style={styles.headerIdentity}><Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{layout === 'phone' && selected ? selected.name : title}</Text><Text style={[styles.headerSubtitle, { color: colors.muted }]} numberOfLines={1}>{layout === 'phone' && selected ? selected.path : info?.root ?? 'Browse this chat’s working directory'}</Text></View>
      {layout === 'pad' && mutationsAvailable ? <IconButton icon={FilePlus} disabled={mutationControlsDisabled} onPress={() => requestCreateWorkspaceEntry('file')} label="Create workspace file" testID="workspace-create-file" activateOnPressIn /> : null}
      {layout === 'pad' && mutationsAvailable ? <IconButton icon={FolderPlus} disabled={mutationControlsDisabled} onPress={() => requestCreateWorkspaceEntry('directory')} label="Create workspace folder" testID="workspace-create-folder" activateOnPressIn /> : null}
      {layout === 'pad' && mutationsAvailable && selected ? <IconButton icon={Pencil} disabled={mutationControlsDisabled} onPress={() => { const current = selectedRef.current; if (current) requestRenameWorkspaceEntry(current) }} label={`Rename ${selected.name}`} testID="workspace-rename-selected" activateOnPressIn /> : null}
      {layout === 'pad' && mutationsAvailable && selected ? <IconButton icon={Trash2} disabled={mutationControlsDisabled} onPress={() => { const current = selectedRef.current; if (current) requestDeleteWorkspaceEntry(current) }} label={`Delete ${selected.name}`} testID="workspace-delete-selected" activateOnPressIn /> : null}
      {layout === 'pad' && selected ? <IconButton icon={Link} onPress={copySelectedPath} label="Copy file path" activateOnPressIn /> : null}
      {layout === 'pad' && selected ? <IconButton icon={Download} disabled={fileTransfer.busy || !connectionAvailable} onPress={downloadSelected} label="Download file" testID="workspace-file-viewer-download" activateOnPressIn /> : null}
      {layout === 'pad' && selected ? <IconButton icon={Share2} disabled={fileTransfer.busy || !connectionAvailable} onPress={shareSelected} label="Share file" testID="workspace-file-viewer-share" activateOnPressIn /> : null}
      {layout === 'pad' ? <IconButton icon={RefreshCw} onPress={refresh} label="Refresh workspace files" activateOnPressIn /> : null}
    </View>
    <FileTransferNotice state={fileTransfer.state} onCancel={fileTransfer.cancel} onDismiss={fileTransfer.dismiss} />
    {!connectionAvailable ? <View accessibilityRole="alert" style={[styles.connectionNotice, { borderColor: colors.border, backgroundColor: colors.surface }]}><ActivityIndicator size="small" color={colors.blue} /><Text style={[styles.connectionNoticeText, { color: colors.muted }]}>{reconnecting ? 'Reconnecting… Your open file and unsaved edits are preserved.' : 'Server offline. Your open file and unsaved edits are preserved.'}</Text></View> : null}
    {mutationBusy || mutationError ? <View accessibilityRole={mutationError ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[styles.mutationNotice, { borderColor: mutationError ? colors.red : colors.border, backgroundColor: colors.surface }]}>
      {mutationBusy ? <ActivityIndicator size="small" color={colors.blue} /> : <AlertCircle size={16} color={colors.red} />}
      <Text style={[styles.mutationNoticeText, { color: mutationError ? colors.red : colors.muted }]} numberOfLines={2}>{mutationError || workspaceMutationStatus(mutationBusy)}</Text>
      {mutationError && !mutationBusy ? <IconButton icon={X} touchSize={44} onPress={() => setMutationError('')} label="Dismiss workspace error" testID="workspace-mutation-error-dismiss" /> : null}
    </View> : null}
    <KeyboardAvoidingView
      style={styles.viewerBody}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? modalPadding.paddingTop : 0}
    >
      <View testID="workspace-file-viewer-panes" style={[styles.viewerPanes, layout === 'pad' && styles.padBody]}>
        <View
          testID="workspace-file-viewer-browser-pane"
          pointerEvents={paneVisibility.browser ? 'auto' : 'none'}
          accessibilityElementsHidden={!paneVisibility.browser}
          importantForAccessibility={paneVisibility.browser ? 'auto' : 'no-hide-descendants'}
          style={[layout === 'pad' ? [styles.sidebar, { borderColor: colors.border }] : styles.phoneBrowser, !paneVisibility.browser && styles.hiddenPane]}
        >{paneVisibility.browser ? browser : null}</View>
        <View
          testID="workspace-file-viewer-preview-pane"
          pointerEvents={paneVisibility.preview ? 'auto' : 'none'}
          accessibilityElementsHidden={!paneVisibility.preview}
          importantForAccessibility={paneVisibility.preview ? 'auto' : 'no-hide-descendants'}
          style={[styles.preview, !paneVisibility.preview && styles.hiddenPane]}
        >{preview}</View>
      </View>
      {layout === 'phone' ? <View collapsable={false} pointerEvents="auto" style={[styles.phoneActions, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        {mutationsAvailable ? <IconButton icon={MoreHorizontal} touchSize={44} disabled={mutationControlsDisabled} onPress={showPhoneWorkspaceActions} label="More workspace actions" testID="workspace-phone-actions" /> : null}
        {selected ? <IconButton icon={Link} touchSize={44} onPress={copySelectedPath} label="Copy file path" testID="workspace-file-viewer-copy" /> : null}
        {selected ? <IconButton icon={Download} touchSize={44} disabled={fileTransfer.busy || !connectionAvailable} onPress={downloadSelected} label="Download file" testID="workspace-file-viewer-download" /> : null}
        {selected ? <IconButton icon={Share2} touchSize={44} disabled={fileTransfer.busy || !connectionAvailable} onPress={shareSelected} label="Share file" testID="workspace-file-viewer-share" /> : null}
        <IconButton icon={RefreshCw} touchSize={44} onPress={refresh} label="Refresh workspace files" testID="workspace-file-viewer-refresh" />
      </View> : null}
    </KeyboardAvoidingView>
    {textPromptDialog}
  </View>
}

function WorkspaceBrowser({ layout, directory, entries, total, hasMore, query, selectedPath, loading, loadingMore, mutationsAvailable, mutationBusy, error, onQuery, onDirectory, onOpen, onRename, onDelete, onMore, onLoadMore }: {
  layout: 'phone' | 'pad'
  directory: string
  entries: WorkspaceEntry[]
  total: number
  hasMore: boolean
  query: string
  selectedPath: string | null
  loading: boolean
  loadingMore: boolean
  mutationsAvailable: boolean
  mutationBusy: boolean
  error: string
  onQuery: (value: string) => void
  onDirectory: (path: string) => void
  onOpen: (entry: WorkspaceEntry) => void
  onRename: (entry: WorkspaceEntry) => void
  onDelete: (entry: WorkspaceEntry) => void
  onMore: (entry: WorkspaceEntry) => void
  onLoadMore: () => void
}) {
  const colors = usePalette()
  const breadcrumbs = workspacePathSegments(directory)
  return <View style={styles.browser}>
    <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}><Search size={16} color={colors.muted} /><TextInput value={query} editable={!mutationBusy} onChangeText={onQuery} placeholder="Search workspace" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} returnKeyType="search" submitBehavior="blurAndSubmit" onSubmitEditing={dismissAppKeyboard} style={[styles.searchInput, { color: colors.text }]} /></View>
    <View style={styles.breadcrumbs}>{breadcrumbs.map((segment, index) => <Pressable key={segment.path || 'root'} accessibilityRole="button" accessibilityLabel={`Open ${segment.label}`} accessibilityState={{ disabled: mutationBusy }} disabled={mutationBusy} onPress={() => onDirectory(segment.path)} style={styles.breadcrumb}><Text style={{ color: index === breadcrumbs.length - 1 ? colors.text : colors.blue, fontSize: 11, fontWeight: '700' }} numberOfLines={1}>{segment.label}</Text>{index < breadcrumbs.length - 1 ? <ChevronRight size={12} color={colors.muted} /> : null}</Pressable>)}</View>
    {error ? <View style={[styles.inlineError, { backgroundColor: `${colors.red}12` }]}><Text style={{ color: colors.red, fontSize: 11 }}>{error}</Text></View> : null}
    {loading && !entries.length ? <View style={styles.browserLoading}><ActivityIndicator color={colors.blue} /></View> : <FlashList
      data={entries}
      keyExtractor={entry => entry.path}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <WorkspaceEntryRow layout={layout} entry={item} selected={selectedPath === item.path} mutationsAvailable={mutationsAvailable} mutationBusy={mutationBusy} onPress={() => onOpen(item)} onRename={() => onRename(item)} onDelete={() => onDelete(item)} onMore={() => onMore(item)} />}
      ListEmptyComponent={<EmptyState title={query.trim() ? 'No matching files' : 'This folder is empty'} body={query.trim() ? 'Try another file name or path.' : undefined} />}
      ListFooterComponent={hasMore ? <Pressable accessibilityRole="button" accessibilityLabel="Load more workspace files" accessibilityState={{ disabled: loadingMore || mutationBusy }} disabled={loadingMore || mutationBusy} onPress={onLoadMore} style={[styles.loadMore, { backgroundColor: colors.raised }]}>{loadingMore ? <ActivityIndicator color={colors.blue} /> : <Text style={{ color: colors.blue, fontWeight: '700' }}>Load more · {entries.length}/{total}</Text>}</Pressable> : null}
    />}
  </View>
}

function WorkspaceEntryRow({ layout, entry, selected, mutationsAvailable, mutationBusy, onPress, onRename, onDelete, onMore }: { layout: 'phone' | 'pad'; entry: WorkspaceEntry; selected: boolean; mutationsAvailable: boolean; mutationBusy: boolean; onPress: () => void; onRename: () => void; onDelete: () => void; onMore: () => void }) {
  const colors = usePalette()
  const EntryIcon = entry.kind === 'directory' ? Folder : File
  const openDisabled = entry.kind === 'symlink' || mutationBusy
  return <View style={[styles.entry, { backgroundColor: selected ? colors.raised : 'transparent' }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${entry.kind === 'directory' ? 'Open folder' : 'Open file'} ${entry.name}`} accessibilityState={{ selected, disabled: openDisabled }} disabled={openDisabled} onPress={onPress} style={({ pressed }) => [styles.entryOpen, { opacity: entry.kind === 'symlink' ? 0.45 : pressed ? 0.65 : entry.hidden ? 0.72 : 1 }]}>
      <EntryIcon size={18} color={entry.kind === 'directory' ? colors.blue : colors.muted} />
      <View style={styles.entryIdentity}><Text style={{ color: colors.text, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{entry.name}</Text><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{entry.kind === 'directory' ? 'Folder' : entry.kind === 'symlink' ? 'Secure link preview unavailable' : formatBytes(entry.size)}</Text></View>
      <ChevronRight size={15} color={colors.muted} />
    </Pressable>
    {mutationsAvailable && layout === 'phone' ? <IconButton icon={MoreHorizontal} touchSize={44} disabled={mutationBusy} onPress={onMore} label={`More actions for ${entry.name}`} testID={`workspace-entry-more-${entry.path}`} /> : null}
    {mutationsAvailable && layout === 'pad' ? <View style={styles.entryActions}>
      <IconButton icon={Pencil} size={15} touchSize={44} disabled={mutationBusy} onPress={onRename} label={`Rename ${entry.name}`} testID={`workspace-entry-rename-${entry.path}`} />
      <IconButton icon={Trash2} size={15} touchSize={44} disabled={mutationBusy} onPress={onDelete} label={`Delete ${entry.name}`} testID={`workspace-entry-delete-${entry.path}`} />
    </View> : null}
  </View>
}

function WorkspacePreview({ entry, layout, previewRevision, previewURL, headers, loadText, saveText, maxEditableBytes, loadLocalPreview, onDirtyChange, onEditControllerChange, onTextSaved, onDownload }: {
  entry: WorkspaceEntry
  layout: 'phone' | 'pad'
  previewRevision: number
  previewURL?: string
  headers: Record<string, string>
  loadText: (limit: number) => Promise<LoadedFileText>
  saveText?: (content: string, expectedRevision: string) => Promise<LoadedFileText>
  maxEditableBytes: number
  loadLocalPreview?: () => Promise<string>
  onDirtyChange: (dirty: boolean) => void
  onEditControllerChange: (controller: FilePreviewEditController | null) => void
  onTextSaved: (saved: LoadedFileText, hasNewerDraft: boolean) => void
  onDownload: () => void
}) {
  return <FilePreview key={`${entry.path}:${previewRevision}`} name={entry.name} path={entry.path} contentType={inferredMobileFileContentType(entry.name)} size={entry.size} layout={layout} previewURL={previewURL} headers={headers} loadText={loadText} saveText={saveText} maxEditableBytes={maxEditableBytes} loadLocalPreview={loadLocalPreview} onDirtyChange={onDirtyChange} onEditControllerChange={onEditControllerChange} onTextSaved={onTextSaved} onDownload={onDownload} />
}

function UnavailableWorkspaceViewer({ reconnecting, sessionChanged, modalPadding, onClose }: { reconnecting: boolean; sessionChanged: boolean; modalPadding: ReturnType<typeof fullscreenModalPadding>; onClose: () => void }) {
  const colors = usePalette()
  return <View onAccessibilityEscape={onClose} style={[styles.root, { backgroundColor: colors.background }, modalPadding]}><View collapsable={false} pointerEvents="auto" style={[styles.header, { borderColor: colors.border, backgroundColor: colors.background }]}><SheetCloseButton onPress={onClose} label="Close workspace files" testID="workspace-file-viewer-close" activateOnPressIn /><Text style={[styles.headerTitle, { color: colors.text }]}>Workspace files</Text></View><EmptyState title={sessionChanged ? 'Chat changed' : reconnecting ? 'Verifying file access…' : 'Server unavailable'} body={sessionChanged ? 'Close this viewer and open Files from the active chat.' : 'Reconnect this server to browse the chat workspace.'} /></View>
}

function mergeWorkspaceEntries(current: WorkspaceEntry[], incoming: WorkspaceEntry[]): WorkspaceEntry[] {
  const byPath = new Map(current.map(entry => [entry.path, entry]))
  for (const entry of incoming) byPath.set(entry.path, entry)
  return [...byPath.values()]
}

function workspaceEntryNameError(name: string): string {
  if (!name.trim()) return 'Enter a file or folder name.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return 'Names cannot contain slashes.'
  return ''
}

function validWorkspaceEntryRevision(value?: string): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function validatedWorkspaceMutationEntry(entry: WorkspaceEntry, expectedPath: string, expectedKind: WorkspaceEntry['kind']): WorkspaceEntry {
  if (entry.path !== expectedPath || entry.kind !== expectedKind) throw new Error('The server returned a different workspace entry.')
  if (!validWorkspaceEntryRevision(entry.revision)) throw new Error('The server returned an invalid workspace entry revision.')
  if (entry.name !== expectedPath.split('/').at(-1)) throw new Error('The server returned an invalid workspace entry name.')
  return entry
}

function workspacePathIsWithin(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

function remapWorkspacePath(path: string, previousPath: string, nextPath: string): string {
  return path === previousPath ? nextPath : `${nextPath}${path.slice(previousPath.length)}`
}

function workspaceMutationStatus(kind: 'create' | 'rename' | 'delete' | null): string {
  if (kind === 'create') return 'Creating workspace entry…'
  if (kind === 'rename') return 'Renaming workspace entry…'
  if (kind === 'delete') return 'Deleting workspace entry…'
  return ''
}

function workspaceConnectionIsCurrent(connection: WorkspaceConnectionScope): boolean {
  const state = useAppStore.getState()
  return workspaceConnectionIdentityIsCurrent(connection)
    && connection.client.isValidated
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}

function workspaceConnectionIdentityIsCurrent(connection: WorkspaceConnectionScope): boolean {
  const state = useAppStore.getState()
  return !connection.client.isDisposed
    && client === connection.client
    && state.activeProfileId === connection.profileId
    && state.profileGeneration === connection.generation
    && state.selectedSessionId === connection.sessionId
}

function validatedWorkspaceText(file: WorkspaceFile, expectedPath: string, limit: number): LoadedFileText {
  if (file.path !== expectedPath) throw new Error('The server returned a different workspace file.')
  if (!/^[a-f0-9]{64}$/i.test(file.revision)) throw new Error('The server returned an invalid workspace file revision.')
  const contentBytes = new TextEncoder().encode(file.content).byteLength
  if (!Number.isFinite(file.size) || file.size < 0 || file.size !== contentBytes || contentBytes > limit) throw new Error(`This file exceeds the ${formatBytes(limit)} mobile editing limit.`)
  return { content: file.content, revision: file.revision, writable: file.writable, size: file.size, mtime_ns: file.mtime_ns }
}

function workspacePreviewAllowed(info: WorkspaceInfo | null, entry: WorkspaceEntry): boolean {
  if (typeof entry.size === 'number' && typeof info?.max_preview_file_bytes === 'number' && entry.size > info.max_preview_file_bytes) return false
  const contentType = inferredMobileFileContentType(entry.name).toLowerCase()
  const advertised = info?.preview_media_types
  if (!advertised?.length) return contentType.startsWith('image/') || contentType === 'application/pdf'
  return advertised.some(value => {
    const pattern = value.toLowerCase().trim()
    return pattern.endsWith('/*') ? contentType.startsWith(pattern.slice(0, -1)) : pattern === contentType
  })
}
function revisionedWorkspaceURL(url: string, revision?: string): string {
  return revision ? `${url}${url.includes('?') ? '&' : '?'}revision=${encodeURIComponent(revision)}` : url
}
function scopedWorkspaceCacheKey(connection: WorkspaceConnectionScope, sessionId: string, entry: WorkspaceEntry): string {
  const serverScopedURL = connection.client.workspaceDownloadURL(sessionId, entry.path)
  return stableHash(`${connection.cacheNamespace}\u0000${serverScopedURL}\u0000${entry.revision ?? entry.mtime_ns ?? ''}`)
}
function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
function fileViewerError(cause: unknown): string { return (cause instanceof Error ? cause.message : String(cause)).replace(/^Error:\s*/i, '').trim() || 'The workspace request failed.' }
async function prepareWorkspaceEditorForDeparture(controller: FilePreviewEditController | null): Promise<boolean> {
  if (!controller) {
    dismissAppKeyboard()
    return true
  }
  try {
    const prepared = await controller.prepareForDeparture()
    dismissAppKeyboard()
    return prepared
  } catch {
    controller.blur()
    dismissAppKeyboard()
    return false
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  viewerBody: { flex: 1, minHeight: 0 },
  connectionNotice: { minHeight: 44, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  connectionNoticeText: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: 15, fontWeight: '700' },
  mutationNotice: { minHeight: 48, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  mutationNoticeText: { flex: 1, minWidth: 0, fontSize: 11, lineHeight: 15, fontWeight: '700' },
  header: { minHeight: 64, flexShrink: 0, position: 'relative', zIndex: 20, elevation: 20, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerIdentity: { flex: 1, minWidth: 0 },
  headerTitle: { flex: 1, fontSize: 15, fontWeight: '800' },
  headerSubtitle: { fontSize: 10, marginTop: 2 },
  viewerPanes: { flex: 1, minHeight: 0 },
  padBody: { flexDirection: 'row' },
  hiddenPane: { display: 'none' },
  sidebar: { width: 286, minWidth: 220, maxWidth: 340, borderRightWidth: StyleSheet.hairlineWidth },
  preview: { flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' },
  previewLoading: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', gap: 9 },
  previewProblemTitle: { fontSize: 16, lineHeight: 21, fontWeight: '800', textAlign: 'center' },
  previewProblemBody: { maxWidth: 420, paddingHorizontal: 18, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  previewRetry: { minHeight: 44, borderRadius: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  phoneActions: { minHeight: 52, flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  phoneBrowser: { flex: 1, minHeight: 0 },
  browser: { flex: 1, minHeight: 0, paddingHorizontal: 8, paddingTop: 8 },
  search: { minHeight: 44, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7 },
  searchInput: { flex: 1, minWidth: 0, minHeight: 42, fontSize: 13, paddingVertical: 0 },
  breadcrumbs: { minHeight: 38, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingHorizontal: 4, paddingVertical: 5 },
  breadcrumb: { minHeight: 44, maxWidth: 150, flexDirection: 'row', alignItems: 'center' },
  inlineError: { borderRadius: 7, padding: 9, marginBottom: 6 },
  browserLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  entry: { minHeight: 52, borderRadius: 7, flexDirection: 'row', alignItems: 'center' },
  entryOpen: { flex: 1, minWidth: 0, minHeight: 52, paddingLeft: 9, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  entryActions: { flexShrink: 0, flexDirection: 'row', alignItems: 'center' },
  entryIdentity: { flex: 1, minWidth: 0, gap: 2 },
  loadMore: { minHeight: 46, borderRadius: 7, marginVertical: 8, alignItems: 'center', justifyContent: 'center' },
})
