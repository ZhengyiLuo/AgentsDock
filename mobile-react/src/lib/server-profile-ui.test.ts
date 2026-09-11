import {
  buildCreateServerProfileInput,
  buildUpdateServerProfileInput,
  editServerProfileDraft,
  findProfileByIdentity,
  initialServerProfileDraft,
  profileHostSubtitle,
  reorderedServerProfileIds,
  requiresIdentityResetConfirmation,
  unreadCountLabel,
  type ServerProfileListItem,
} from './server-profile-ui'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

const alpha: ServerProfileListItem = {
  id: 'alpha',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-alpha',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0,
}
const beta: ServerProfileListItem = {
  ...alpha,
  id: 'beta',
  name: 'Beta',
  serverUrl: 'https://beta.example:7850',
  serverIdentity: 'server-beta',
}

assertEqual(
  initialServerProfileDraft('edit-active', [alpha, beta], 'alpha'),
  editServerProfileDraft(alpha),
  'first-run Configure must open the active placeholder directly in the editor',
)
assertEqual(
  initialServerProfileDraft('edit-active', [], null),
  {
    profileId: null,
    name: '',
    serverUrl: '',
    accessToken: '',
    clearAccessToken: false,
    resetServerIdentity: false,
  },
  'first-run Configure must still open an editor if profile recovery yields no active row',
)
assertEqual(initialServerProfileDraft('manage', [alpha], 'alpha'), null, 'ordinary server management must start at the list')

const unchanged = editServerProfileDraft(alpha)
assertEqual(buildUpdateServerProfileInput(alpha, unchanged), {}, 'blank edit token must preserve the saved credential')

const cleared = { ...unchanged, clearAccessToken: true }
assertEqual(buildUpdateServerProfileInput(alpha, cleared), { accessToken: null }, 'token removal must be explicit')
assertEqual(buildUpdateServerProfileInput(alpha, cleared, 'server-alpha-tested'), { accessToken: null, serverIdentity: 'server-alpha-tested' }, 'a connection update must carry the identity from its successful test')

const replaced = { ...unchanged, accessToken: 'new-private-token' }
assertEqual(buildUpdateServerProfileInput(alpha, replaced), { accessToken: 'new-private-token' }, 'nonblank token must replace the saved credential')
assertEqual(buildUpdateServerProfileInput(alpha, unchanged, 'server-alpha-tested'), {}, 'a metadata-free edit must not forward a tested identity by itself')

const created = buildCreateServerProfileInput({
  ...unchanged,
  profileId: null,
  name: ' Lab ',
  serverUrl: 'lab.example:7850/',
  accessToken: '',
}, 'server-lab')
assertEqual(created, {
  name: 'Lab',
  serverUrl: 'http://lab.example:7850',
  serverIdentity: 'server-lab',
  serverSetupComplete: true,
}, 'new server input must normalize the URL without inventing a token')

assert(findProfileByIdentity([alpha, beta], 'server-beta')?.id === 'beta', 'canonical identity must find an existing profile')
assert(findProfileByIdentity([alpha, beta], 'server-beta', 'beta') === null, 'editing a profile must not duplicate-match itself')
assertEqual(reorderedServerProfileIds([alpha, beta], 'beta', -1), ['beta', 'alpha'], 'reorder must return the complete profile order')
assert(reorderedServerProfileIds([alpha, beta], 'alpha', -1) === null, 'reorder must reject an out-of-bounds move')

assert(profileHostSubtitle(alpha) === 'alpha.example:7850', 'selector must show a distinct server host')
assert(profileHostSubtitle({ ...alpha, name: 'alpha.example:7850' }) === null, 'selector must not repeat a host used as the profile name')
assert(unreadCountLabel(100) === '99+', 'unread badge must stay compact')
assert(requiresIdentityResetConfirmation({ ...alpha, lastConnectionError: 'Server identity changed from server-alpha to server-new.' }), 'identity changes must require confirmation')
assert(requiresIdentityResetConfirmation({ ...alpha, lastConnectionError: 'Server identity mismatch: expected server-alpha, received server-new.' }), 'identity mismatches must allow an explicit reset')

console.log('server profile UI regressions passed')
