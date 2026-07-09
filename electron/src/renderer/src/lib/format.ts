import type { RuntimeCatalog, Session } from '@shared/types'

export function formatTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date)
  if (date.toDateString() === now.toDateString()) return `${time} today`
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `${time} yesterday`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes; let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds < 0) return '0s'
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export function runtimeLabel(session: Session, catalog?: RuntimeCatalog | null): string {
  const backend = catalog?.backends[session.backend]
  const model = session.model?.trim()
  const effort = session.effort?.trim()
  const modelLabel = model
    ? backend?.models.find(option => option.value === model)?.label ?? model
    : backend?.models.find(option => option.value === (backend.default_model ?? ''))?.label ?? backend?.default_model ?? (session.backend === 'claude' ? 'Sonnet' : 'GPT')
  const effortLabel = effort
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
