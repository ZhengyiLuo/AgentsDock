import english from './en.json'
import simplifiedChinese from './zh-CN.json'

/** Add a catalog and one registration here; consumers never enumerate languages. */
const languages = {
  en: {
    label: 'English',
    messages: english,
    matchesSystemLocale: (value: string) => /^en(?:-|$)/.test(value)
  },
  'zh-CN': {
    label: '简体中文',
    messages: simplifiedChinese,
    // Do not offer the Simplified catalog for a Traditional Chinese system locale.
    matchesSystemLocale: (value: string) => !value.includes('-hant')
      && (value === 'zh' || /^zh-(?:hans|cn|sg)(?:-|$)/.test(value))
  }
}

export type Locale = keyof typeof languages
export const defaultLocale: Locale = 'en'

export const catalogs: Record<string, Readonly<Record<string, string>>> = Object.fromEntries(
  Object.entries(languages).map(([value, definition]) => [value, definition.messages])
)

/** Autonyms stay readable regardless of the currently selected language. */
export const localeOptions: ReadonlyArray<{ value: Locale; label: string }> = Object.entries(languages)
  .map(([value, definition]) => ({ value: value as Locale, label: definition.label }))

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.hasOwn(languages, value)
}

export function resolveSystemLocale(systemLocale: string): Locale {
  const normalized = systemLocale.toLowerCase().replaceAll('_', '-')
  return localeOptions.find(option => languages[option.value].matchesSystemLocale(normalized))?.value ?? defaultLocale
}
