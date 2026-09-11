# Public development log

## Documentation

- Reorganized the README into a product overview, installation steps, and
  separate desktop, mobile, and website development workflows.
- Clarified the client/server boundary, current versus legacy client sources,
  and the distinction between local builds and release publishing.
- Checked development commands against package scripts and source CI, and
  checked installation guidance against the standalone server documentation.
- Refreshed the public README hero with a centered product introduction,
  website, community, and release badges, and an approved desktop and mobile
  product image. Placed the introduction below a more compact product image to
  keep the opening layout focused.
- Updated the introduction to name the currently supported agent backends,
  speak directly to AI researchers, and provide direct current download links
  for every available platform with a matching desktop release badge.
- Verified the README with GitHub's Markdown renderer and checked every new
  destination and badge URL before review. Reviewed the supplied image and its
  metadata before inclusion.

## Source snapshot

- Includes the Electron desktop and React Native mobile clients, legacy Swift
  targets, compatibility fixtures, and project documentation.
- Private development history, operational incident notes, and unreviewed
  screenshots and recordings are not included.
- This source snapshot does not itself publish or change any installed release.

## Electron workflow controls

- Added native provider skills and commands to the composer slash palette.
- Refined scheduled-job status, direct actions, working-directory navigation,
  and compact unavailable-agent guidance.
- Added a grouped keyboard-shortcuts page to Settings with localized labels.
- Documented privacy-preserving usage events for these workflows.
- Validated the affected Electron behavior with focused tests, type checking,
  a production build, and a local desktop UI pass.

Future entries should describe public-facing changes and validation without
including credentials, user data, private infrastructure, or internal history.
