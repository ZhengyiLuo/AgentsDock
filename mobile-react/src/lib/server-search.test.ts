import assert from 'node:assert/strict'
import { SERVER_SEARCH_MIN_CHARACTERS, serverSearchQuery } from './server-search'

assert.equal(SERVER_SEARCH_MIN_CHARACTERS, 2)
assert.equal(serverSearchQuery(''), null)
assert.equal(serverSearchQuery('   '), null)
assert.equal(serverSearchQuery('x'), null)
assert.equal(serverSearchQuery(' x '), null)
assert.equal(serverSearchQuery('🙂'), null, 'one Unicode character must not bypass the server minimum')
assert.equal(serverSearchQuery('ok'), 'ok')
assert.equal(serverSearchQuery('  ok  '), 'ok')
assert.equal(serverSearchQuery('🙂🙂'), '🙂🙂')

console.log('server search query regressions passed')
