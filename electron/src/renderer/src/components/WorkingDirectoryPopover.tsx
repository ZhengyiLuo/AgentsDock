// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUp, ChevronRight, Folder, FolderOpen, LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Session, WorkingDirectoryCompletion } from '@shared/types'
import { parentDirectory } from '../lib/working-directory-path'
import { useAppStore } from '../store/app-store'

const TYPED_PATH_LOOKUP_DELAY_MS = 120

export function cwdChipLabel(cwd?: string | null): string {
  const trimmed = cwd?.trim()
  if (!trimmed) return t("ui.WorkingDirectoryPopover.cwdChipLabel.default_folder_aff5db4")
  const segments = trimmed.replace(/\/+$/, '').split('/')
  return segments[segments.length - 1] || trimmed
}

/**
 * Finder-style working-directory picker anchored above the composer chip.
 * Clicking a folder navigates into it; the currently-open directory is the
 * selection, confirmed with "Choose".
 */
export function WorkingDirectoryPopover({ session }: { session: Session }) {
  useLocale()
  const completionAvailable = useAppStore(state => state.health?.capabilities?.working_directory_completion?.available === true)
  const defaultCwd = useAppStore(state => state.health?.default_cwd?.trim() || '')
  const [open, setOpen] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const [completion, setCompletion] = useState<WorkingDirectoryCompletion | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const requestRef = useRef(0)
  const typedPathLookupRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelTypedPathLookup = () => {
    if (typedPathLookupRef.current == null) return
    clearTimeout(typedPathLookupRef.current)
    typedPathLookupRef.current = null
  }

  const load = async (target: string, canonicalizeDraft = true): Promise<WorkingDirectoryCompletion | null> => {
    const path = target.trim()
    if (!completionAvailable) return null
    cancelTypedPathLookup()
    const request = ++requestRef.current
    if (canonicalizeDraft) setPathDraft(path)
    setLoading(true)
    setError(null)
    try {
      const result = await window.agentsDock.workingDirectories.complete(path, 50)
      if (request !== requestRef.current) return null
      setCompletion(result)
      if (canonicalizeDraft) setPathDraft(result.exists ? result.resolved_path || path : path)
      return result
    } catch (reason) {
      if (request !== requestRef.current) return null
      setError(reason instanceof Error ? reason.message : String(reason))
      return null
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void load(session.cwd?.trim() || defaultCwd || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => () => cancelTypedPathLookup(), [])

  const currentPath = completion?.resolved_path || completion?.base_path || ''
  const parentPath = parentDirectory(currentPath)
  const canGoToParent = Boolean(currentPath && parentPath && parentPath !== currentPath)
  const folders = completion?.suggestions ?? []

  const choose = async (targetPath = currentPath) => {
    const target = targetPath.trim()
    if (!target || saving) return
    setSaving(true)
    try {
      await useAppStore.getState().updateSession(session.id, { cwd: target })
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  const chooseTypedPath = async () => {
    const draft = pathDraft.trim()
    if (!draft || saving) return
    cancelTypedPathLookup()
    const detected = !loading && completion?.exists && completion.input.trim() === draft
      ? completion
      : await load(draft)
    if (!detected?.exists) return
    await choose(detected.resolved_path || detected.base_path || draft)
  }

  const chipTitle = session.cwd?.trim() ? `Working directory: ${session.cwd.trim()}` : 'Set the working directory for this chat'

  return <Popover.Root open={open} onOpenChange={nextOpen => {
    if (!nextOpen) {
      cancelTypedPathLookup()
      requestRef.current += 1
    }
    setOpen(nextOpen)
  }}>
    <Popover.Trigger asChild>
      <button type="button" className="composer-context-control cwd-pill" title={chipTitle} aria-label={chipTitle}>
        <FolderOpen size={13} /><span>{cwdChipLabel(session.cwd)}</span>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="cwd-popover" side="top" align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => event.preventDefault()}>
        {!completionAvailable
          ? <div className="cwd-popover-empty">{t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.folder_browsing_needs_a_newer_agentsserver_5e4747d")}</div>
          : <>
            <div className="cwd-popover-path">
              <button
                type="button"
                className="cwd-popover-parent"
                aria-label={t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.go_to_parent_folder_7d4c500")}
                title={t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.go_to_parent_folder_7d4c500")}
                disabled={loading || !canGoToParent}
                onClick={() => load(parentPath)}
              ><ArrowUp size={13} aria-hidden="true" /></button>
              <input
                aria-label={t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.folder_path_98bca2f")}
                value={pathDraft}
                onChange={event => {
                  const nextPath = event.currentTarget.value
                  cancelTypedPathLookup()
                  requestRef.current += 1
                  setPathDraft(nextPath)
                  setCompletion(null)
                  setError(null)
                  setLoading(false)
                  if (nextPath.trim()) {
                    typedPathLookupRef.current = setTimeout(() => load(nextPath, false), TYPED_PATH_LOOKUP_DELAY_MS)
                  }
                }}
                onKeyDown={event => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  event.preventDefault()
                  void chooseTypedPath()
                }}
                placeholder={defaultCwd || t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.enter_a_folder_path_2dbdc38")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="cwd-popover-list" role="group" aria-label={t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.folders_c4d6bb2")} aria-busy={loading}>
              {loading && <p className="cwd-popover-status"><LoaderCircle className="spin" size={14} />{" "}{t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.loading_folders_d0aa0da")}</p>}
              {!loading && error && <div className="cwd-popover-error" role="alert"><span>{error}</span><button type="button" onClick={() => load(pathDraft)}><RotateCcw size={12} />{" "}{t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.retry_942087c")}</button></div>}
              {!loading && !error && folders.map(folder => <button
                type="button"
                className="cwd-folder-row"
                key={folder.path}
                aria-label={`Open ${folder.name}`}
                onClick={() => load(folder.path)}
              ><Folder size={15} aria-hidden="true" /><span>{folder.name}</span><ChevronRight size={14} aria-hidden="true" /></button>)}
              {!loading && !error && completion && folders.length === 0 && <p className="cwd-popover-status muted">{t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.no_folders_inside_this_directory_741deb5")}</p>}
            </div>
            {session.backend === 'opencode' && <p className="codex-permission-hint">{t('opencode.cwdReset')}</p>}
            <div className="cwd-popover-footer">
              <span className="cwd-popover-target" title={currentPath}>{cwdChipLabel(currentPath)}</span>
              <button type="button" className="cwd-popover-choose" disabled={!currentPath || loading || saving || !completion?.exists} onClick={() => void choose()}>{saving ? t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.saving_23e3929") : 'Choose'}</button>
            </div>
          </>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
