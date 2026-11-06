# AgentsDock website

Static product and download site for AgentsDock.

## Preview

```bash
cd website
npm run dev
```

Open `http://localhost:4175`.

Run the website content and release-link regression tests from the repository root:

```bash
node --test scripts/tests/website-*.test.mjs
```

## Website languages

English pages live at the site root and Simplified Chinese at `zh/`. Keep each
localized page's language menu, canonical URL, reciprocal `en` / `zh-Hans`
alternate links, and `sitemap.xml` entries in sync. Shared assets and analytics
remain at the root. The website languages are independent of languages
supported by the clients.

The retired `zh-TW/` paths contain only no-index redirects to the matching
Simplified Chinese pages. Preserve these for old links, but do not list them in
language menus, alternate metadata, or the sitemap.

## Publish a desktop release

1. Upload the signed macOS DMG and Linux AppImage into `website/releases/`, or replace their URLs with your release-hosting URLs.
2. Add each artifact's SHA256 to `website/releases/latest.json`.
3. Set the platform's `available` value to `true`.
4. Deploy the contents of `website/` to any static host.

Keep the desktop metadata in `releases/latest.json` and the English/Chinese
homepage and client-install fallback links in sync. The UI checks the public
GitHub release feeds at runtime; failed requests retain the static links.
Android discovery scans at most three 100-release pages and only replaces a
pinned APK after finding that release in the fetched window, so a truncated or
stale response cannot downgrade it. Mobile releases are versioned separately.
