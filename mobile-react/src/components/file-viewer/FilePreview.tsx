import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UITextView as SelectableText } from '@bsky.app/react-native-uitextview'
import { Image } from 'expo-image'
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { AlertCircle, Code2, Download, Eye, FileQuestion, RefreshCw, RotateCcw, Save, Columns2 } from 'lucide-react-native'
import { MobileCodeEditor, type MobileCodeEditorController, type MobileCodeEditorSnapshot } from '../../editor/MobileCodeEditor'
import {
  defaultWorkspaceMarkdownMode,
  MARKDOWN_LIVE_PREVIEW_MAX_BYTES,
  workspaceMarkdownModeForLayout,
  workspaceMarkdownPaneVisibility,
  type WorkspaceMarkdownMode,
} from '../../editor/workspaceEditorLayout'
import { mobileFileViewerKind, mobileTextPreviewLimit, type MobileFileViewerLayout } from '../../lib/file-viewer'
import { dismissAppKeyboard } from '../../lib/app-keyboard'
import { utf8ByteLength, workspaceTextIsDirectlyEditable } from '../../lib/workspace-file-editing'
import { usePalette } from '../../theme'
import { Text, TextInput } from '../AppText'
import { SwipeDismissImage } from '../FullscreenImageViewer'
import { MarkdownContent } from '../MarkdownContent'

export interface LoadedFileText {
  content: string
  truncated?: boolean
  revision?: string
  writable?: boolean
  size?: number
  mtime_ns?: number
}

export interface FilePreviewEditController {
  dirty: boolean
  saving: boolean
  save: () => Promise<boolean>
  blur: () => void
  prepareForDeparture: () => Promise<boolean>
  hasUnsavedChanges: () => boolean
  hasNewerDraftSinceSave: () => boolean
  isSaving: () => boolean
  canSave: () => boolean
}

export interface FilePreviewProps {
  name: string
  path?: string
  contentType?: string | null
  size?: number | null
  layout: MobileFileViewerLayout
  previewURL?: string
  fallbackPreviewURL?: string
  headers?: Record<string, string>
  loadText?: (limit: number) => Promise<LoadedFileText>
  saveText?: (content: string, expectedRevision: string) => Promise<LoadedFileText>
  maxEditableBytes?: number
  loadLocalPreview?: () => Promise<string>
  onDirtyChange?: (dirty: boolean) => void
  onEditControllerChange?: (controller: FilePreviewEditController | null) => void
  onTextSaved?: (saved: LoadedFileText, hasNewerDraft: boolean) => void
  imageViewer?: {
    onDismiss?: () => void
    testID: string
    gestureTestID: string
  }
  onDownload: () => void
}

