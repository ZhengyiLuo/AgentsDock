import type { Backend, RuntimeCatalog, Session } from '@shared/types'
import { getLocale, t, type Locale } from '@shared/i18n'

export function backendLabel(backend: Backend): string {
  if (backend === 'codex') return 'Codex'
  if (backend === 'cursor') return 'Cursor'
  return 'Claude'
}

export function formatTime(value?: string | null, locale: Locale = getLocale()): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)
  if (date.toDateString() === now.toDateString()) return t('editor.timeToday', { time }, locale)
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return t('editor.timeYesterday', { time }, locale)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes; let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds < 0) return t('editor.durationSeconds', { seconds: 0 })
  if (seconds < 60) return t('editor.durationSeconds', { seconds: Math.floor(seconds) })
  if (seconds < 3600) return t('editor.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: Math.floor(seconds % 60) })
  return t('editor.durationHours', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) })
}

export function runtimeLabel(session: Session, catalog?: RuntimeCatalog | null): string {
  const backend = catalog?.backends[session.backend]
  const model = session.model?.trim()
  const effort = session.backend === 'cursor' ? '' : session.effort?.trim()
  const modelLabel = model
    ? backend?.models.find(option => option.value === model)?.label ?? model
    : backend?.models.find(option => option.value === (backend.default_model ?? ''))?.label ?? backend?.default_model ?? (session.backend === 'claude' ? 'Sonnet' : session.backend === 'codex' ? 'GPT' : 'Auto')
  const effortLabel = session.backend === 'cursor'
    ? null
    : effort
      ? backend?.efforts.find(option => option.value === effort)?.label ?? effort
      : backend?.default_effort
  return [modelLabel, effortLabel].filter(Boolean).join(' · ')
}

export function shortId(value?: string | null): string {
  return value?.trim() ? value.slice(0, 10) : '–'
}

export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}
