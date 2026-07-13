# AgentsDock website

Static product and download site for AgentsDock.

## Preview

```bash
cd website
npm run dev
```

Open `http://localhost:4175`.

## Publish a desktop release

1. Upload the signed macOS DMG and Linux AppImage into `website/releases/`, or replace their URLs with your release-hosting URLs.
2. Add each artifact's SHA256 to `website/releases/latest.json`.
3. Set the platform's `available` value to `true`.
4. Deploy the contents of `website/` to any static host.

The UI reads `releases/latest.json` at runtime, so releases do not require rebuilding the website.
