import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveLocale, setLocale, validateLanguagePreference, type LanguagePreference } from '../shared/i18n'
import type { LanguageSettingsSnapshot } from '../shared/types'

/** App-only preference: changing it never touches connection settings or sessions. */
export class LanguageSettings {
  private readonly path: string
  private preference: LanguagePreference = 'en'
  private systemLocale: string

  constructor(
    userData: string,
    private readonly readSystemLocale: () => string,
    private readonly onChange: (snapshot: LanguageSettingsSnapshot) => void = () => {}
  ) {
    this.path = join(userData, 'app-language.json')
    this.systemLocale = this.readSystemLocale()
    try {
      const stored: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (stored && typeof stored === 'object' && 'preference' in stored && validateLanguagePreference(stored.preference)) {
        this.preference = stored.preference
      }
    } catch {
      // Missing or unreadable preferences preserve the app's existing English default.
      // Do not overwrite the file merely because it could not be read.
    }
    this.applyLocale()
  }

  get(): LanguageSettingsSnapshot {
    return { preference: this.preference, systemLocale: this.systemLocale }
  }

  set(preference: unknown): LanguageSettingsSnapshot {
    if (!validateLanguagePreference(preference)) throw new Error('Invalid language preference')
    if (preference === this.preference) {
      this.refreshSystemLocale()
      return this.get()
    }
    mkdirSync(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporaryPath, `${JSON.stringify({ preference })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporaryPath, this.path)
    } finally {
      rmSync(temporaryPath, { force: true })
    }
    this.preference = preference
    this.systemLocale = this.readSystemLocale()
    this.applyLocale()
    const snapshot = this.get()
    this.onChange(snapshot)
    return snapshot
  }

  refreshSystemLocale(): void {
    const systemLocale = this.readSystemLocale()
    if (systemLocale === this.systemLocale) return
    this.systemLocale = systemLocale
    this.applyLocale()
    this.onChange(this.get())
  }

  private applyLocale(): void {
    setLocale(resolveLocale(this.preference, this.systemLocale))
  }
}