export function FilePreview({ name, path, contentType, size, layout, previewURL, fallbackPreviewURL, headers, loadText, saveText, maxEditableBytes, loadLocalPreview, onDirtyChange, onEditControllerChange, onTextSaved, imageViewer, onDownload }: FilePreviewProps) {
  const colors = usePalette()
  const kind = mobileFileViewerKind(name, contentType)
  const textLimit = mobileTextPreviewLimit(layout)
  const serverTextLimit = typeof maxEditableBytes === 'number' && Number.isFinite(maxEditableBytes) && maxEditableBytes > 0 ? maxEditableBytes : textLimit
  // A mounted file keeps one limit. Responsive layout or late capability
  // updates must never reload and replace a draft that the user is editing.
  const effectiveTextLimit = useRef(Math.min(textLimit, serverTextLimit)).current
  const tooLargeForText = (kind === 'text' || kind === 'markdown') && typeof size === 'number' && size > effectiveTextLimit
  const [revision, setRevision] = useState(0)
  const [text, setText] = useState<LoadedFileText | null>(null)
  const [localPreview, setLocalPreview] = useState<string | null>(null)
  const [activePreviewURL, setActivePreviewURL] = useState(previewURL)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draftState, setDraftState] = useState({ dirty: false, utf8Bytes: 0, lines: 1, hasNull: false })
  const [markdownMode, setMarkdownMode] = useState<WorkspaceMarkdownMode>('source')
  const [markdownPreview, setMarkdownPreview] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveRequiresReload, setSaveRequiresReload] = useState(false)
  const [editorFallback, setEditorFallback] = useState(false)
  const [fallbackRevision, setFallbackRevision] = useState(0)
  const mounted = useRef(true)
  const saveInFlight = useRef(false)
  const saveRequiresReloadRef = useRef(saveRequiresReload)
  const editorRef = useRef<MobileCodeEditorController>(null)
  const editorReadyRef = useRef(false)
  const fallbackEditorRef = useRef<TextInput>(null)
  // The editor's document prop is an initialization/replacement input, not the
  // server's latest clean baseline. Keep it stable while a save acknowledges
  // an older snapshot so a React render cannot replace newer in-flight typing.
  const editorDocumentValueRef = useRef('')
  const draftRef = useRef('')
  const textRef = useRef(text)
  const submittedDraftRef = useRef<string | null>(null)
  const markdownPreviewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markdownModeRef = useRef(markdownMode)
  const layoutRef = useRef(layout)
  markdownModeRef.current = markdownMode
  layoutRef.current = layout
  const updateSaveRequiresReload = useCallback((value: boolean) => {
    saveRequiresReloadRef.current = value
    setSaveRequiresReload(value)
  }, [])
  const dirty = draftState.dirty
  const draftValidationError = dirty && draftState.hasNull
    ? 'Remove the null character before saving.'
    : dirty && draftState.utf8Bytes > effectiveTextLimit
      ? `Draft exceeds the ${formatLimit(effectiveTextLimit)} editing limit.`
      : ''
  const updateDraft = useCallback((value: string, metadata?: { utf8Bytes?: number; lines?: number }) => {
    draftRef.current = value
    const authoritative = textRef.current
    const nextDirty = Boolean(authoritative && value !== authoritative.content)
    const next = {
      dirty: nextDirty,
      utf8Bytes: metadata?.utf8Bytes ?? utf8ByteLength(value),
      lines: metadata?.lines ?? countLines(value),
      hasNull: value.includes('\0'),
    }
    setDraftState(current => current.dirty === next.dirty
      && current.utf8Bytes === next.utf8Bytes
      && current.lines === next.lines
      && current.hasNull === next.hasNull ? current : next)
    onDirtyChange?.(nextDirty)
    if (kind === 'markdown' && markdownModeRef.current === 'split' && next.utf8Bytes <= MARKDOWN_LIVE_PREVIEW_MAX_BYTES) {
      if (markdownPreviewTimer.current) clearTimeout(markdownPreviewTimer.current)
      markdownPreviewTimer.current = setTimeout(() => setMarkdownPreview(value), 220)
    }
  }, [kind, onDirtyChange])
  const hasUnsavedChanges = useCallback(() => Boolean(
    textRef.current && draftRef.current !== textRef.current.content,
  ), [])
  const hasNewerDraftSinceSave = useCallback(() => Boolean(
    submittedDraftRef.current != null && draftRef.current !== submittedDraftRef.current,
  ), [])
  const isSaving = useCallback(() => saveInFlight.current, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (markdownPreviewTimer.current) clearTimeout(markdownPreviewTimer.current)
    }
  }, [])
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  useEffect(() => {
    let current = true
    textRef.current = null
    editorDocumentValueRef.current = ''
    setText(null)
    setLocalPreview(null)
    setActivePreviewURL(previewURL)
    setError('')
    setEditing(false)
    setMarkdownMode('source')
    setMarkdownPreview('')
    setSaving(false)
    setSaveError('')
    setEditorFallback(false)
    editorReadyRef.current = false
    updateSaveRequiresReload(false)
    if ((kind === 'text' || kind === 'markdown') && !tooLargeForText && loadText) {
      setLoading(true)
      void loadText(effectiveTextLimit).then(value => {
        if (current) {
          textRef.current = value
          editorDocumentValueRef.current = value.content
          setText(value)
          updateDraft(value.content)
          // Enter edit mode in the same render that installs workspace text.
          // Rendering a large Markdown preview for one frame can block the JS
          // thread before the user can reach the editor or dismiss the modal.
          setEditing(workspaceTextIsDirectlyEditable(value, Boolean(saveText), effectiveTextLimit))
          if (kind === 'markdown') {
            const bytes = utf8ByteLength(value.content)
            setMarkdownPreview(value.content)
            setMarkdownMode(defaultWorkspaceMarkdownMode(layoutRef.current, bytes))
          }
        }
      }).catch(cause => {
        if (current) setError(viewerErrorMessage(cause))
      }).finally(() => {
        if (current) setLoading(false)
      })
    } else if (kind === 'pdf' && loadLocalPreview) {
      setLoading(true)
      void loadLocalPreview().then(value => {
        if (current) setLocalPreview(value)
      }).catch(cause => {
        if (current) setError(viewerErrorMessage(cause))
      }).finally(() => {
        if (current) setLoading(false)
      })
    } else {
      setLoading(false)
    }
    return () => { current = false }
  }, [effectiveTextLimit, kind, loadLocalPreview, loadText, previewURL, revision, tooLargeForText, updateDraft, updateSaveRequiresReload])

  useEffect(() => {
    setMarkdownMode(current => workspaceMarkdownModeForLayout(current, layout))
  }, [layout])

  const canSaveCurrentDraft = useCallback(() => {
    const authoritative = textRef.current
    const currentDraft = draftRef.current
    return Boolean(
      authoritative?.revision
        && saveText
        && workspaceTextIsDirectlyEditable(authoritative, true, effectiveTextLimit)
        && !saveRequiresReloadRef.current
        && !saveInFlight.current
        && currentDraft !== authoritative.content
        && !currentDraft.includes('\0')
        && utf8ByteLength(currentDraft) <= effectiveTextLimit,
    )
  }, [effectiveTextLimit, saveText])
  const workspaceDocument = Boolean(text && (saveText || typeof text.writable === 'boolean'))
  const blurEditor = useCallback(() => {
    editorRef.current?.blur()
    fallbackEditorRef.current?.blur()
    dismissAppKeyboard()
  }, [])
  const acceptEditorSnapshot = useCallback((snapshot: MobileCodeEditorSnapshot) => {
    updateDraft(snapshot.value, { utf8Bytes: snapshot.utf8Bytes, lines: snapshot.lines })
    return snapshot
  }, [updateDraft])
  const prepareForDeparture = useCallback(async () => {
    const controller = editorRef.current
    if (!controller || editorFallback) {
      fallbackEditorRef.current?.blur()
      dismissAppKeyboard()
      return true
    }
    // Publish the native mirror first. Even if WebKit cannot acknowledge the
    // final blur, close/back still sees every sequenced edit already received.
    acceptEditorSnapshot(controller.getSnapshot())
    try {
      acceptEditorSnapshot(await withEditorCheckpointTimeout(controller.flushAndBlur()))
      dismissAppKeyboard()
      return true
    } catch (cause) {
      const latestSnapshot = acceptEditorSnapshot(controller.getSnapshot())
      controller.blur()
      dismissAppKeyboard()
      // A viewer must remain immediately dismissible while WebKit is still
      // starting. If the native mirror is clean, a missed checkpoint cannot
      // represent unsaved input, so do not invent a dirty draft or confirmation.
      if (!editorReadyRef.current && !latestSnapshot.dirty && !hasUnsavedChanges()) return true
      setSaveError(`Could not confirm the latest editor input: ${viewerErrorMessage(cause)}`)
      onDirtyChange?.(true)
      return false
    }
  }, [acceptEditorSnapshot, editorFallback, hasUnsavedChanges, onDirtyChange])
  const afterEditorBlur = useCallback((action: () => void) => {
    void prepareForDeparture().finally(() => requestAnimationFrame(action))
  }, [prepareForDeparture])
  const revertDraft = useCallback(() => {
    if (!text || saving) return
    editorDocumentValueRef.current = text.content
    updateDraft(text.content)
    editorRef.current?.replaceDocument(text.content, { clean: true })
    setFallbackRevision(value => value + 1)
    setMarkdownPreview(text.content)
    if (!saveRequiresReload) setSaveError('')
    setEditing(workspaceTextIsDirectlyEditable(text, Boolean(saveText), effectiveTextLimit))
  }, [effectiveTextLimit, saveRequiresReload, saveText, saving, text, updateDraft])
  const confirmRevertDraft = useCallback(() => {
    if (!dirty || saving) return
    afterEditorBlur(() => Alert.alert('Discard unsaved changes?', 'Your edits have not been saved.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Revert', style: 'destructive', onPress: revertDraft },
    ]))
  }, [afterEditorBlur, dirty, revertDraft, saving])
  const reloadText = useCallback(() => {
    const reload = () => {
      textRef.current = null
      setText(null)
      onDirtyChange?.(false)
      setLoading(true)
      setEditing(false)
      setSaveError('')
      updateSaveRequiresReload(false)
      setRevision(value => value + 1)
    }
    if (!dirty) {
      blurEditor()
      reload()
      return
    }
    afterEditorBlur(() => Alert.alert('Reload file from disk?', 'This will discard your unsaved edits.', [
      { text: 'Keep Editing', style: 'cancel' },
      { text: 'Reload', style: 'destructive', onPress: reload },
    ]))
  }, [afterEditorBlur, blurEditor, dirty, onDirtyChange, updateSaveRequiresReload])
  const saveEditing = useCallback(async () => {
    const authoritative = textRef.current
    if (!authoritative?.revision || !saveText || saveInFlight.current) return false
    const controller = editorRef.current
    if (controller && !editorFallback) {
      try {
        acceptEditorSnapshot(await controller.flushAndBlur())
        dismissAppKeyboard()
      } catch (cause) {
        acceptEditorSnapshot(controller.getSnapshot())
        setSaveError(`Could not confirm the latest editor input: ${viewerErrorMessage(cause)}`)
        return false
      }
    }
    if (!canSaveCurrentDraft()) return false
    const submittedDraft = draftRef.current
    const submittedBytes = utf8ByteLength(submittedDraft)
    if (submittedDraft.includes('\0')) {
      setSaveError('Workspace text files cannot contain null bytes.')
      return false
    }
    if (submittedBytes > effectiveTextLimit) {
      setSaveError(`Your edit is ${formatLimit(submittedBytes)} and exceeds the ${formatLimit(effectiveTextLimit)} mobile editing limit.`)
      return false
    }
    saveInFlight.current = true
    submittedDraftRef.current = submittedDraft
    setSaving(true)
    setSaveError('')
    try {
      const saved = await saveText(submittedDraft, authoritative.revision)
      if (!mounted.current) return false
      const hasNewerDraft = draftRef.current !== submittedDraft
      textRef.current = saved
      setText(saved)
      updateSaveRequiresReload(false)
      onTextSaved?.(saved, hasNewerDraft)
      if (!hasNewerDraft) {
        editorDocumentValueRef.current = saved.content
        updateDraft(saved.content)
        editorRef.current?.replaceDocument(saved.content, { clean: true })
        setMarkdownPreview(saved.content)
        setEditing(workspaceTextIsDirectlyEditable(saved, Boolean(saveText), effectiveTextLimit))
        return true
      }
      editorRef.current?.markClean(saved.content)
      return false
    } catch (cause) {
      if (!mounted.current) return false
      updateSaveRequiresReload(workspaceSaveRequiresReload(cause))
      setSaveError(workspaceSaveErrorMessage(cause))
      return false
    } finally {
      saveInFlight.current = false
      submittedDraftRef.current = null
      if (mounted.current) setSaving(false)
    }
  }, [acceptEditorSnapshot, canSaveCurrentDraft, editorFallback, effectiveTextLimit, onTextSaved, saveText, updateDraft, updateSaveRequiresReload])
  const editController = useMemo<FilePreviewEditController | null>(() => editing || dirty ? {
    dirty,
    saving,
    save: saveEditing,
    blur: blurEditor,
    prepareForDeparture,
    hasUnsavedChanges,
    hasNewerDraftSinceSave,
    isSaving,
    canSave: canSaveCurrentDraft,
  } : null, [blurEditor, canSaveCurrentDraft, dirty, editing, hasNewerDraftSinceSave, hasUnsavedChanges, isSaving, prepareForDeparture, saveEditing, saving])
  useEffect(() => {
    onEditControllerChange?.(editController)
    return () => onEditControllerChange?.(null)
  }, [editController, onEditControllerChange])

  const selectMarkdownMode = useCallback((nextMode: WorkspaceMarkdownMode) => {
    const normalized = workspaceMarkdownModeForLayout(nextMode, layoutRef.current)
    const reveal = (value: string) => {
      if (normalized !== 'source') setMarkdownPreview(value)
      setMarkdownMode(normalized)
      if (normalized === 'source') requestAnimationFrame(() => editorRef.current?.focus())
    }
    const controller = editorRef.current
    if (!controller || editorFallback) {
      fallbackEditorRef.current?.blur()
      dismissAppKeyboard()
      reveal(draftRef.current)
      return
    }
    void withEditorCheckpointTimeout(controller.flushAndBlur()).then(snapshot => {
      acceptEditorSnapshot(snapshot)
      reveal(snapshot.value)
    }).catch(() => {
      const snapshot = controller.getSnapshot()
      acceptEditorSnapshot(snapshot)
      reveal(snapshot.value)
    })
  }, [acceptEditorSnapshot, editorFallback])
  const handleEditorStatus = useCallback((status: { fallback: boolean; ready: boolean }) => {
    editorReadyRef.current = status.ready
    setEditorFallback(status.fallback)
  }, [])
  const handleEditorLimit = useCallback((details: { maxBytes: number; attemptedBytes: number }) => {
    setSaveError(`Edit would be ${formatLimit(details.attemptedBytes)} and exceed the ${formatLimit(details.maxBytes)} mobile limit.`)
  }, [])
  const effectiveMarkdownMode = workspaceMarkdownModeForLayout(markdownMode, layout)
  const markdownPanes = workspaceMarkdownPaneVisibility(effectiveMarkdownMode)

  const webSource = useMemo(() => {
    const uri = localPreview ?? previewURL
    return uri ? { uri, headers: localPreview ? undefined : headers } : null
  }, [headers, localPreview, previewURL])

  if (loading) return <View style={styles.center}><ActivityIndicator color={colors.blue} /><Text style={{ color: colors.muted }}>Opening {name}…</Text></View>
  if (error) return <PreviewProblem title="Could not open file" message={error} onRetry={() => setRevision(value => value + 1)} onDownload={onDownload} />
  if (tooLargeForText) return <PreviewProblem title="Preview is memory bounded" message={`${name} is larger than the ${formatLimit(effectiveTextLimit)} ${layout === 'pad' ? 'iPad' : 'iPhone'} text preview limit.`} onDownload={onDownload} />

  if (kind === 'image' && activePreviewURL) {
    return <SwipeDismissImage
      onDismiss={imageViewer?.onDismiss}
      testID={imageViewer?.testID ?? 'file-preview-image-zoom-surface'}
      gestureTestID={imageViewer?.gestureTestID ?? 'file-preview-image-zoom-gesture'}
      resetKey={activePreviewURL}
      style={[styles.imageCanvas, { backgroundColor: colors.background }]}
    >
      <Image source={{ uri: activePreviewURL, headers }} contentFit="contain" cachePolicy={fallbackPreviewURL && activePreviewURL !== fallbackPreviewURL ? 'none' : 'memory-disk'} onError={event => {
        if (fallbackPreviewURL && activePreviewURL !== fallbackPreviewURL) setActivePreviewURL(fallbackPreviewURL)
        else setError(event.error || 'The image could not be decoded.')
      }} style={StyleSheet.absoluteFill} />
    </SwipeDismissImage>
  }
  if (kind === 'pdf' && Platform.OS === 'android') {
    return <PreviewProblem
      title="Open PDF on Android"
      message="Android WebView does not include a PDF renderer. Download or share this file to open it with the device PDF viewer."
      onDownload={onDownload}
    />
  }
  if (kind === 'pdf' && webSource) {
    return <WebView
      testID="file-viewer-pdf"
      source={webSource}
      originWhitelist={['file://*', 'http://*', 'https://*', 'about:*']}
      javaScriptEnabled={false}
      cacheEnabled={false}
      incognito
      setSupportMultipleWindows={false}
      allowsBackForwardNavigationGestures={false}
      onShouldStartLoadWithRequest={request => {
        const allowed = request.url === webSource.uri || request.url === 'about:blank'
        if (!allowed && request.navigationType === 'click' && /^https?:/i.test(request.url)) void Linking.openURL(request.url).catch(() => undefined)
        return allowed
      }}
      onHttpError={event => setError(`PDF request failed with HTTP ${event.nativeEvent.statusCode}.`)}
      onError={event => setError(event.nativeEvent.description || 'The PDF viewer failed to load.')}
      style={{ backgroundColor: colors.background }}
    />
  }
  if ((kind === 'markdown' || kind === 'text') && text) {
    const plainTextEditor = <TextInput
      key={`${fallbackRevision}:plain`}
      ref={fallbackEditorRef}
      testID="workspace-file-editor-fallback"
      accessibilityLabel={`Edit ${name} in plain text mode`}
      multiline
      scrollEnabled
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      defaultValue={draftRef.current}
      onChangeText={updateDraft}
      textAlignVertical="top"
      style={[styles.editor, layout === 'pad' && styles.editorPad, { color: colors.text, backgroundColor: colors.background }]}
    />
    return <View style={styles.documentViewer}>
      {workspaceDocument ? <View collapsable={false} pointerEvents="auto" style={[styles.editorToolbar, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.editorStatus}>
          <Text style={[styles.editorStatusText, { color: saveError || draftValidationError ? colors.red : dirty ? colors.orange : colors.muted }]} numberOfLines={1}>
            {saving ? 'Saving…' : saveError || draftValidationError || (dirty ? 'Unsaved changes' : editing ? 'Editing' : 'Read only')}
          </Text>
        </View>
        {saveError ? <EditorAction icon={RefreshCw} label="Reload" accessibilityLabel="Reload file from disk" testID="workspace-file-edit-reload" onPress={reloadText} /> : null}
        {editing
          ? <>
              {kind === 'markdown' ? <EditorAction icon={Code2} label="Source" accessibilityLabel="Show Markdown source" testID="workspace-markdown-source" selected={effectiveMarkdownMode === 'source'} onPress={() => selectMarkdownMode('source')} /> : null}
              {kind === 'markdown' && layout === 'pad' ? <EditorAction icon={Columns2} label="Split" accessibilityLabel="Show Markdown source and preview" testID="workspace-markdown-split" selected={effectiveMarkdownMode === 'split'} onPress={() => selectMarkdownMode('split')} /> : null}
              {kind === 'markdown' ? <EditorAction icon={Eye} label="Preview" accessibilityLabel="Preview Markdown" testID="workspace-markdown-preview" selected={effectiveMarkdownMode === 'preview'} onPress={() => selectMarkdownMode('preview')} /> : null}
              <EditorAction icon={RotateCcw} label="Revert" accessibilityLabel="Revert unsaved file changes" testID="workspace-file-edit-revert" disabled={saving || !dirty} onPress={confirmRevertDraft} />
              <EditorAction icon={Save} label={saving ? 'Saving' : 'Save'} accessibilityLabel="Save file" testID="workspace-file-edit-save" emphasized disabled={!canSaveCurrentDraft()} onPress={() => void saveEditing()} />
            </>
          : null}
      </View> : null}
      {editing ? <View style={[styles.editorPanes, layout === 'pad' && effectiveMarkdownMode === 'split' && styles.editorPanesSplit]}>
        <View
          pointerEvents={markdownPanes.source ? 'auto' : 'none'}
          accessibilityElementsHidden={!markdownPanes.source}
          importantForAccessibility={markdownPanes.source ? 'auto' : 'no-hide-descendants'}
          style={[styles.editorSourcePane, !markdownPanes.source && styles.hiddenEditorPane]}
        >
          <MobileCodeEditor
            ref={editorRef}
            testID="workspace-file-editor"
            path={path ?? name}
            value={editorDocumentValueRef.current}
            readOnly={false}
            maxBytes={effectiveTextLimit}
            autoFocus={false}
            onChange={(value, metadata) => updateDraft(value, metadata)}
            onStatusChange={handleEditorStatus}
            onLimitExceeded={handleEditorLimit}
            onError={cause => setSaveError(viewerErrorMessage(cause))}
            renderFallback={() => plainTextEditor}
          />
        </View>
        {kind === 'markdown' ? <ScrollView
          testID="workspace-markdown-live-preview"
          pointerEvents={markdownPanes.preview ? 'auto' : 'none'}
          accessibilityElementsHidden={!markdownPanes.preview}
          importantForAccessibility={markdownPanes.preview ? 'auto' : 'no-hide-descendants'}
          style={[styles.markdownPreviewPane, !markdownPanes.preview && styles.hiddenEditorPane, layout === 'pad' && effectiveMarkdownMode === 'split' && [styles.markdownPreviewSplit, { borderColor: colors.border }]]}
          contentContainerStyle={[styles.document, layout === 'pad' && styles.documentPad]}
        ><MarkdownContent value={markdownPreview} /></ScrollView> : null}
      </View> : kind === 'markdown' ? <ScrollView testID="file-viewer-markdown" style={styles.scroll} contentContainerStyle={[styles.document, layout === 'pad' && styles.documentPad]}>
        {text.truncated ? <TruncationNotice /> : null}
        <MarkdownContent value={text.content} />
      </ScrollView> : <ScrollView testID="file-viewer-text" style={styles.scroll} contentContainerStyle={[styles.document, layout === 'pad' && styles.documentPad]}>
        {text.truncated ? <TruncationNotice /> : null}
        <SelectableText selectable uiTextView style={[styles.code, { color: colors.text, backgroundColor: colors.surface }]}>{text.content}</SelectableText>
      </ScrollView>}
    </View>
  }
  return <PreviewProblem
    title={kind === 'video' ? 'Workspace video streaming is unavailable' : 'No in-app preview for this file'}
    message={kind === 'video' ? 'Generated and attached videos play in-app. Workspace videos can still be downloaded or shared.' : `${name} can still be downloaded or opened by another app.`}
    onDownload={onDownload}
  />
}

