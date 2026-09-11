import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const shell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const sidebar = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')
const network = fs.readFileSync(path.resolve('src/components/TeamNetwork.tsx'), 'utf8')
const routes = fs.readFileSync(path.resolve('src/lib/team-network.ts'), 'utf8')

test('mobile exposes the desktop Team Network sections from the chat workspace', () => {
  assert.match(sidebar, /testID="sidebar-team-network"/)
  assert.match(shell, /<TeamNetwork/)
  assert.match(network, /useState<TeamSection>\('mail'\)/)
  const navigation = network.slice(network.indexOf('<ScrollView style={[styles.tabScroller'), network.indexOf('</ScrollView>', network.indexOf('<ScrollView style={[styles.tabScroller')))
  assert.match(navigation, /label=\{unread \? `Mail/)
  assert.match(navigation, /icon=\{RadioTower\} label="Bulletin"/)
  assert.match(navigation, /label="Servers & People"/)
  assert.doesNotMatch(navigation, /label="Feed"|label="Skills"/)
  assert.ok(navigation.indexOf('Mail') < navigation.indexOf('Bulletin'))
  assert.ok(navigation.indexOf('Bulletin') < navigation.indexOf('Servers & People'))
})

test('Team Network buttons are backed by authenticated proxy operations', () => {
  assert.match(network, /teamNetworkGet<TeamSessionResponse>/)
  assert.match(network, /network\/messages/)
  assert.match(network, /network\/agents/)
  assert.match(network, /message\.kind === 'skill' \? <BookOpen/)
  assert.match(network, /state: 'read'/)
  assert.match(network, /testID="team-feed-send"/)
  assert.match(network, /scopeCurrent\(scope\)/)
  assert.match(network, /currentRoute\?\.basePath === scope\.route\.basePath/)
  assert.match(routes, /server_session_base_path === '\/api\/team-hub-server'/)
  assert.doesNotMatch(network, /hub_url|access_token|refresh_token/)
})

test('Team Network keeps navigation compact and unavailable state singular', () => {
  assert.match(network, /style=\{\[styles\.tabScroller, \{ backgroundColor: colors\.surface, borderColor: colors\.border \}\]\}/)
  assert.match(network, /tabScroller: \{ flexGrow: 0, flexShrink: 0, height: 58, borderBottomWidth:/)
  assert.match(network, /teamPickerScroller: \{ flexGrow: 0, flexShrink: 0, maxHeight: 54, borderBottomWidth:/)
  assert.match(network, /tab: \{ minHeight: 44, flexShrink: 0/)
  assert.match(network, /\{route && selectedTeam && projection && !selectedMessage \? <>/)
  assert.match(network, /\{route && selectedTeam && projection && error \? <View accessibilityRole="alert"/)
  assert.match(network, /!route \? <UnavailableState/)
  assert.equal(network.match(/Team Network isn’t connected/g)?.length, 1)
  assert.doesNotMatch(network, /Teamspace unavailable/)
  assert.doesNotMatch(network, /setError\('This AgentsServer does not expose an authenticated Teamspace connection/)
})

test('Team Network header uses compact desktop-aligned actions that remain operable', () => {
  assert.match(network, /const insets = useSafeAreaInsets\(\)/)
  assert.match(network, /paddingTop: insets\.top/)
  assert.match(network, /edges=\{\['bottom'\]\}/)
  assert.match(network, /icon=\{ArrowLeft\} label="Back to chats" testID="team-network-close"/)
  assert.doesNotMatch(network, /SheetCloseButton/)
  assert.match(network, /header: \{ minHeight: 58/)
  assert.match(network, /const serverName = activeProfile\?\.name\?\.trim\(\) \|\| 'Active AgentsServer'/)
  assert.match(network, /style=\{\[styles\.statusDot, \{ backgroundColor: networkStatusColor \}\]\}/)
  assert.match(network, /if \(state\.connected\) await state\.refreshSessions\(profileGeneration\)/)
  assert.match(network, /else await state\.reconnect\(\)/)
  assert.match(network, /testID="team-network-refresh"[\s\S]*?onPress=\{\(\) => void refreshWorkspace\(\)\}/)
  assert.match(network, /testID="team-network-retry"[\s\S]*?onPress=\{onRetry\}/)
  assert.match(network, /accessibilityState=\{\{ disabled: loading, busy: loading \}\}/)
  assert.match(network, /unavailableRetry: \{ minWidth: 148, minHeight: 44/)
  assert.match(network, /dismiss: \{ width: 44, height: 44/)
})

test('Team Network cancels detail loads on navigation without sharing the mailbox request counter', () => {
  assert.match(network, /requests\.current\.begin\('detail'\)/)
  assert.match(network, /requests\.current\.begin\('mail'\)/)
  const cancel = network.slice(network.indexOf('const cancelMessageLoad'), network.indexOf('const loadMail'))
  assert.match(cancel, /requests\.current\.cancel\('detail'\)/)
  assert.match(cancel, /setDetailLoading\(false\)/)
  for (const name of ['changeMailbox', 'backFromDetail', 'changeSection', 'refreshWorkspace']) {
    const handler = network.slice(network.indexOf(`const ${name} =`), network.indexOf(`const ${name} =`) + 220)
    assert.match(handler, /cancelMessageLoad\(\)/, `${name} must release a canceled message load`)
  }
})

test('Team changes clear old content and preserve drafts under their owning team', () => {
  const load = network.slice(network.indexOf('const loadWorkspace'), network.indexOf('useEffect(() =>', network.indexOf('const loadWorkspace')))
  assert.match(load, /requests\.current\.reset\(\)/)
  assert.ok(load.indexOf('clearTeamContent(nextTeam.id)') < load.indexOf('setTeamId(nextTeam.id)'))
  assert.match(load, /projectionValue\.network\?\.id !== nextTeam\.id/)
  assert.match(network, /draftsByTeam\.current\.set\(teamId, value\)/)
  assert.match(network, /setDraft\(draftsByTeam\.current\.get\(nextTeamId\) \?\? ''\)/)
  assert.match(network, /JSON\.stringify\(\[teamId, body\]\)/)
  assert.match(network, /JSON\.stringify\(\[teamId, externalAgentId, displayName, agentBackend\]\)/)
  assert.match(network, /return \(\) => requests\.current\.reset\(\)/)
})
