import { useEffect, useId, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { Code2, FileCode2, LoaderCircle, Search, X } from 'lucide-react'
import { t } from '@shared/i18n'
import type { CodeIntelligenceStatus } from '@shared/code-intelligence'
import type { Session, WorkspaceProfileScope } from '@shared/types'
import { useLocale } from '../lib/i18n'
import type { CodeIntelligenceClient } from '../lib/code-intelligence'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import './CodeReferencePicker.css'

export interface CodeReference { path: string; line?: number; endLine?: number }
interface ReferenceResult extends CodeReference { id: string; name: string; detail: string }
const MAX_SYMBOL_SEED_BYTES = 512 * 1024

export function absoluteCodeReferencePath(root: string, path: string): string {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return path
  return `${root.replace(/[\\/]+$/, '')}/${path}`
}

export function codeReferenceText(reference: CodeReference): string {
  const location = reference.path + (reference.line
    ? `:${reference.line}${reference.endLine && reference.endLine > reference.line ? `-${reference.endLine}` : ''}` : '')
  // Code spans preserve spaces and punctuation in server-side filenames.
  const delimiter = '`'.repeat(Math.max(0, ...Array.from(location.matchAll(/`+/g), match => match[0].length)) + 1)
  return `${delimiter}${location}${delimiter}`
}

export function codeReferenceDraftLines(draft: string): Array<{ text: string; label: string; start: number; end: number }> {
  return Array.from(draft.matchAll(/^(`+)((?:\/|[A-Za-z]:[\\/])[^\r\n]+?)\1$/gm), match => ({
    text: match[0], label: match[2], start: match.index!, end: match.index! + match[0].length
  }))
}

export function parseCodeReferenceRange(value: string): { line?: number; endLine?: number } | null {
  if (!value.trim()) return {}
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(value.trim())
  if (!match) return null
  const line = Number(match[1]), endLine = match[2] ? Number(match[2]) : line
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(endLine) || line < 1 || endLine < line) return null
  return { line, ...(endLine > line ? { endLine } : {}) }
}

export function CodeReferenceShelf({ draft, disabled, onRemove, onEdit }: {
  draft: string; disabled?: boolean; onRemove: (start: number, end: number) => void; onEdit: (start: number, end: number) => void
}) {
  const references = useMemo(() => codeReferenceDraftLines(draft), [draft])
  if (!references.length) return null
  return <div className="code-reference-shelf" aria-label={t('codeReference.selected')}>
    {references.map(reference => <span className="code-reference-chip" key={reference.start}>
      <button type="button" className="code-reference-chip-label" title={reference.label}
        disabled={disabled}
        aria-label={t('codeReference.editReference', { path: reference.label })}
        onClick={() => onEdit(reference.start, reference.end)}><FileCode2 size={13} /><span>{reference.label}</span></button>
      <button type="button" className="code-reference-chip-remove" aria-label={t('codeReference.removeReference', { path: reference.label })}
        disabled={disabled}
        onClick={() => onRemove(reference.start, reference.end)}><X size={12} /></button>
    </span>)}
  </div>
}

export function CodeReferencePicker({ session, scope, disabled, onSelect }: {
  session: Session; scope: WorkspaceProfileScope; disabled?: boolean; onSelect: (reference: CodeReference) => void
}) {
  useLocale()
  const [open, setOpen] = useState(false)
  useTransientClose(open, () => setOpen(false))
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className="composer-icon code-reference-trigger"
      disabled={disabled} title={t('codeReference.title')} aria-label={t('codeReference.title')}><Code2 size={16} /></button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="form-dialog code-reference-dialog">
        <header><div><Dialog.Title>{t('codeReference.title')}</Dialog.Title>
          <Dialog.Description>{t('codeReference.description')}</Dialog.Description></div>
          <Dialog.Close asChild><button type="button" className="icon-button" aria-label={t('codeReference.close')}><X size={17} /></button></Dialog.Close>
        </header>
        {open && <CodeReferenceSearch session={session} scope={scope} onSelect={reference => { onSelect(reference); setOpen(false) }} />}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function CodeReferenceSearch({ session, scope, onSelect }: {
  session: Session; scope: WorkspaceProfileScope; onSelect: (reference: CodeReference) => void
}) {
  const [tab, setTab] = useState<'files' | 'symbols'>('files')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ReferenceResult[]>([])
  const [index, setIndex] = useState(0)
  const [range, setRange] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<CodeIntelligenceStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [retry, setRetry] = useState(0)
  const listId = `code-reference-results-${useId().replace(/:/g, '')}`
  const generation = useRef(0)
  const clients = useRef<Promise<CodeIntelligenceClient[]> | null>(null)
  const partialClients = useRef(false)
  const connectionAbort = useRef<AbortController | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultRefs = useRef<Array<HTMLDivElement | null>>([])
  const selected = results[index]
  const parsedRange = parseCodeReferenceRange(range)
  const current = () => {
    const state = useAppStore.getState()
    return !state.switchingProfileId && state.activeProfileId === scope.profileId
      && state.profileGeneration === scope.profileGeneration
      && (state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null) === (scope.serverIdentity ?? null)
      && state.sessions.some(candidate => candidate.id === session.id && candidate.cwd === session.cwd)
  }

  useEffect(() => {
    let active = true
    const abort = new AbortController()
    connectionAbort.current = abort
    const api = window.agentsDock.intelligence
    if (!api) { setStatusError(t('codeIntelligence.updateServer')); return }
    if (!current()) return
    setStatus(null)
    setStatusError('')
    void api.status(scope, session.id).then(value => {
      if (active && current()) setStatus(value)
    }).catch(() => { if (active && current()) setStatusError(t('codeReference.symbolsUnavailable')) })
    return () => {
      active = false
      generation.current += 1
      abort.abort()
      const pending = clients.current
      clients.current = null
      void pending?.then(connections => connections.forEach(connection => connection.close())).catch(() => undefined)
    }
  // The parent keys this component to profile, generation, chat, and cwd.
  }, [retry])

  const symbolStatus = tab === 'symbols' ? status : null
  useEffect(() => {
    const request = ++generation.current
    let cancelled = false
    const valid = () => !cancelled && request === generation.current && current()
    setResults([])
    setIndex(0)
    setRange('')
    setError('')
    setTruncated(false)
    if (tab === 'symbols' && (!query.trim() || !status?.languages.some(language => language.available))) {
      setLoading(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    const timer = window.setTimeout(() => {
      if (!valid()) return
      const run = async () => {
        if (tab === 'files') {
          const page = await window.agentsDock.intelligence.files(scope, session.id, query.trim(), 100)
          if (!valid()) return
          setResults(page.entries.filter(entry => entry.kind === 'file' && !/[\r\n]/.test(entry.path)).map(entry => ({
            id: entry.path, name: entry.name, detail: entry.path, path: absoluteCodeReferencePath(page.root, entry.path)
          })))
          setTruncated(page.truncated)
        } else if (status) {
          const { createCodeIntelligenceClient, searchWorkspaceSymbols, languageForCodePath } = await import('../lib/code-intelligence')
          if (!valid()) return
          if (!clients.current) {
            const signal = connectionAbort.current?.signal
            const pending = Promise.allSettled(status.languages.filter(language => language.available).map(async language => {
              // A real document lets language servers load the project's configuration.
              // Bootstrap once per picker lifetime, and never read a large source file.
              let seedPath: string | undefined
              for (const extension of language.id === 'python' ? ['.py'] : ['.ts', '.js', '.mts', '.cts', '.mjs', '.cjs']) {
                if (signal?.aborted || !current()) throw new Error('Cancelled')
                const page = await window.agentsDock.intelligence.files(scope, session.id, extension, 100)
                if (page.root !== status.root) throw new Error('Workspace changed')
                seedPath = page.entries.find(entry => entry.kind === 'file'
                  && languageForCodePath(entry.path) === language.id
                  && typeof entry.size === 'number' && entry.size <= MAX_SYMBOL_SEED_BYTES)?.path
                if (seedPath) break
              }
              if (signal?.aborted || !current()) throw new Error('Cancelled')
              if (!seedPath) return null
              const seed = await window.agentsDock.intelligence.read(scope, session.id, seedPath)
              if (signal?.aborted || !current() || seed.root !== status.root || seed.size > MAX_SYMBOL_SEED_BYTES) throw new Error('Workspace changed')
              return createCodeIntelligenceClient({
                api: window.agentsDock.intelligence, scope, sessionId: session.id, language: language.id, rootUri: status.root_uri,
                signal, document: { path: seed.path, text: seed.content }, workspaceSymbols: true,
                onClose: () => { if (!signal?.aborted && current()) setError(t('codeIntelligence.connectionClosed')) }
              })
            })).then(settled => {
              partialClients.current = settled.some(result => result.status === 'rejected')
              const connected = settled.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
              if (!connected.length) throw new Error(t('codeReference.symbolsUnavailable'))
              return connected
            })
            clients.current = pending
          }
          const connected = await clients.current
          if (!valid()) return
          const pages = await Promise.allSettled(connected.map(connection => searchWorkspaceSymbols(connection.client, query.trim(), status.root_uri)))
          if (!valid()) return
          const symbols = pages.flatMap(page => page.status === 'fulfilled' ? page.value : [])
          if (pages.every(page => page.status === 'rejected')) throw new Error(t('codeReference.symbolsUnavailable'))
          const entries = new Map<string, ReferenceResult>()
          for (const symbol of symbols) {
            if (/[\r\n]/.test(symbol.path)) continue
            const id = `${symbol.path}:${symbol.line}:${symbol.name}`
            entries.set(id, { ...symbol, id, path: absoluteCodeReferencePath(status.root, symbol.path),
              detail: `${symbol.path}:${symbol.line}${symbol.containerName ? ` · ${symbol.containerName}` : ''}` })
          }
          setResults([...entries.values()].slice(0, 100))
          setTruncated(entries.size > 100)
          if (pages.some(page => page.status === 'rejected') || partialClients.current) setError(t('codeReference.partialSymbols'))
        }
      }
      void run().catch(() => { if (valid()) setError(t(tab === 'files' ? 'codeReference.filesUnavailable' : 'codeReference.symbolsUnavailable')) })
        .finally(() => { if (valid()) setLoading(false) })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, tab, symbolStatus, retry])

  useEffect(() => {
    setRange(selected?.line ? `${selected.line}${selected.endLine && selected.endLine > selected.line ? `-${selected.endLine}` : ''}` : '')
    resultRefs.current[index]?.scrollIntoView?.({ block: 'nearest' })
  }, [selected?.id, index])

  const choose = () => {
    if (!selected || !parsedRange || !current()) return
    onSelect({ path: selected.path, ...parsedRange })
  }
  const unavailable = tab === 'symbols' && (statusError || (status && !status.languages.some(language => language.available)
    ? t('codeReference.symbolsUnavailable') : ''))

  return <Tabs.Root className="code-reference-body" value={tab} onValueChange={value => { setTab(value as 'files' | 'symbols'); searchRef.current?.focus() }}>
      <Tabs.List className="code-reference-tabs" aria-label={t('codeReference.searchType')}>
        <Tabs.Trigger value="files">{t('codeReference.files')}</Tabs.Trigger>
        <Tabs.Trigger value="symbols">{t('codeReference.symbols')}</Tabs.Trigger>
      </Tabs.List>
    <Tabs.Content className="code-reference-panel" value={tab}>
    <label className="code-reference-search"><Search size={16} /><input ref={searchRef} autoFocus value={query}
      role="combobox" aria-label={t(tab === 'files' ? 'codeReference.searchFiles' : 'codeReference.searchSymbols')}
      aria-controls={listId} aria-expanded={results.length > 0} aria-autocomplete="list"
      aria-activedescendant={selected ? `${listId}-${index}` : undefined}
      placeholder={t(tab === 'files' ? 'codeReference.searchFiles' : 'codeReference.searchSymbols')}
      onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex(value => Math.max(0, Math.min(results.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1))))
        } else if (event.key === 'Enter') { event.preventDefault(); choose() }
      }} />{loading && <LoaderCircle size={15} className="spin" aria-hidden="true" />}</label>
    {Boolean(error || unavailable) && <div className="code-reference-notice" role="status"><span>{error || unavailable}</span>
      <button type="button" className="quiet-button" onClick={() => setRetry(value => value + 1)}>{t('codeIntelligence.retry')}</button></div>}
    {tab === 'symbols' && status?.languages.filter(language => !language.available && language.install_hint).map(language => <p key={language.id} className="code-reference-hint">{language.install_hint}</p>)}
    <div className="code-reference-results" id={listId} role="listbox" aria-label={t('codeReference.results')} aria-busy={loading}>
      {results.map((result, resultIndex) => <div key={result.id} id={`${listId}-${resultIndex}`} role="option"
        aria-label={`${result.name} ${result.detail}`}
        aria-selected={index === resultIndex} className="code-reference-result" ref={node => { resultRefs.current[resultIndex] = node }}
        onClick={() => { setIndex(resultIndex); searchRef.current?.focus() }}>
        {tab === 'files' ? <FileCode2 size={17} /> : <Code2 size={17} />}<span><strong>{result.name}</strong><small>{result.detail}</small></span>
      </div>)}
      {!results.length && !loading && !error && !unavailable && <p className="code-reference-empty">{t(tab === 'symbols' && !query.trim() ? 'codeReference.typeSymbol' : 'codeReference.noResults')}</p>}
      {loading && !results.length && <p className="code-reference-empty" role="status">{t('codeReference.searching')}</p>}
    </div>
    {truncated && <p className="code-reference-hint">{t('codeReference.refine')}</p>}
    <div className="code-reference-footer"><label>{t('codeReference.lines')}<input value={range} placeholder="12-20"
      aria-label={t('codeReference.lines')} aria-invalid={parsedRange === null} disabled={!selected}
      onChange={event => setRange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); choose() } }} /></label>
      <button type="button" className="primary-button" disabled={!selected || parsedRange === null} onClick={choose}>{t('codeReference.add')}</button></div>
    {parsedRange === null && <p className="code-reference-hint" role="alert">{t('codeReference.invalidRange')}</p>}
    </Tabs.Content>
  </Tabs.Root>
}
