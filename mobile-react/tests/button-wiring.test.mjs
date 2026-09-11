import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const componentsRoot = path.resolve('src/components')

function componentFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return componentFiles(target)
    return entry.isFile() && entry.name.endsWith('.tsx') ? [target] : []
  })
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function hasAttribute(node, name) {
  return node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.text === name)
}

const onPressControls = new Set([
  'Pressable',
  'AnimatedPressable',
  'IconButton',
  'SheetCloseButton',
  'PrimaryButton',
  'SecondaryButton',
  'ModeButton',
  'SearchResult',
  'Command',
  'Action',
  'SwipeAction',
])

test('every declared mobile tappable has an activation callback', () => {
  const missing = []
  let audited = 0
  for (const filename of componentFiles(componentsRoot)) {
    const text = fs.readFileSync(filename, 'utf8')
    const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName.getText(sourceFile)
        const expectsOnPress = onPressControls.has(name) || name.startsWith('Touchable') || name === 'Button'
        if (expectsOnPress) {
          audited += 1
          if (!hasAttribute(node, 'onPress') && !hasAttribute(node, 'onPressIn')) {
            missing.push(`${path.relative(process.cwd(), filename)}:${lineOf(sourceFile, node)} <${name}>`)
          }
        } else if (name === 'Switch') {
          audited += 1
          if (!hasAttribute(node, 'onValueChange')) missing.push(`${path.relative(process.cwd(), filename)}:${lineOf(sourceFile, node)} <Switch>`)
        } else if (name === 'MenuView') {
          audited += 1
          if (!hasAttribute(node, 'onPressAction')) missing.push(`${path.relative(process.cwd(), filename)}:${lineOf(sourceFile, node)} <MenuView>`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  assert.ok(audited >= 125, `button audit unexpectedly found only ${audited} controls`)
  assert.deepEqual(missing, [])
})

test('native page sheets use protected close targets and state-first dismissal', () => {
  const ui = fs.readFileSync(path.resolve('src/components/ui.tsx'), 'utf8')
  const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
  const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
  const servers = fs.readFileSync(path.resolve('src/components/ServerProfiles.tsx'), 'utf8')
  const review = fs.readFileSync(path.resolve('src/components/CodeReview.tsx'), 'utf8')
  const controls = fs.readFileSync(path.resolve('src/components/CodexControls.tsx'), 'utf8')
  const requests = fs.readFileSync(path.resolve('src/components/CodexInteractionShelf.tsx'), 'utf8')
  assert.match(ui, /sheetClose: \{ width: 48, height: 48/)
  assert.match(ui, /export function IconButton[\s\S]*?pressInHandled\.current = true[\s\S]*?onPress=\{handlePress\}[\s\S]*?onPressIn=\{handlePressIn\}/)
  assert.match(ui, /export function SheetCloseButton[\s\S]*?pressInHandled\.current = true[\s\S]*?onPress=\{handlePress\}[\s\S]*?onPressIn=\{handlePressIn\}/)
  assert.doesNotMatch(ui, /hitSlop=/, '44–48pt sibling controls must not overlap tap regions')
  assert.match(dialogs, /testID=\{`sheet-close-\$\{titleKey\}`\}/)
  assert.match(dialogs, /sheetHeader: \{ minHeight: 64/)
  const sharedClose = dialogs.slice(dialogs.indexOf('  const close = () => {'), dialogs.indexOf('  const didDismiss = () => {'))
  assert.ok(sharedClose.indexOf('onClose()') < sharedClose.indexOf('requestAnimationFrame(dismissAppKeyboard)'))
  assert.match(appShell, /testID="chat-details-close"/)
  assert.match(servers, /testID="server-management-close"/)
  assert.match(review, /testID="review-close"/)
  assert.match(review, /header: \{ minHeight: 64/)
  assert.match(controls, /testID="codex-controls-close"/)
  assert.match(requests, /closeTestID="codex-requests-close"/)
  assert.match(requests, /testID=\{resolvedCloseTestID\}/)
  assert.match(controls, /presentationStyle="pageSheet" allowSwipeDismissal/)
  assert.match(requests, /presentationStyle="pageSheet" allowSwipeDismissal/)
})

test('successful dialog mutations dismiss before deferred keyboard cleanup', () => {
  const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
  assert.match(
    dialogs,
    /await connection\.sendDigest\([\s\S]*?if \(isCurrent\(\)\) \{\s+onClose\(\)\s+requestAnimationFrame\(dismissAppKeyboard\)/,
  )
  assert.match(
    dialogs,
    /if \(saved\) \{\s+onClose\(\)\s+requestAnimationFrame\(dismissAppKeyboard\)/,
  )
})

test('audited keyboard and failure paths cannot swallow the first tap silently', () => {
  const controls = fs.readFileSync(path.resolve('src/components/CodexControls.tsx'), 'utf8')
  const inspector = fs.readFileSync(path.resolve('src/components/Inspector.tsx'), 'utf8')
  const media = fs.readFileSync(path.resolve('src/components/MediaGrid.tsx'), 'utf8')
  const artifactViewer = fs.readFileSync(path.resolve('src/components/file-viewer/ArtifactFileViewerModal.tsx'), 'utf8')
  const terminal = fs.readFileSync(path.resolve('src/components/TerminalView.tsx'), 'utf8')
  assert.match(controls, /<ScrollView[\s\S]*?testID="codex-controls-scroll"[\s\S]*?keyboardShouldPersistTaps="always"/)
  assert.match(inspector, /<ScrollView keyboardShouldPersistTaps="always">/)
  assert.match(terminal, /<ScrollView horizontal keyboardShouldPersistTaps="always"/)
  assert.match(media, /<FileTransferNotice state=\{transfer\.state\}/)
  assert.doesNotMatch(media, /media failures stay local to the invoked action/)
  assert.match(artifactViewer, /testID="artifact-file-viewer-close"/)
  assert.match(artifactViewer, /touchSize=\{48\}/)
  assert.doesNotMatch(media, /testID="media-viewer-close"/)
  assert.doesNotMatch(media, /video-close-inline|videoClose: \{/)
  assert.match(controls, /setOpen\(true\); requestAnimationFrame\(dismissAppKeyboard\)/)
  assert.match(inspector, /setOpen\(true\); requestAnimationFrame\(dismissAppKeyboard\)/)
})

test('known compact controls retain 44-point minimum targets', () => {
  const sources = componentFiles(componentsRoot).map(filename => fs.readFileSync(filename, 'utf8')).join('\n')
  for (const style of ['modeButton', 'moreButton', 'traceDetailAction', 'jobHistoryMore', 'lifecycleSummary', 'choiceChip', 'otherOptionHeader']) {
    assert.match(sources, new RegExp(`${style}: \\{[^}]*minHeight: 44`), `${style} must be at least 44pt`)
  }
  assert.match(sources, /tab: \{[^}]*minHeight: 44/)
  assert.match(sources, /refresh: \{ minHeight: 44/)
  assert.match(sources, /queuePrompt: \{[^}]*minHeight: 44/)
  assert.match(sources, /pinIdentity: \{[^}]*minHeight: 44/)
  assert.match(sources, /fileIdentity: \{[^}]*minHeight: 44/)
})

test('scheduled-job saving is single-flight and cannot dismiss its sheet mid-save', () => {
  const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')
  assert.match(dialogs, /const savingRef = useRef\(false\)/)
  assert.match(dialogs, /if \(savingRef\.current \|\| !scopeIsCurrent\(\) \|\| scheduleError\) return/)
  assert.match(dialogs, /if \(saveEpoch\.current !== operationEpoch \|\| !scopeIsCurrent\(\)\) return/)
  assert.match(dialogs, /dismissable=\{!saving\}/)
})

test('disabled server selector does not open a dead native menu', () => {
  const servers = fs.readFileSync(path.resolve('src/components/ServerProfiles.tsx'), 'utf8')
  assert.match(servers, /if \(unavailable\) return trigger/)
})
