import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'

const site = new URL('../../website/', import.meta.url)
const page = path => readFileSync(new URL(path, site), 'utf8')

for (const locale of ['', 'zh/']) {
  test(`privacy describes real platform controls, not the retired desktop switch (${locale || 'en'})`, () => {
    const html = page(`${locale}privacy.html`)
    const controls = html.split('id="analytics-controls"')[1].split('id="analytics-usage"')[0]
    assert.match(controls, locale ? /默认开启/ : /on by default/)
    assert.match(controls, locale ? /没有统计开关/ : /no analytics switch/)
    assert.match(controls, locale ? /旧版.*关闭过统计/ : /turned analytics off in an earlier version/)
    assert.match(controls, locale ? /Android.*设置 &rarr; Usage analytics/ : /Android.*Settings &rarr; Usage analytics/)
    assert.match(controls, locale ? /iOS 和 iPadOS.*不发送自定义使用统计/ : /iOS and iPadOS.*do not send custom usage analytics/)
    assert.doesNotMatch(html, /Settings &rarr; General &rarr; Usage analytics|off by default|默认关闭/)
  })

  test(`privacy explains usage without a technical event inventory (${locale || 'en'})`, () => {
    const html = page(`${locale}privacy.html`)
    const usage = html.split('id="analytics-usage"')[1].split('id="website-analytics"')[0]
    assert.match(usage, locale ? /第三方统计服务/ : /third-party service/)
    assert.match(usage, locale ? /随机的安装 ID/ : /random installation ID/)
    assert.match(usage, locale ? /安装数量也不等于实际人数/ : /installation counts are not the same as the number of people/)
    assert.match(usage, locale ? /不代表网络连接完全匿名/ : /does not make the network connection anonymous/)
    assert.match(usage, locale ? /不包含<\/strong>.*路径.*模型名.*endpoint.*主机名/ : /not<\/strong> include.*paths.*model names.*endpoints.*hostnames/)
    assert.doesNotMatch(html, /Mixpanel|AGENTSDOCK_DISABLE_ANALYTICS|connection_kind|<code>backend<\/code>|message_sent|event time|时间戳|failure_category/)
  })

  test(`privacy has reciprocal language navigation and sitemap entries (${locale || 'en'})`, () => {
    const html = page(`${locale}privacy.html`)
    assert.match(html, new RegExp(`<link rel="canonical" href="https://agentsdock.net/${locale}privacy.html"`))
    for (const target of ['privacy.html', 'zh/privacy.html']) {
      assert.ok(html.includes(`href="https://agentsdock.net/${target}"`))
      assert.ok(page('sitemap.xml').includes(`<loc>https://agentsdock.net/${target}</loc>`))
    }
    assert.match(html, locale ? /href="\.\.\/privacy.html" hreflang="en"/ : /href="\.\/zh\/privacy.html" hreflang="zh-Hans"/)
  })

  test(`FAQ agrees with privacy defaults and links to its localized explanation (${locale || 'en'})`, () => {
    const html = page(`${locale}faq.html`)
    assert.doesNotMatch(html, /off by default|默认关闭/)
    assert.match(html, locale ? /统计默认开启/ : /analytics are on by default/)
    assert.match(html, /href="\.\/privacy.html#analytics"/)
  })
}

test('Simplified Chinese footers link to the Chinese privacy page', () => {
  for (const name of readdirSync(new URL('zh/', site)).filter(name => name.endsWith('.html'))) {
    const html = page(`zh/${name}`)
    assert.doesNotMatch(html, /href="\.\.\/privacy.html">/, name)
    if (html.includes('<footer>')) assert.match(html, /href="\.\/privacy.html">/, name)
  }
})

test('both privacy pages retain the complete policy structure', () => {
  for (const locale of ['', 'zh/']) {
    const html = page(`${locale}privacy.html`)
    assert.match(html, /<article class="legal">/)
    assert.equal((html.match(/<h2(?:\s[^>]*)?>/g) || []).length, 10)
  }
})
