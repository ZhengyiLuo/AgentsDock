import { catalogs, defaultLocale, isLocale, resolveSystemLocale, type Locale } from './locales'

export type { Locale } from './locales'
export type LanguagePreference = 'system' | Locale
export type TranslationParams = Record<string, string | number>

let locale: Locale = defaultLocale
const listeners = new Set<() => void>()

export function validateLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'system' || isLocale(value)
}

export function resolveLocale(preference: LanguagePreference, systemLocale: string): Locale {
  return preference === 'system' ? resolveSystemLocale(systemLocale) : preference
}

export function getLocale(): Locale {
  return locale
}

export function setLocale(next: Locale): void {
  if (next === locale) return
  locale = next
  for (const listener of listeners) listener()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function t(key: string, params?: TranslationParams, localeOverride: Locale = locale): string {
  const catalog = catalogs[localeOverride] ?? catalogs[defaultLocale]
  const fallback = catalogs[defaultLocale]
  const text = (Object.hasOwn(catalog, key) ? catalog[key] : undefined)
    ?? (Object.hasOwn(fallback, key) ? fallback[key] : undefined)
    ?? key
  if (!params) return text
  // Callback replacement preserves literal dollar signs and never interprets user values as keys.
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (placeholder, name: string) => (
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  ))
}
