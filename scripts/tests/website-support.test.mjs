import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = path => readFileSync(new URL(`../../website/${path}`, import.meta.url), 'utf8')

test('contact section presents Discord and WeChat as peer list items with a full-size QR link', () => {
  const contact = page('support.html').split('<h2 id="contact">')[1].split('<h2 id="requirements">')[0]
  assert.match(contact, /https:\/\/discord\.gg\/ZGDrhEWqPt/)
  assert.match(contact, /Get help and connect with us on Discord or WeChat:/)
  const list = contact.match(/<ul class="support-contacts">([\s\S]*?)<\/ul>/)?.[1]
  assert.ok(list)
  assert.equal((list.match(/<li>/g) || []).length, 2)
  assert.match(list, /<li><strong>Discord<\/strong>/)
  assert.match(list, /<li><strong>Connect on WeChat<\/strong>\s*<figure class="support-wechat">/)
  assert.match(contact, /<a href="\.\/assets\/wechat-contact\.png" target="_blank" rel="noopener" aria-label="Open the WeChat QR code at full size">/)
  assert.match(contact, /<img src="\.\/assets\/wechat-contact\.png" alt="[^"]+" width="888" height="1191"/)

  const image = readFileSync(new URL('../../website/assets/wechat-contact.png', import.meta.url))
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(image.readUInt32BE(16), 888)
  assert.equal(image.readUInt32BE(20), 1191)
})

test('WeChat contact image stays compact and preserves its aspect ratio', () => {
  const css = page('styles.css')
  assert.match(css, /\.support-wechat \{[^}]*width: 200px;[^}]*max-width: 100%;/)
  assert.match(css, /\.support-wechat img \{[^}]*width: 100%;[^}]*height: auto;/)
  assert.match(css, /\.support-wechat a:focus-visible \{[^}]*outline:/)
})
