import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { catalogs, defaultLocale, localeOptions } from './locales'

const placeholders = (value: string) => [...new Set([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort()
const english: Record<string, string> = catalogs.en
const chinese: Record<string, string> = catalogs['zh-CN']
const translationPair = (key: string) => [english[key], chinese[key]]
const catalogDirectory = resolve(process.cwd(), 'src/shared/locales')

describe('localization catalog integrity', () => {
  it('registers one flat JSON catalog and one selector option per locale without duplicate keys', () => {
    const locales = Object.keys(catalogs).sort()
    expect(defaultLocale).toBe('en')
    expect(localeOptions.map(option => option.value).sort()).toEqual(locales)
    expect(localeOptions.every(option => option.label.trim())).toBe(true)
    expect(readdirSync(catalogDirectory).filter(file => file.endsWith('.json')).sort())
      .toEqual(locales.map(locale => `${locale}.json`).sort())
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const file = join(catalogDirectory, `${locale}.json`)
      const text = readFileSync(file, 'utf8')
      const parsed: unknown = JSON.parse(text)
      expect(parsed, locale).not.toBeNull()
      expect(Array.isArray(parsed), locale).toBe(false)
      expect(typeof parsed, locale).toBe('object')
      expect(parsed, locale).toEqual(catalog)
      expect(Object.values(catalog).every(value => typeof value === 'string'), locale).toBe(true)

      // JSON.parse keeps only the last duplicate property. Inspect the source
      // tree as well so a repeated semantic key cannot silently hide a value.
      const source = ts.parseJsonText(file, text)
      const keys = new Set<string>()
      const duplicates: string[] = []
      function visit(node: ts.Node): void {
        if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
          if (keys.has(node.name.text)) duplicates.push(node.name.text)
          keys.add(node.name.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(duplicates, locale).toEqual([])
      expect([...keys].sort(), locale).toEqual(Object.keys(catalog).sort())
    }
  })

  it('has complete English-key coverage and compatible placeholders in every locale', () => {
    expect(Object.keys(english).length).toBeGreaterThan(0)
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys(catalog).sort(), locale).toEqual(Object.keys(english).sort())
      for (const [key, translated] of Object.entries(catalog)) {
        expect(translated.trim(), `${locale}: ${key}`).not.toBe('')
        // Equal English/translated values are intentional for product names;
        // feature UI still uses the selected locale.
        const englishParams = placeholders(english[key]).filter(name => (
          locale !== 'zh-CN' || key !== 'ui.import.groupedCounts' || !['chats', 'folderLabel'].includes(name)
        ))
        expect(placeholders(translated), `${locale}: ${key}`).toEqual(englishParams)
      }
    }
  })

  it('keeps the approved Chinese terminology', () => {
    for (const [key, translated] of Object.entries(chinese)) {
      expect(translated, key).not.toMatch(/聊天|智能体|推理|跟随系统|跟随应用|审查|资源管理器|(?:持久|持续)(?: Codex )?目标/)
    }
    expect(chinese['settings.systemTheme']).toBe('和系统一致')
    expect(chinese['ui.composer.changeAgent']).toBe('更改 Agent')
  })

  it('retains the screenshot-review terminology across labels, actions, and help text', () => {
    for (const [key, source] of Object.entries(english)) {
      const translated = chinese[key]
      // Pinning a version is a different meaning from pinning UI content.
      if (/^(?:Pin|Unpin|Pinned)\b|^Chat \(pinned\)$/i.test(source)) {
        expect(translated, key).toContain('置顶')
        expect(translated, key).not.toContain('固定')
      }
      if (/\bexplorer\b/i.test(source)) expect(translated, key).toContain('源文件')
      if (source === 'Review') expect(translated, key).toBe('查看')
      const persistentGoal = source.match(/\bpersistent (?:Codex )?goals?\b/i)?.[0]
      if (persistentGoal) expect(translated.toLowerCase(), key).toContain(persistentGoal.toLowerCase())
    }
    expect(translationPair('ui.Inspector.pin_ff1cee7')).toEqual(['Pin', '置顶'])
    expect(translationPair('ui.Inspector.unpin_ee3c716')).toEqual(['Unpin', '取消置顶'])
    expect(translationPair('ui.Inspector.PinnedSection.pinned_f20c879')).toEqual(['Pinned', '已置顶'])
    expect(translationPair('timeline.ui.review')).toEqual(['Review', '查看'])
    expect(translationPair('editor.fileExplorer')).toEqual(['File explorer', '源文件'])
    expect(translationPair('editor.explorer')).toEqual(['Explorer', '源文件'])
    expect(translationPair('ui.CodexControls.GoalSettings.persistent_goal_389445f')).toEqual(['Persistent goal', 'Persistent goal'])
    expect(translationPair('ui.CodexServerSettings.CodexServerSettings.persistent_codex_goals_4690eb6')).toEqual(['Persistent Codex goals', 'Persistent Codex goals'])
    expect(translationPair('ui.Dialogs.JobDialog.run_fixed_times_60c342d')).toEqual(['Run fixed times', '运行固定次数'])
  })

  it('uses the exact approved session-specific help and Prompt placeholder', () => {
    expect(translationPair('ui.Inspector.PinnedSection.pin_important_messages_or_files_from_the_t_28fc9c2'))
      .toEqual(['Pin important messages or files from the timeline.', '从该会话中置顶重要消息或者文件'])
    for (const key of [
      'ui.Dialogs.SessionDialog.optional_per_chat_instructions_454671b',
      'ui.Inspector.SessionPromptField.optional_per_chat_instructions_454671b'
    ]) {
      expect(translationPair(key)).toEqual(['Optional per-chat instructions', '只适用该会话的通用指令'])
    }
  })

  it('resolves every statically referenced semantic key in app source', () => {
    const missing: string[] = []
    function scan(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) { scan(file); continue }
        if (!/\.tsx?$/.test(file) || /\.(test|spec)\./.test(file)) continue
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
        function visit(node: ts.Node): void {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
            const key = node.arguments[0]
            function check(expression: ts.Expression | undefined): void {
              if (!expression) return
              if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
                if (!Object.hasOwn(english, expression.text)) missing.push(`${file}: ${expression.text}`)
              } else if (ts.isConditionalExpression(expression)) {
                check(expression.whenTrue)
                check(expression.whenFalse)
              } else if (ts.isParenthesizedExpression(expression)) check(expression.expression)
            }
            check(key)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    scan(resolve(process.cwd(), 'src'))
    expect(missing).toEqual([])
  })
})
