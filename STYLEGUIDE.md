# AgentsDock website — design system & style guide

The single source of truth for how the marketing site (`website/`, served at agentsdock.net + the
`georgialin.github.io/agentsdock` mirror) is styled. **Reuse these tokens, classes, and conventions
when building new pages or sections — don't invent a new design each time.** All styles live in
`styles.css`; this file documents them.

## Design tokens (`:root` in styles.css)

**Fonts**
- `--display` — **Space Grotesk** → all headings (`h1`, `h2`, `h3`), badges, wordmark.
- `--body-font` — **Instrument Sans** → all body text, labels, buttons.
- Monospace (`ui-monospace, SFMono-Regular, Menlo`) → inline `code`, terminal/IDE cards, IPs, file paths.

**Type sizes** — `--body-1` ≈20px, `--body-2` 17px (default docs body), `--line-loose` 1.6.

**Colors**
| Token | Value | Use |
|---|---|---|
| `--bg` | #0d1013 | page background (dark) |
| `--surface` / `--surface-2` | #141922 / #1a212c | cards, keycaps |
| `--line` | #2b333f | borders / dividers |
| `--text` | #f1f4f8 | primary text |
| `--muted` / `--muted-2` | #9aa4b2 / #ccd4e0 | secondary text |
| `--blue` | #5b9dff | **theme blue** — accents, active states, keycap text |
| `--blue-2` | #8aa4ff | inline-code text |
| `--accent-soft` | rgba(91,157,255,.14) | code / chip backgrounds |
| green | #54d18c | checkmarks, "online" dots, "Ready" |
| `--red` | #ef726b | diff deletions |

## Docs pages (setup.html, features.html, shortcuts.html)

Build a new docs page by copying `features.html` and swapping the content. Structure:
```
<main class="docs">
  <aside class="docs-nav"> …shared sidebar… </aside>
  <article class="legal docs-body"> …content… </article>
</main>
```
Head must include: GA4 snippet, OG/Twitter meta (og:image = `assets/og-card.png`), Google Fonts link,
`styles.css`. Header nav = **Home · Docs · Discord**. Footer + the scroll-spy `<script>` come from features.html.

**Typography classes** (inside `.legal.docs-body`):
- `<p class="section-kicker">Docs</p>` — uppercase eyebrow.
- `<h1>` — page title.  `<p class="legal-lead">` — 18px intro.
- `<h2 id="…">` — plain section heading (24px). Or big part header: `<h2 class="docs-part"><span class="docs-part-label">Part 1</span>…</h2>`.
- `<h3 class="docs-step"><span class="step-n">1</span>…</h3>` — numbered step. Plain `<h3>` = 18px.
- `<p>` / `<ul><li>` — body text, **17px** (`--body-2`), color #c4ccd8, line-height 1.6.
- `<code>` — inline code (blue-2 on accent-soft). `<pre><code>` — code block.
- `<figure class="docs-shot"><img|video …><figcaption>` — framed screenshot/video (see media rules).

**Shared sidebar** (`.docs-nav`): title `Docs`, then `.docs-nav-part` group links (Setup guide / Key
features / Keyboard shortcuts — add `active` on the current page's own group) with plain sub-anchor links.
Same page → `#id`; other docs page → `./page.html#id`. **Add any new docs page to the sidebar on every
docs page.**

**Keyboard shortcuts** (shortcuts.html): `.sc-table` with each key as a keycap
`<span class="sc-keys"><kbd>⌘</kbd><kbd>N</kbd></span>` — theme-blue text at `--body-2` size.

## Media & asset conventions (`website/assets/`)

- **Feature/demo videos**: compress with
  `ffmpeg -i in.mp4 -vf "scale=1600:-2" -an -c:v libx264 -crf 26 -preset veryslow -movflags +faststart out.mp4`
  (strip audio, ~1600px wide, ~0.1–1 MB). Always make a poster: `ffmpeg -i out.mp4 -vframes 1 -q:v 4 out-poster.jpg`.
  Embed with `<video autoplay muted loop playsinline preload="metadata" poster="…-poster.jpg">`.
- **Hero screenshots** (`app-desktop.png` ~2000px, `app-mobile.png`): light-gray border + radius
  (`.hero-desktop-shot img` / `.hero-mobile-shot img`).
- **Homepage feature showcase** (`.showcase`): full-width darker band, rows = media-left / text-right,
  media column wider. Chat/agent avatars use `assets/claude-code-logo.png` / `codex-logo.png`.
- **OG / social card** (`assets/og-card.png`, **1200×630**): light-blue bg, AgentsDock logo + "A dock for
  all your agents." + tilted desktop+mobile screenshots + platform/agent icon row (Apple · iPhone · Mac ·
  Linux · Claude · Codex). Generated with a Pillow script in a `/tmp` venv (see chat history / regenerate on request).

## Deploy

Edits on the `website-georgia` branch auto-deploy to agentsdock.net via `.github/workflows/deploy-pages.yml`,
then re-sync the `GeorgiaLin/agentsdock` github.io mirror (no CNAME, adds `rel=canonical`). Preview locally on
`:4200`. A concurrent session sometimes switches the working tree off `website-georgia` — work from a
`website-georgia` git worktree to be safe.
