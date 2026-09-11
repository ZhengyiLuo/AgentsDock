import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const app = fs.readFileSync(path.resolve('App.tsx'), 'utf8')
const chatScreen = fs.readFileSync(path.resolve('src/components/ChatScreen.tsx'), 'utf8')
const sidebar = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')
const composer = fs.readFileSync(path.resolve('src/components/Composer.tsx'), 'utf8')
const composerToolbarLayout = fs.readFileSync(path.resolve('src/lib/composer-toolbar-layout.ts'), 'utf8')

function callbackBody(name, nextName) {
  const start = appShell.indexOf(`const ${name} = useCallback`)
  const end = appShell.indexOf(`const ${nextName} = useCallback`, start)
  assert.notEqual(start, -1, `${name} must exist`)
  assert.notEqual(end, -1, `${nextName} must follow ${name}`)
  return appShell.slice(start, end)
}

test('native sheets publish before keyboard dismissal and search transfers focus without hiding', () => {
  for (const [name, nextName, publication] of [
    ['openServers', 'closeServers', 'setServers(mode)'],
    ['openSettings', 'openTeamNetwork', 'setSettings(true)'],
    ['openOptions', 'closeOptions', 'setOptions(true)'],
    ['openReview', 'closeReview', 'setReviewRun(runId)'],
    ['openInspectorAction', 'finishOptionsDismissal', "if (kind === 'digest') setDigest(true)"],
  ]) {
    const body = callbackBody(name, nextName)
    assert.ok(body.indexOf(publication) < body.indexOf('requestAnimationFrame(dismissAppKeyboard)'), `${name} must publish before dismissal`)
  }

  const searchBody = callbackBody('openSearch', 'openReview')
  assert.match(searchBody, /setSearch\(true\)/)
  assert.doesNotMatch(searchBody, /dismissAppKeyboard/)
  assert.match(appShell, /<SearchDialog[\s\S]*?visible=\{modalScopeCurrent && search && !isWelcomeSession\(selected\?\.id\)\}/)
  assert.match(sidebar, /icon=\{Settings\}[\s\S]*?onPress=\{\(\) => \{ if \(profileScopeIsCurrent\(profileScope\)\) onSettings\(\) \}\}/)
  assert.match(sidebar, /onAddServer=\{\(\) => \{ if \(profileScopeCanNavigate\(profileScope\)\) onAddServer\(\) \}\}/)
  assert.match(sidebar, /onManageServers=\{\(\) => \{ if \(profileScopeCanNavigate\(profileScope\)\) onManageServers\(\) \}\}/)
})

test('composer keeps auxiliary content scrollable above a pinned toolbar and preserves large-paste measurements', () => {
  assert.match(composer, /testID="composer-auxiliary-scroll"/)
  assert.match(composer, /maxHeight: viewportLimits\.auxiliaryMaxHeight/)
  assert.match(composer, /<View style=\{styles\.queueList\}>/)
  assert.match(composer, /style=\{\[styles\.composer/)
  assert.ok(composer.indexOf('testID="composer-auxiliary-scroll"') < composer.indexOf('style={[styles.composer'))
  assert.match(composer, /height: displayedInputHeight, maxHeight: viewportLimits\.inputMaxHeight/)
  assert.match(composer, /if \(!text\.length\) setInputHeight\(COMPOSER_INPUT_MIN_HEIGHT\)/)
  assert.doesNotMatch(composer, /if \(!draft\.length \|\| !text\.length\)/)
})

test('iOS composer corrects the app safe-area coordinate space without fallible automatic measurement', () => {
  assert.match(app, /edges=\{\['top', 'left', 'right'\]\}/)
  assert.match(chatScreen, /behavior=\{Platform\.OS === 'ios' \? 'padding' : Platform\.OS === 'android' \? 'height' : undefined\}/)
  assert.match(chatScreen, /keyboardVerticalOffset=\{Platform\.OS === 'ios' \? insets\.top : 0\}/)
  assert.match(chatScreen, /automaticOffset=\{Platform\.OS === 'android'\}/)
  assert.match(composer, /toolbar: \{ minHeight: 48, flexShrink: 0/)
  assert.match(composerToolbarLayout, /COMPOSER_COMPACT_TOOLBAR_HEIGHT = 44/)
  assert.match(composer, /toolbarCompact: \{ minHeight: COMPOSER_COMPACT_TOOLBAR_HEIGHT/)
})
