import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getLocale, setLocale } from '../shared/i18n'
import { LanguageSettings } from './language'

describe('app language preferences', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agentsdock-language-test-'))
    setLocale('en')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    setLocale('en')
  })

  it('preserves English for an existing installation without a preference and does not create files', () => {
    const settings = new LanguageSettings(directory, () => 'zh-CN')
    expect(settings.get()).toEqual({ preference: 'en', systemLocale: 'zh-CN' })
    expect(getLocale()).toBe('en')
    expect(readdirSync(directory)).toEqual([])
  })

  it('persists and reloads Chinese independently of connection settings', () => {
    writeFileSync(join(directory, 'settings.json'), 'user-owned settings')
    const changed = vi.fn()
    const settings = new LanguageSettings(directory, () => 'en-US', changed)
    expect(settings.set('zh-CN')).toEqual({ preference: 'zh-CN', systemLocale: 'en-US' })
    expect(getLocale()).toBe('zh-CN')
    expect(JSON.parse(readFileSync(join(directory, 'app-language.json'), 'utf8'))).toEqual({ preference: 'zh-CN' })
    expect(readFileSync(join(directory, 'settings.json'), 'utf8')).toBe('user-owned settings')
    expect(changed).toHaveBeenCalledExactlyOnceWith({ preference: 'zh-CN', systemLocale: 'en-US' })
    expect(new LanguageSettings(directory, () => 'en-GB').get().preference).toBe('zh-CN')
    expect(readdirSync(directory).sort()).toEqual(['app-language.json', 'settings.json'])
  })

  it('tracks system-language changes and keeps an explicit language selection', () => {
    let system = 'en-US'
    const changed = vi.fn()
    const settings = new LanguageSettings(directory, () => system, changed)
    settings.set('system')
    system = 'zh-CN'
    settings.refreshSystemLocale()
    expect(getLocale()).toBe('zh-CN')
    expect(changed).toHaveBeenLastCalledWith({ preference: 'system', systemLocale: 'zh-CN' })
    settings.set('en')
    system = 'zh-SG'
    settings.refreshSystemLocale()
    expect(getLocale()).toBe('en')
    expect(settings.get()).toEqual({ preference: 'en', systemLocale: 'zh-SG' })
  })

  it.each([null, undefined, '', 'zh', 'de', { preference: 'zh-CN' }, ['en']])('rejects invalid preferences without a write: %j', preference => {
    const changed = vi.fn()
    const settings = new LanguageSettings(directory, () => 'en-US', changed)
    expect(() => settings.set(preference)).toThrow('Invalid language preference')
    expect(settings.get().preference).toBe('en')
    expect(readdirSync(directory)).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it.each(['{broken', '{"preference":"xx"}', 'null', '"zh-CN"'])('uses English without overwriting malformed stored preferences', contents => {
    const path = join(directory, 'app-language.json')
    writeFileSync(path, contents)
    expect(new LanguageSettings(directory, () => 'zh-CN').get().preference).toBe('en')
    expect(readFileSync(path, 'utf8')).toBe(contents)
  })

  it('does not change language or notify if persistence fails, and cleans its temporary file', () => {
    mkdirSync(join(directory, 'app-language.json'))
    const changed = vi.fn()
    const settings = new LanguageSettings(directory, () => 'en-US', changed)
    expect(() => settings.set('zh-CN')).toThrow()
    expect(settings.get().preference).toBe('en')
    expect(getLocale()).toBe('en')
    expect(changed).not.toHaveBeenCalled()
    expect(readdirSync(directory)).toEqual(['app-language.json'])
  })
})
