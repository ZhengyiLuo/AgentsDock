import assert from 'node:assert/strict'
import { mobileCodeEditorNavigationAllowed } from './mobileCodeEditorSecurity'

assert.equal(mobileCodeEditorNavigationAllowed('about:blank'), true)
assert.equal(mobileCodeEditorNavigationAllowed('https://agentsdock.local/editor/'), true)
assert.equal(mobileCodeEditorNavigationAllowed('https://agentsdock.local/editor/help'), true)
assert.equal(mobileCodeEditorNavigationAllowed('https://agentsdock.local/elsewhere'), false)
assert.equal(mobileCodeEditorNavigationAllowed('https://agentsdock.local.evil.example/editor/'), false)
assert.equal(mobileCodeEditorNavigationAllowed('http://agentsdock.local/editor/'), false)
assert.equal(mobileCodeEditorNavigationAllowed('data:text/html,untrusted'), false)
assert.equal(mobileCodeEditorNavigationAllowed('not a url'), false)

console.log('mobile code editor security tests passed')
