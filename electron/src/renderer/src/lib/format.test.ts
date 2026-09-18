import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '@shared/i18n'
import type { RuntimeCatalog, Session } from '@shared/types'
import { backendLabel, formatDuration, formatTime, runtimeLabel } from './format'

describe('localized date and duration formatting', () => {
  afterEach(() => { setLocale('en'); vi.useRealTimers() })

  it('keeps scoped English timestamps without changing the app locale', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 9, 12, 30))
    const times = [
      new Date(2026, 8, 9, 12, 30).toISOString(),
      new Date(2026, 8, 8, 11, 15).toISOString(),
      new Date(2026, 7, 15, 9, 0).toISOString()
    ]
    const english = times.map(value => formatTime(value))
    setLocale('zh-CN')
    expect(times.map(value => formatTime(value, 'en'))).toEqual(english)
    expect(getLocale()).toBe('zh-CN')
    expect(formatTime(times[0])).toBe('今天 12:30')
    expect(formatTime('raw timestamp', 'en')).toBe('raw timestamp')
  })

  it('switches date and duration copy while preserving invalid server values', () => {
    vi.useFakeTimers()
    const now = new Date(2026, 8, 9, 12, 30)
    vi.setSystemTime(now)
    expect(formatDuration(3665)).toBe('1h 1m')
    expect(formatTime(now.toISOString())).toContain('today')
    setLocale('zh-CN')
    expect(formatTime(now.toISOString())).toBe('今天 12:30')
    expect(formatTime(new Date(2026, 8, 8, 11, 15).toISOString())).toBe('昨天 11:15')
    expect(formatTime('server-specific timestamp')).toBe('server-specific timestamp')
    expect(formatDuration(3665)).toBe('1 小时 1 分钟')
    expect(formatDuration(65)).toBe('1 分钟 5 秒')
    expect(formatDuration(0)).toBe('0 秒')
  })
})

describe('runtimeLabel', () => {
  it('labels custom Codex distinctly in both locales without changing normal Codex', () => {
    expect(backendLabel('codex')).toBe('Codex')
    expect(backendLabel('codex', 'custom')).toBe('Codex · Custom endpoint')
    setLocale('zh-CN')
    expect(backendLabel('codex', 'custom')).toBe('Codex · 自定义端点')
    setLocale('en')
    expect(runtimeLabel({ id: 'custom', title: '', backend: 'codex', codex_provider: 'custom', model: 'gpt-6-astra', effort: 'high' })).toBe('gpt-6-astra')
  })
  const catalog: RuntimeCatalog = {
    backends: {
      codex: {
        default_model: 'gpt',
        default_effort: 'high',
        models: [{ value: 'gpt', label: 'GPT' }],
        efforts: [{ value: 'high', label: 'High' }]
      },
      cursor: {
        default_model: 'auto',
        default_effort: 'high',
        models: [{ value: 'auto', label: 'Auto' }],
        efforts: [{ value: 'high', label: 'High' }]
      }
    }
  }

  it('does not render stale reasoning effort for Cursor', () => {
    const session: Session = {
      id: 'cursor-chat',
      title: 'Cursor chat',
      backend: 'cursor',
      model: 'auto',
      effort: 'high'
    }

    expect(runtimeLabel(session, catalog)).toBe('Auto')
  })

  it('still renders reasoning effort for backends that support it', () => {
    const session: Session = {
      id: 'codex-chat',
      title: 'Codex chat',
      backend: 'codex',
      model: 'gpt',
      effort: 'high'
    }

    expect(runtimeLabel(session, catalog)).toBe('GPT · High')
  })
})