function EditorAction({ icon: Icon, label, accessibilityLabel, testID, emphasized = false, selected = false, disabled = false, onPress }: {
  icon: typeof Save
  label: string
  accessibilityLabel: string
  testID: string
  emphasized?: boolean
  selected?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    accessibilityState={{ disabled, selected }}
    testID={testID}
    disabled={disabled}
    pressRetentionOffset={14}
    onPress={onPress}
    style={({ pressed }) => [styles.editorAction, {
      backgroundColor: emphasized ? colors.blue : selected ? `${colors.blue}22` : colors.raised,
      opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
    }]}
  >
    <Icon size={15} color={emphasized ? colors.background : selected ? colors.blue : colors.text} strokeWidth={2} />
    <Text style={[styles.editorActionText, { color: emphasized ? colors.background : selected ? colors.blue : colors.text }]}>{label}</Text>
  </Pressable>
}

function PreviewProblem({ title, message, onRetry, onDownload }: { title: string; message: string; onRetry?: () => void; onDownload: () => void }) {
  const colors = usePalette()
  return <View style={styles.center}>
    {onRetry ? <AlertCircle size={30} color={colors.orange} /> : <FileQuestion size={32} color={colors.muted} />}
    <Text style={[styles.problemTitle, { color: colors.text }]}>{title}</Text>
    <Text style={[styles.problemBody, { color: colors.muted }]}>{message}</Text>
    <View style={styles.problemActions}>
      {onRetry ? <Pressable accessibilityRole="button" accessibilityLabel="Retry file preview" onPress={onRetry} style={[styles.action, { backgroundColor: colors.raised }]}><RefreshCw size={16} color={colors.blue} /><Text style={{ color: colors.blue, fontWeight: '700' }}>Retry</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Download file" onPress={onDownload} style={[styles.action, { backgroundColor: colors.raised }]}><Download size={16} color={colors.blue} /><Text style={{ color: colors.blue, fontWeight: '700' }}>Download</Text></Pressable>
    </View>
  </View>
}

function TruncationNotice() {
  const colors = usePalette()
  return <View style={[styles.truncated, { backgroundColor: colors.raised }]}><Text style={{ color: colors.muted, fontSize: 11 }}>Showing a memory-bounded preview. Download for the complete file.</Text></View>
}

function viewerErrorMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause)
  return value.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim() || 'The file could not be opened.'
}

