import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = path => readFileSync(new URL(`../../website/${path}`, import.meta.url), 'utf8')

for (const locale of ['', 'zh/']) {
  for (const name of ['index.html', 'setup.html', 'faq.html', 'advanced-install.html']) {
    test(`Tailscale guidance explains cross-network access and alternatives (${locale}${name})`, () => {
      const lines = page(`${locale}${name}`).split('\n').filter(line => line.includes('Tailscale')).join('\n')
      assert.match(lines, locale ? /强烈推荐/ : /highly recommended/i)
      assert.match(lines, /Wi-Fi/)
      assert.match(lines, locale ? /局域网/ : /local network/)
      assert.match(lines, locale ? /除非.*VPN 或私有网络/ : /unless.*VPN or private network/)
      assert.doesNotMatch(lines, /optional|可选/i)
    })
  }

  test(`Tailscale setup keeps the same-network exception and both-device guidance (${locale || 'en'})`, () => {
    const html = page(`${locale}setup.html`)
    assert.match(html, /id="remote-tailscale"/)
    assert.match(html, /id="device-tailscale"/)
    assert.match(html, locale ? /同一局域网内可以直接使用服务器的局域网 IP/ : /On the same local network, you can use the server's local IP address/)
    assert.match(html, locale ? /两端都保持连接/ : /Keep Tailscale connected on both devices/)
  })
}
