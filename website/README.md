# AgentsDock website

Static product and download site for AgentsDock.

This source snapshot omits unreviewed screenshots, demo recordings, and
organization endorsement logos. Text placeholders keep the site usable without
those assets. The AgentsDock icon and provider marks remain; third-party marks
identify integrations and do not imply endorsement.

Google Analytics initialization is disabled in this snapshot. A deployment must
explicitly configure its own analytics and verify the applicable privacy text.
The existing release manifest points to the official public binary channel;
it is not a claim that this source snapshot built those artifacts.

## Preview

```bash
cd website
npm run dev
```

Open `http://localhost:4175`.

## Configure download links for an authorized website deployment

1. Use already-published, verified release artifacts and their immutable versioned URLs in `website/releases/latest.json`. Website setup does not authorize publishing an app release.
2. Add each artifact's SHA256 to `website/releases/latest.json`.
3. Set the platform's `available` value to `true`.
4. Deploy the contents of `website/` to any static host.

The UI reads `releases/latest.json` at runtime, so releases do not require rebuilding the website.
