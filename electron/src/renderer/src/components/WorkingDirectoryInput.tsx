// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { ArrowUp, Check, ChevronRight, Folder, FolderOpen, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { WorkingDirectoryCompletion, WorkingDirectorySuggestion } from '@shared/types'
import { parentDirectory } from '../lib/working-directory-path'

const COMPLETION_DEBOUNCE_MS = 90
const BROWSE_RESULT_LIMIT = 50

export function WorkingDirectoryInput({
  value,
  onChange,
  onCommit,
  defaultCwd,
  available,
  showBrowseButton = false
}: {
  value: string
  onChange: (value: string) => void
  onCommit?: (value: string) => void
  defaultCwd: string
  available: boolean
  showBrowseButton?: boolean
}) {
  useLocale()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const browseButtonRef = useRef<HTMLButtonElement | null>(null)
  const browseCloseRef = useRef<HTMLButtonElement | null>(null)
  const requestRef = useRef(0)
  const browseRequestRef = useRef(0)
  const inputId = useId()
  const listId = useId()
  const pickerId = useId()
  const pickerTitleId = useId()
  const [focused, setFocused] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [completion, setCompletion] = useState<WorkingDirectoryCompletion | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [browseOpen, setBrowseOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState('')
  const [browseCompletion, setBrowseCompletion] = useState<WorkingDirectoryCompletion | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [browseRetry, setBrowseRetry] = useState(0)
  const completionEnabled = available && typeof window.agentsDock.workingDirectories?.complete === 'function'

  useEffect(() => {
    if (!focused || !expanded || !completionEnabled) {
      requestRef.current += 1
      setLoading(false)
      if (!completionEnabled) setCompletion(null)
      return
    }
    const request = ++requestRef.current
    setLoading(true)
    const timer = window.setTimeout(() => {
      void window.agentsDock.workingDirectories.complete(value, 24).then(result => {
        if (request !== requestRef.current) return
        setCompletion(result)
        setActiveIndex(-1)
      }).catch(error => {
        if (request !== requestRef.current) return
        setCompletion({
          input: value,
          resolved_path: value,
          exists: false,
          base_path: '',
          suggestions: [],
          truncated: false,
          message: error instanceof Error ? error.message : String(error)
        })
        setActiveIndex(-1)
      }).finally(() => {
        if (request === requestRef.current) setLoading(false)
      })
    }, COMPLETION_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (requestRef.current === request) requestRef.current += 1
    }
  }, [completionEnabled, expanded, focused, value])

  useEffect(() => {
    if (!browseOpen || !completionEnabled) {
      browseRequestRef.current += 1
      setBrowseLoading(false)
      return
    }
    const request = ++browseRequestRef.current
    setBrowseLoading(true)
    setBrowseError(null)
    setBrowseCompletion(null)
    void window.agentsDock.workingDirectories.complete(browsePath, BROWSE_RESULT_LIMIT).then(result => {
      if (request !== browseRequestRef.current) return
      setBrowseCompletion(result)
    }).catch(error => {
      if (request !== browseRequestRef.current) return
      setBrowseError(error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (request === browseRequestRef.current) setBrowseLoading(false)
    })
    return () => {
      if (browseRequestRef.current === request) browseRequestRef.current += 1
    }
  }, [browseOpen, browsePath, browseRetry, completionEnabled])

  const suggestions = completion?.suggestions ?? []
  const showResults = focused && expanded && completionEnabled
  const closeBrowse = useCallback(() => {
    browseRequestRef.current += 1
    setBrowseOpen(false)
    setBrowseLoading(false)
    setBrowseError(null)
    browseButtonRef.current?.focus()
  }, [])
  const browse = () => {
    if (!completionEnabled) return
    if (browseOpen) {
      closeBrowse()
      return
    }
    setExpanded(false)
    setBrowseCompletion(null)
    setBrowseError(null)
    setBrowsePath(value.trim() || defaultCwd.trim())
    setBrowseOpen(true)
  }
  useEffect(() => {
    if (!browseOpen) return
    browseCloseRef.current?.focus()
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeBrowse()
    }
    document.addEventListener('keydown', handleEscape, true)
    return () => document.removeEventListener('keydown', handleEscape, true)
  }, [browseOpen, closeBrowse])
  const useBrowseFolder = () => {
    if (!browseCompletion?.exists || browseLoading) return
    const selected = browseCompletion.resolved_path
    onChange(selected)
    onCommit?.(selected)
    closeBrowse()
  }
  const choose = (suggestion: WorkingDirectorySuggestion) => {
    setCompletion(null)
    onChange(suggestion.path)
    onCommit?.(suggestion.path)
    setActiveIndex(-1)
    setExpanded(true)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && onCommit && (!completionEnabled || !showResults || activeIndex < 0)) {
      event.preventDefault()
      onCommit(value)
      inputRef.current?.blur()
      return
    }
    if (!completionEnabled) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setExpanded(true)
      if (suggestions.length) setActiveIndex(index => index < suggestions.length - 1 ? index + 1 : 0)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setExpanded(true)
      if (suggestions.length) setActiveIndex(index => index > 0 ? index - 1 : suggestions.length - 1)
      return
    }
    if (event.key === 'Tab' && showResults && suggestions.length) {
      event.preventDefault()
      choose(suggestions[activeIndex >= 0 ? activeIndex : 0])
      return
    }
    if (event.key === 'Tab' && expanded && (loading || completion == null)) {
      // Keep the first Tab in the field while the remote server answers. A
      // second Tab completes the first result, matching shell-style behavior.
      event.preventDefault()
      return
    }
    if (event.key === 'Enter' && showResults && activeIndex >= 0 && suggestions[activeIndex]) {
      event.preventDefault()
      choose(suggestions[activeIndex])
      return
    }
    if (event.key === 'Escape' && expanded) {
      event.preventDefault()
      event.stopPropagation()
      setExpanded(false)
      setActiveIndex(-1)
    }
  }

  const currentBrowsePath = browseCompletion?.exists
    ? browseCompletion.resolved_path
    : browseCompletion?.base_path || browsePath
  const browseFailure = browseError || browseCompletion?.message || null
  const parentBrowsePath = parentDirectory(currentBrowsePath)
  const canBrowseUp = Boolean(currentBrowsePath && parentBrowsePath && parentBrowsePath !== currentBrowsePath)

  return <div className={`working-directory-field${completionEnabled ? ' completion-enabled' : ''}${browseOpen ? ' picker-open' : ''}`}>
    <label className="working-directory-label" htmlFor={inputId}>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.working_directory_865e85c")}</label>
    <div className="working-directory-input-row">
      <div className="working-directory-combobox">
        <Folder className="working-directory-input-icon" size={14} aria-hidden="true" />
        <input
          id={inputId}
          ref={inputRef}
          role={completionEnabled ? 'combobox' : undefined}
          aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.working_directory_865e85c")}
          aria-autocomplete={completionEnabled ? 'list' : undefined}
          aria-expanded={completionEnabled ? showResults : undefined}
          aria-busy={completionEnabled && loading ? true : undefined}
          aria-controls={showResults ? listId : undefined}
          aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          value={value}
          onChange={event => { setCompletion(null); onChange(event.target.value); setExpanded(true); setActiveIndex(-1) }}
          onFocus={() => { setFocused(true); setExpanded(true) }}
          onBlur={() => { setFocused(false); setExpanded(false); setActiveIndex(-1); onCommit?.(value) }}
          onKeyDown={handleKeyDown}
          placeholder={defaultCwd || t("ui.WorkingDirectoryInput.WorkingDirectoryInput.server_default_42b9983")}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {loading && <LoaderCircle className="working-directory-spinner spin" size={13} aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.loading_folders_1c1f1d2")} />}
        {!loading && completion?.exists && <Check className="working-directory-valid" size={13} aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folder_found_8cabb4c")} />}
        {showResults && <div className="working-directory-results">
          <div className="working-directory-results-heading"><strong>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folders_on_this_server_9f697d6")}</strong><span>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.type_to_filter_14b2662")}</span></div>
          {loading && completion == null && <p className="working-directory-message loading" role="status"><LoaderCircle className="spin" size={12} />{" "}{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.looking_up_folders_04ea96f")}</p>}
          {completion?.exists && <div className="working-directory-current"><Check size={12} aria-hidden="true" /><span><strong>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folder_found_8cabb4c")}</strong><small>{completion.resolved_path}</small></span></div>}
          <div id={listId} className="working-directory-options" role="listbox" aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folders_on_the_active_server_a05a1c2")}>
            {suggestions.map((suggestion, index) => <button
              type="button"
              id={`${listId}-${index}`}
              role="option"
              aria-selected={activeIndex === index}
              className={activeIndex === index ? 'selected' : ''}
              key={suggestion.path}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(suggestion)}
            ><Folder size={13} aria-hidden="true" /><span>{suggestion.name}</span><small>{suggestion.path}</small></button>)}
          </div>
          {!loading && completion?.message && <p className="working-directory-message" role="status">{completion.message}</p>}
          {!loading && completion && !completion.message && suggestions.length === 0 && <p className="working-directory-message" role="status">{completion.exists ? t("ui.WorkingDirectoryInput.WorkingDirectoryInput.this_folder_exists_keep_typing_after_to_br_cdef97c") : t("ui.WorkingDirectoryInput.WorkingDirectoryInput.no_matching_folders_on_this_server_ab0b206")}</p>}
          <div className="working-directory-help">
            <span>{completion?.truncated ? t("ui.WorkingDirectoryInput.WorkingDirectoryInput.more_folders_match_keep_typing_3476487") : suggestions.length > 0 ? 'Tab completes' : t("ui.WorkingDirectoryInput.WorkingDirectoryInput.keep_typing_a_path_93c6c7c")}</span>
            {suggestions.length > 0 && <span>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.chooses_665b52a")}</span>}
            <span>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.esc_closes_66b35fe")}</span>
          </div>
        </div>}
      </div>
      {showBrowseButton && completionEnabled && <button
        ref={browseButtonRef}
        type="button"
        className="working-directory-browse"
        aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.browse_folders_on_active_server_100aebc")}
        aria-haspopup="dialog"
        aria-expanded={browseOpen}
        aria-controls={browseOpen ? pickerId : undefined}
        onClick={browse}
      ><FolderOpen size={14} aria-hidden="true" /><span>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.browse_3227aa9")}</span></button>}
    </div>
    {browseOpen && <section
      id={pickerId}
      className="working-directory-picker"
      role="dialog"
      aria-modal="false"
      aria-labelledby={pickerTitleId}
    >
      <header>
        <span><strong id={pickerTitleId}>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.browse_server_folders_453935d")}</strong><small>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.select_a_folder_on_the_active_agentsserver_2629b54")}</small></span>
        <button ref={browseCloseRef} type="button" aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.close_server_folder_browser_8cdbfb6")} onClick={closeBrowse}><X size={14} /></button>
      </header>
      <div className="working-directory-picker-location">
        <button type="button" aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.go_to_parent_folder_7d4c500")} disabled={!canBrowseUp || browseLoading} onClick={() => setBrowsePath(parentBrowsePath)}><ArrowUp size={14} /></button>
        <code title={currentBrowsePath}>{currentBrowsePath || t("ui.WorkingDirectoryInput.WorkingDirectoryInput.server_default_42b9983")}</code>
      </div>
      <div className="working-directory-picker-list" role="group" aria-label={t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folders_in_current_server_directory_198823d")} aria-busy={browseLoading}>
        {browseLoading && <p role="status"><LoaderCircle className="spin" size={14} />{" "}{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.loading_folders_d0aa0da")}</p>}
        {!browseLoading && browseFailure && <div className="working-directory-picker-error" role="alert"><span>{browseFailure}</span><button type="button" onClick={() => setBrowseRetry(retry => retry + 1)}><RotateCcw size={12} />{" "}{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.retry_942087c")}</button></div>}
        {!browseLoading && !browseFailure && browseCompletion?.suggestions.map(suggestion => <button
          type="button"
          className="working-directory-picker-folder"
          key={suggestion.path}
          aria-label={t("ui.WorkingDirectoryInput.open_folder_7a11ec6", { "folder": String(suggestion.name) })}
          onClick={() => setBrowsePath(suggestion.path)}
        ><Folder size={14} aria-hidden="true" /><span><strong>{suggestion.name}</strong><small>{suggestion.path}</small></span><ChevronRight size={14} aria-hidden="true" /></button>)}
        {!browseLoading && !browseFailure && browseCompletion && browseCompletion.suggestions.length === 0 && <p role="status">{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.no_folders_inside_this_directory_741deb5")}</p>}
      </div>
      <footer>
        <button type="button" className="quiet-button" onClick={closeBrowse}>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.cancel_19766ed")}</button>
        <button type="button" className="primary-button" disabled={browseLoading || !browseCompletion?.exists} onClick={useBrowseFolder}>{t("ui.WorkingDirectoryInput.WorkingDirectoryInput.use_this_folder_30cbaec")}</button>
      </footer>
    </section>}
    {focused && !completionEnabled && <small className="working-directory-hint" role="status">{available
      ? t("ui.WorkingDirectoryInput.WorkingDirectoryInput.update_agentsdock_to_browse_folders_here_y_64f1f83")
      : t("ui.WorkingDirectoryInput.WorkingDirectoryInput.folder_suggestions_need_a_newer_agentsserv_49c9e57")}</small>}
  </div>
}
