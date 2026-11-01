import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const expoRequire = createRequire(require.resolve('expo/package.json'))
const { getResolvedLocalesAsync } = expoRequire('@expo/config-plugins/build/utils/locales')

function loadTypeScript(filename, imports = {}) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
  const exports = {}
  vm.runInNewContext(outputText, {
    exports,
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  return exports
}

const locale = loadTypeScript('src/i18n/locale.ts')
const format = loadTypeScript('src/lib/format.ts')
const chinese = JSON.parse(fs.readFileSync('src/i18n/zh-CN.json', 'utf8'))
const translation = loadTypeScript('src/i18n/index.ts', {
  './zh-CN.json': chinese,
  '../store/useLanguageStore': { useLanguageStore: { getState: () => ({ locale: 'zh-CN' }) } },
})

test('System uses Simplified Chinese only for Simplified Chinese device locales', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-SG', 'ZH_cn']) {
    assert.equal(locale.resolveLocale('system', tag), 'zh-CN')
  }
  for (const tag of ['en-US', 'zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-CN']) {
    assert.equal(locale.resolveLocale('system', tag), 'en')
  }
  assert.equal(locale.resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(locale.resolveLocale('zh-CN', 'en-US'), 'zh-CN')
  assert.equal(locale.normalizeLanguagePreference('unexpected'), 'system')
})

test('UI translations interpolate names while leaving user text and English untouched', () => {
  assert.equal(translation.t('Settings'), '设置')
  assert.equal(translation.t('Language'), '语言')
  assert.equal(translation.t('Remove “{name}”?', { name: 'Main $& server' }), '移除“Main $& server”？')
  assert.equal(translation.translate('  Scan QR code  ', 'zh-CN'), '  扫描二维码  ')
  assert.equal(translation.translate('  ', 'zh-CN'), '  ')
  assert.equal(translation.translate('Custom user message', 'zh-CN'), 'Custom user message')
  assert.equal(translation.translate('Settings', 'en'), 'Settings')
})

test('mobile wording matches the Chinese preview labels', () => {
  const labels = {
    'Server model': 'default',
    Pinned: '置顶',
    '· build': '· 版本',
    Live: 'Live',
    Message: '发消息',
    'Send message': '发消息',
    Assistant: 'AI',
    'e.g. Home Mac': '例如：我的 Mac',
    'Access token': 'token',
    'Quick messages': '快捷消息',
    'Fork Chat': 'fork 会话',
    'Status report': '告诉我当前的状态',
    'Keep going.': '接着做',
    'Verify the result carefully.': '请再仔细的验证你的结论',
  }
  for (const [source, expected] of Object.entries(labels)) {
    assert.equal(translation.translate(source, 'zh-CN'), expected, source)
    assert.equal(translation.translate(source, 'en'), source)
  }
})

test('chat dates follow the selected app language', () => {
  const now = new Date(2026, 9, 18, 12)
  assert.equal(format.formatChatDate(new Date(2026, 9, 18, 9).toISOString(), now, 'zh-CN'), '今天')
  assert.equal(format.formatChatDate(new Date(2026, 9, 17, 9).toISOString(), now, 'zh-CN'), '昨天')
  assert.match(format.formatChatDate(new Date(2026, 8, 25, 9).toISOString(), now, 'zh-CN'), /9月25日/)
  assert.equal(format.formatChatDate(new Date(2026, 9, 18, 9).toISOString(), now, 'en'), 'Today')
})

test('native app advertises the same languages on iOS and Android', () => {
  const config = JSON.parse(fs.readFileSync('app.json', 'utf8')).expo
  const plugin = config.plugins.find(entry => Array.isArray(entry) && entry[0] === 'expo-localization')
  assert.deepEqual(plugin[1].supportedLocales, ['en', 'zh-CN'])
  assert.equal(config.ios.infoPlist.CFBundleAllowMixedLocalizations, true)
  assert.ok(config.locales['zh-CN'])
})

test('Expo keeps Chinese privacy descriptions on iOS without undefined Android string resources', async () => {
  const config = JSON.parse(fs.readFileSync('app.json', 'utf8')).expo
  const ios = await getResolvedLocalesAsync(process.cwd(), config.locales, 'ios')
  const android = await getResolvedLocalesAsync(process.cwd(), config.locales, 'android')
  assert.deepEqual(ios.localesMap['zh-CN'], {
    NSLocalNetworkUsageDescription: 'AgentsDock 需要连接同一局域网或 Tailscale 网络中的 Agent 服务器。',
    NSCameraUsageDescription: '允许 AgentsDock 扫描服务器连接二维码。',
    NSPhotoLibraryUsageDescription: '允许 AgentsDock 访问你选择发送给 Agent 的照片和视频。',
    NSPhotoLibraryAddUsageDescription: '允许 AgentsDock 将你选择的图片和视频保存到相册。',
  })
  assert.deepEqual(android.localesMap['zh-CN'], {})
})

test('mobile translations stay in sync with desktop source terms and mobile overrides', () => {
  execFileSync(process.execPath, ['scripts/generate-mobile-locale.mjs', '--check'], { stdio: 'pipe' })
  for (const phrase of ['Settings', 'Language', 'New chat defaults', 'Search chats and history', 'Add server', 'Scan QR code', 'Unread', 'Running']) {
    assert.ok(chinese[phrase], `${phrase} must have a Chinese translation`)
  }
})

test('marked static UI copy has a Chinese translation', () => {
  const brandAndUnits = new Set(['AgentsDock', 'Codex ·', '· CPU', 'MB', 'KB'])
  function visitDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) visitDirectory(filename)
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
        const tree = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
        function visit(node) {
          if (ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'Text'
            && node.openingElement.attributes.properties.some(prop => prop.name?.text === 'localize')) {
            for (const child of node.children) {
              if (!ts.isJsxText(child)) continue
              const phrase = child.text.replace(/\s+/g, ' ').trim()
              if (/[a-z]/i.test(phrase) && !brandAndUnits.has(phrase)) {
                assert.ok(chinese[phrase], `${filename}: missing translation for ${phrase}`)
              }
            }
          }
          ts.forEachChild(node, visit)
        }
        visit(tree)
      }
    }
  }
  visitDirectory('src/components')
})
