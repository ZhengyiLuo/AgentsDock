import { afterEach, describe, expect, it, vi } from 'vitest'
import { getLocale, resolveLocale, setLocale, subscribeLocale, t, validateLanguagePreference } from './i18n'
import { catalogs, defaultLocale, localeOptions } from './locales'

afterEach(() => setLocale('en'))

describe('language resolution and translation', () => {
  it('uses only supported Simplified Chinese system locales', () => {
    for (const system of ['zh', 'zh-CN', 'zh_SG', 'zh-Hans', 'zh-Hans-HK']) {
      expect(resolveLocale('system', system)).toBe('zh-CN')
    }
    for (const system of ['en-US', 'fr-FR', 'zh-TW', 'zh-HK', 'zh-Hant-CN', 'zh-Hans-Hant', 'zh-hansinvalid', '']) {
      expect(resolveLocale('system', system)).toBe('en')
    }
    expect(resolveLocale('en', 'zh-CN')).toBe('en')
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN')
  })

  it('validates stored choices without accepting unsupported locales', () => {
    expect(['en', 'zh-CN', 'system'].every(validateLanguagePreference)).toBe(true)
    for (const value of [null, {}, 'zh', 'zh-TW', 'English', 'constructor', '__proto__', 'toString', 1]) expect(validateLanguagePreference(value)).toBe(false)
  })

  it('uses registered catalogs for explicit selections without per-language branches', () => {
    for (const option of localeOptions) {
      expect(validateLanguagePreference(option.value)).toBe(true)
      expect(resolveLocale(option.value, 'unsupported')).toBe(option.value)
      setLocale(option.value)
      expect(t('settings.general')).toBe(catalogs[option.value]['settings.general'])
      expect(t('settings.general', undefined, defaultLocale)).toBe(catalogs[defaultLocale]['settings.general'])
      expect(getLocale()).toBe(option.value)
    }
  })

  it('falls back to English for a missing translated key', () => {
    const original = catalogs['zh-CN']
    const incomplete = { ...original }
    delete incomplete['settings.general']
    catalogs['zh-CN'] = incomplete
    try {
      expect(t('settings.general', undefined, 'zh-CN')).toBe('General')
      expect(t('missing-from-every-catalog', undefined, 'zh-CN')).toBe('missing-from-every-catalog')
    } finally {
      catalogs['zh-CN'] = original
    }
  })

  it('switches translations, interpolates literal values, and preserves unknown keys', () => {
    expect(t('settings.general')).toBe('General')
    setLocale('zh-CN')
    expect(t('settings.general')).toBe('通用')
    expect(t('language.system')).toBe('和系统一致')
    expect(t('settings.version', { version: '$& {untouched}' })).toBe('版本 $& {untouched}')
    expect(t('settings.version')).toBe('版本 {version}')
    expect(t('unknown-key')).toBe('unknown-key')
    expect(t('constructor')).toBe('constructor')
  })

  it('notifies subscribers only on actual changes and supports unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeLocale(listener)
    setLocale('en')
    expect(listener).not.toHaveBeenCalled()
    setLocale('zh-CN')
    expect(getLocale()).toBe('zh-CN')
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    setLocale('en')
    expect(listener).toHaveBeenCalledOnce()
  })
})