function workspaceSaveErrorMessage(cause: unknown): string {
  const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number((cause as { status?: unknown }).status) : 0
  const detail = typeof cause === 'object' && cause !== null && 'detail' in cause ? (cause as { detail?: unknown }).detail : null
  const code = typeof detail === 'object' && detail !== null && 'code' in detail ? String((detail as { code?: unknown }).code ?? '') : ''
  if (status === 409 || code === 'workspace_file_conflict') return 'File changed on disk. Your edits are safe; reload before saving again.'
  return viewerErrorMessage(cause)
}

function workspaceSaveRequiresReload(cause: unknown): boolean {
  const status = typeof cause === 'object' && cause !== null && 'status' in cause ? Number((cause as { status?: unknown }).status) : 0
  const detail = typeof cause === 'object' && cause !== null && 'detail' in cause ? (cause as { detail?: unknown }).detail : null
  const code = typeof detail === 'object' && detail !== null && 'code' in detail ? String((detail as { code?: unknown }).code ?? '') : ''
  return status === 409 || status === 403 || code === 'workspace_file_conflict' || code === 'workspace_permission_denied'
}

function formatLimit(bytes: number): string { return `${Math.round(bytes / (1024 * 1024))} MiB` }

function countLines(value: string): number {
  let lines = 1
  for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) === 10) lines += 1
  return lines
}

