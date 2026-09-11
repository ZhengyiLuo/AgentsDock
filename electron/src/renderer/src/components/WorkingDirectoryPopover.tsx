// Localized display strings use semantic catalog keys.
import { t, getLocale } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUp, ChevronRight, Folder, FolderOpen, LoaderCircle, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Session, WorkingDirectoryCompletion } from '@shared/types'
import { parentDirectory } from '../lib/working-directory-path'
import { useAppStore } from '../store/app-store'

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

  const load = (target: string) => {
    const path = target.trim()
    if (!completionAvailable) return
    const request = ++requestRef.current
    setPathDraft(path)
    setLoading(true)
    setError(null)
    void window.agentsDock.workingDirectories.complete(path, 50).then(result => {
      if (request !== requestRef.current) return
      setCompletion(result)
      setPathDraft(result.exists ? result.resolved_path || path : path)
    }).catch(reason => {
      if (request !== requestRef.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
  }

  useEffect(() => {
    if (!open) return
    load(session.cwd?.trim() || defaultCwd || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const currentPath = completion?.resolved_path || completion?.base_path || ''
  const parentPath = parentDirectory(currentPath)
  const canGoToParent = Boolean(currentPath && parentPath && parentPath !== currentPath)
  const folders = completion?.suggestions ?? []
  const openTypedPath = () => load(pathDraft)

  const choose = async () => {
    const target = currentPath.trim()
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

  const chipTitle = session.cwd?.trim() ? `Working directory: ${session.cwd.trim()}` : 'Set the working directory for this chat'

  return <Popover.Root open={open} onOpenChange={setOpen}>
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
            <form className="cwd-popover-path" onSubmit={event => { event.preventDefault(); openTypedPath() }}>
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
                  requestRef.current += 1
                  setPathDraft(event.currentTarget.value)
                  setCompletion(null)
                  setError(null)
                  setLoading(false)
                }}
                placeholder={defaultCwd || t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.enter_a_folder_path_2dbdc38")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <button type="submit" disabled={loading || !pathDraft.trim()} aria-label={t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.open_path_01ecb69")}>Go</button>
            </form>
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
            <div className="cwd-popover-footer">
              <span className="cwd-popover-target" title={currentPath}>{cwdChipLabel(currentPath)}</span>
              <button type="button" className="cwd-popover-choose" disabled={!currentPath || loading || saving || !completion?.exists} onClick={() => void choose()}>{saving ? t("ui.WorkingDirectoryPopover.WorkingDirectoryPopover.saving_23e3929") : 'Choose'}</button>
            </div>
          </>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
