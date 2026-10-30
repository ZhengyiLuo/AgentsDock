import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const source = fs.readFileSync('src/theme.ts', 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } })
const exports = {}
let scheme = 'light'
let preference = 'system'
vm.runInNewContext(outputText, {
  exports,
  require(name) {
    if (name === './store/useAppearanceStore') return { useAppearanceStore: selector => selector({ preference }) }
    assert.equal(name, 'react-native')
    return { useColorScheme: () => scheme }
  },
})

test('explicit themes override the device and System follows device appearance changes', () => {
  for (preference of ['system', 'light', 'dark']) {
    for (scheme of ['light', 'dark']) {
      assert.equal(exports.usePalette(), exports[preference === 'system' ? scheme : preference])
    }
  }
  preference = 'system'
  scheme = 'light'
})

test('shared UI roles have a readable, bounded type scale and matching line heights', () => {
  const roles = Object.values(exports.typography)
  assert.deepEqual(Array.from(roles, role => role.fontSize), [12, 13, 15, 17, 20])
  for (const role of roles) assert.ok(role.lineHeight >= role.fontSize + 4)
  assert.ok(Object.values(exports.spacing).every(value => value > 0 && value % 4 === 0))
  assert.ok(exports.radius.sm <= 8 && exports.radius.md <= 8)
  assert.deepEqual(Array.from(Object.values(exports.fontWeight)), ['400', '500', '600', '700'])
})

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => {
    const channel = parseInt(value, 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

test('primary and secondary text retain readable contrast on content surfaces in both themes', () => {
  assert.deepEqual(Object.keys(exports.light), Object.keys(exports.dark))
  for (const palette of [exports.light, exports.dark]) {
    for (const text of ['text', 'muted']) {
      for (const background of ['background', 'surface', 'raised', 'user']) {
        const light = luminance(palette[text])
        const dark = luminance(palette[background])
        const contrast = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
        assert.ok(contrast >= 4.5, `${text} on ${background}: ${contrast}`)
      }
    }
    assert.notEqual(palette.blue, palette.green)
    assert.notEqual(palette.red, palette.green)
  }
})

test('user bubbles have a distinct green surface in both themes', () => {
  for (const palette of [exports.light, exports.dark]) {
    const [red, green, blue] = palette.user.slice(1).match(/../g).map(value => parseInt(value, 16))
    assert.ok(green > red && green > blue, 'User bubbles must retain their green tint')
    assert.notEqual(palette.user, palette.raised)
    assert.notEqual(palette.user, palette.surface)
  }
  assert.ok(luminance(exports.light.user) > 0.8)
  assert.ok(luminance(exports.dark.user) < 0.1)
})

test('cross-chat messages and route references match the Mac semantic purple roles', () => {
  assert.equal(exports.dark.crossChatSurface, '#332444')
  assert.equal(exports.dark.crossChatBorder, '#685080')
  assert.equal(exports.light.crossChatSurface, '#eee5fb')
  assert.equal(exports.light.crossChatBorder, '#bca5dc')
  assert.equal(exports.dark.chatReferenceSurface, '#292344')
  assert.equal(exports.light.chatReferenceSurface, '#f0ecff')
  for (const palette of [exports.light, exports.dark]) {
    for (const [text, surface] of [['text', 'crossChatSurface'], ['muted', 'crossChatSurface'], ['crossChatControl', 'crossChatSurface'], ['chatReferenceText', 'chatReferenceSurface']]) {
      const a = luminance(palette[text]), b = luminance(palette[surface])
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${text} on ${surface} must remain readable`)
    }
  }
})

test('subtle dates remain readable while control outlines differ from separators', () => {
  for (const palette of [exports.light, exports.dark]) {
    for (const surface of ['background', 'surface']) {
      const a = luminance(palette.subtle), b = luminance(palette[surface])
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5)
    }
  }
  assert.notEqual(exports.light.controlBorder, exports.light.border)
  assert.notEqual(exports.light.controlSurface, exports.light.background)
  assert.ok(luminance(exports.light.subtle) > luminance(exports.light.muted))
})

test('adopted home and server UI use shared text metrics, weights and palette colors', () => {
  for (const file of ['Sidebar', 'ServerProfiles']) {
    const source = fs.readFileSync(`src/components/${file}.tsx`, 'utf8')
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node) {
      if (ts.isPropertyAssignment(node)) {
        const name = node.name.getText(tree)
        if (['fontSize', 'lineHeight', 'fontWeight', 'color'].includes(name)) {
          assert.ok(!ts.isNumericLiteral(node.initializer) && !ts.isStringLiteral(node.initializer), `${file}: use a token for ${name}`)
        }
      }
      if (ts.isJsxAttribute(node) && node.name.getText(tree) === 'color' && node.initializer) {
        assert.ok(!ts.isStringLiteral(node.initializer), `${file}: use the palette for icon colors`)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
})

test('main UI surfaces opt into shared roles without globally snapping native text metrics', () => {
  for (const file of ['Sidebar', 'ServerProfiles', 'ChatHeader', 'Composer', 'Dialogs', 'TimelineRows', 'ui']) {
    const component = fs.readFileSync(`src/components/${file}.tsx`, 'utf8')
    for (const token of ['typography', 'spacing', 'radius']) {
      assert.ok(component.includes(`${token}.`), `${file} must use ${token}`)
    }
  }
  const appText = fs.readFileSync('src/components/AppText.tsx', 'utf8')
  assert.match(appText, /scaleAppFont\(fontSize, scale\)/)
  assert.doesNotMatch(appText, /snapFontSize|typeScale\.reduce/)
})

test('native UI corner radii use shared tokens rather than per-component numbers', () => {
  assert.deepEqual(Object.values(exports.radius).sort((a, b) => a - b), [6, 8, 16, 999])
  function check(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { check(file); continue }
      if (!file.endsWith('.tsx')) continue
      const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function visit(node) {
        if (ts.isPropertyAssignment(node) && /^border.*Radius$/.test(node.name.getText(tree)) && ts.isNumericLiteral(node.initializer)) {
          assert.equal(Number(node.initializer.text), 0, `${file}: use a radius token`)
        }
        ts.forEachChild(node, visit)
      }
      visit(tree)
    }
  }
  check('src/components')
})