function withEditorCheckpointTimeout<T>(checkpoint: Promise<T>, timeoutMs = 900): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor checkpoint timed out.')), timeoutMs)
    checkpoint.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, cause => {
      clearTimeout(timer)
      reject(cause)
    })
  })
}

const styles = StyleSheet.create({
  center: { flex: 1, minHeight: 240, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  scroll: { flex: 1 },
  documentViewer: { flex: 1, minHeight: 0 },
  editorToolbar: { minHeight: 52, flexShrink: 0, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  editorStatus: { flex: 1, minWidth: 0 },
  editorStatusText: { fontSize: 11, lineHeight: 15, fontWeight: '700' },
  editorAction: { minWidth: 44, minHeight: 44, borderRadius: 8, paddingHorizontal: 10, flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  editorActionText: { fontSize: 11, fontWeight: '800' },
  editor: { flex: 1, minHeight: 0, paddingHorizontal: 14, paddingVertical: 14, fontSize: 13, lineHeight: 19, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  editorPad: { paddingHorizontal: 24, paddingVertical: 20 },
  editorPanes: { flex: 1, minHeight: 0 },
  editorPanesSplit: { flexDirection: 'row' },
  editorSourcePane: { flex: 1, minWidth: 0, minHeight: 0 },
  markdownPreviewPane: { flex: 1, minWidth: 0, minHeight: 0 },
  markdownPreviewSplit: { borderLeftWidth: StyleSheet.hairlineWidth },
  hiddenEditorPane: { display: 'none' },
  document: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 18 },
  documentPad: { paddingHorizontal: 28, paddingVertical: 24 },
  imageCanvas: { flex: 1, minHeight: 0 },
  code: { width: '100%', minHeight: 80, borderRadius: 8, padding: 14, fontSize: 13, lineHeight: 19, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  problemTitle: { fontSize: 17, fontWeight: '800', textAlign: 'center' },
  problemBody: { maxWidth: 440, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  problemActions: { minHeight: 48, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8 },
  action: { minHeight: 44, borderRadius: 8, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  truncated: { borderRadius: 7, padding: 10, marginBottom: 12 },
})
