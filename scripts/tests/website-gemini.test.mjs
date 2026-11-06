import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = path => readFileSync(new URL(`../../website/${path}`, import.meta.url), 'utf8')

for (const locale of ['', 'zh/']) {
  test(`homepage lists Gemini with a local logo (${locale || 'en'})`, () => {
    const html = page(`${locale}index.html`)
    const hero = html.match(/class="hero-lede">([^<]*)<\/p>/)?.[1]
    assert.equal(hero, locale
      ? '为 agentic AI 研究而设计的 IDE。从任何设备访问你的 agent 服务器。'
      : 'An IDE designed for agentic AI research. Access your agent server from any device.')
    assert.match(html, /assets\/gemini-logo\.svg/)
    assert.match(html, /class="ways-tile-label">Gemini<\/span>/)
    for (const name of ['description', 'og:description', 'twitter:description']) {
      assert.match(html, new RegExp(`(?:name|property)="${name}" content="[^"]*Gemini`))
    }
  })

  test(`connection guide distinguishes Gemini API from CLI login (${locale || 'en'})`, () => {
    const html = page(`${locale}agents.html`)
    assert.match(html, /assets\/gemini-logo\.svg/)
    assert.match(html, /<strong>Gemini<\/strong>/)
    assert.match(html, /id="gemini-api"/)
    assert.match(html, /href="#gemini-api"/)
    assert.match(html, /https:\/\/generativelanguage\.googleapis\.com/)
    assert.match(html, /https:\/\/ai\.google\.dev\/gemini-api\/docs\/api-key/)
    assert.match(html, locale ? /不支持 Google 账号或 CLI 登录/ : /does not support Google account or CLI login/)
    assert.doesNotMatch(html.match(/<pre><code>[\s\S]*?<\/code><\/pre>/)?.[0] || '', /gemini/i)
  })

  test(`hero shows five linked provider logos below its introduction (${locale || 'en'})`, () => {
    const html = page(`${locale}index.html`)
    const strip = html.match(/<ul class="hero-providers"[^>]*>([\s\S]*?)<\/ul>/)?.[1]
    assert.ok(strip, 'Missing hero provider logos')
    for (const name of ['Claude Code', 'Codex', 'OpenCode', 'Cursor', 'Gemini']) {
      assert.ok(strip.includes(`aria-label="${name}"`), `Missing accessible ${name} logo`)
      assert.ok(strip.includes(`class="hero-provider-tooltip" aria-hidden="true">${name}</span>`))
    }
    assert.equal((strip.match(/<img /g) || []).length, 5)
    assert.match(strip, /href="\.\/agents\.html#gemini-api"/)
    assert.ok(html.indexOf('class="hero-lede"') < html.indexOf('class="hero-providers"'))
    assert.ok(html.indexOf('class="hero-providers"') < html.indexOf('class="hero-actions"'))
  })

  test(`setup guide routes Gemini to API setup (${locale || 'en'})`, () => {
    const html = page(`${locale}setup.html`)
    assert.match(html, /href="\.\/agents\.html#gemini-api"/)
    assert.match(html, /Gemini/)
    assert.match(html, /npm install -g agentsdock<\/code>/)
  })
}

test('Gemini logo is self-contained', () => {
  const logo = page('assets/gemini-logo.svg')
  assert.match(logo, /<svg/)
  assert.doesNotMatch(logo, /(?:href|src)="https?:/)
})

test('hero provider circles have no background fill', () => {
  const css = page('styles.css')
  const circle = css.match(/\.hero-provider \{([^}]+)\}/)?.[1]
  assert.ok(circle?.includes('background: transparent;'))
  assert.ok(circle.includes('border-radius: 50%;'))
  assert.doesNotMatch(css, /\.hero-provider--dark/)
})
