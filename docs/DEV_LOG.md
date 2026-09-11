# Public development log

## Mobile compact panels and cross-chat catch-up — 0.1.2 (173)

- Apple validation and processing completed successfully; build 173 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `6687f01`.
- Signed archive and exported IPA passed distribution-signature, framework ABI,
  version, privacy, production-feature/fixture-exclusion and matching-symbol
  checks. Both source CI jobs passed for the exact binary source commit.
- Source verification passed 388 rendered/contract checks, all 81 library,
  2 API and 12 store test modules, 20 goal-component and 9 server-goal-settings
  checks, and rendered file-transfer interactions. Counts overlap between
  focused and broad suites; these are not physical-device acceptance tests.
- Advance the marketing version to 0.1.2 after Apple closed the approved 0.1.1
  release train. The initial 0.1.1 build-173 candidate was rejected during
  validation and was not uploaded; application behavior is unchanged.

- Collapse goals and queued messages by default into touch-sized summary
  headers. Expanded content stays scrollable within a shared composer height
  budget; folding preserves queued edits and hidden editors release focus.
- Add the desktop's passive sender-grouped chat inbox with bounded Markdown,
  per-message receipt state/time, full-body loading, pagination and confirmed
  deletion. Opening it does not mark messages read or start agent work.
- Keep cross-chat activity in chronological segments, including lazy-loaded
  traces and tool results that finish after a message was sent. Preserve the
  visible live-progress tail and avoid repeating commentary in earlier traces.
- Support revision-safe recipient editing and Run now only when explicitly
  advertised by the server. Validate message identity and body hashes, retain
  the sender's original body, and fence stale reconnect/permission-wait actions.
- Retain build 172's delivered-queue reconciliation and the main repository's
  iOS/iPadOS analytics removal. Nullable route limits now mean unlimited access.
- Extend CI with mailbox, body verification, activity chronology, queue control
  races, folding and actual rendered-button regressions. Native-host tests do
  not claim physical-device or simulator pixel acceptance; broader desktop
  workflow and import-history parity remain documented follow-up work.

## Mobile queue reconciliation — 0.1.1 (172)

- Apple validation and processing completed successfully; build 172 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `9748210`.
- The signed arm64 iPhone/iPad archive and exported IPA passed version,
  distribution-signature, framework-ABI, production-bundle, and matching-symbol
  checks. Both source CI jobs passed for the binary source commit.
- Remove delivered native-goal messages and explicitly superseded queue IDs
  without matching by message text or hiding unrelated queued work.
- Fence delayed timeline and queue reads against newer delivery observations,
  concurrent reads, reconnects, and server-instance changes. Empty or partial
  queue membership signals now request an authoritative queue refresh.
- Keep older stream packets from restoring a stale queued row; confirm covered
  queue signals by a fresh read without treating timeline sequence numbers as
  an atomic queue version. Refresh retries are bounded.
- Do not recreate a "still queued" warning from a late deferred response after
  the message has left the queue. Exact admission clears an uncertainty warning;
  cancellation or unrelated messages do not claim delivery confirmation.
- Preserve the desktop async cross-chat lifecycle when legacy compatibility
  receipts appear later, avoiding duplicate pending cards and status regressions.
- Add pure observation-clock tests, real-store delivery/reconnect races, and
  rendered queue/card regressions to source verification. Native-host mocks do
  not substitute for physical-device interaction or pixel testing.

## Source verification

- Mobile CI now runs the cross-chat protocol, projection, route/queue race,
  rendering, recipient-picker, and native-workspace resolution regressions.
- The additional checks use synthetic data and mocked native boundaries;
  source CI still does not build signed applications or publish releases.

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

## Mobile cross-chat parity — 0.1.1 (171)

- Apple validation and processing completed successfully; build 171 is active
  for internal TestFlight testing with automatic notifications enabled.
  External beta review was not submitted. Binary source: `aa1153be`.
- Align mobile with the current desktop async agent-message protocol: one
  Markdown card per message, pending incoming messages in the queue, and
  delivery-time chronology without duplicating internal provider prompts.
- Show granted chat access, pending grants, route limits, loading/errors, and
  revision-safe Revoke controls. Reconnects fence stale requests and callbacks.
- Add exact queued-message removal with truthful confirmation, duplicate-tap
  protection, and desktop purple pending-message styling.
- Include offline server inboxes in `@@` discovery and distinguish capability-gated
  `@@bulletin` posts from `@@all` inbox broadcasts.
- Validate real component handlers against synthetic native hosts, projection
  and store/API race regressions, broad library tests, and native build checks.
  Synthetic rendering does not substitute for physical-device touch/pixel QA.
- Release preparation uses generated, ignored native projects and resolves the
  configured workspace name rather than assuming the legacy project name.
- Signed arm64 iPhone/iPad archive and exported IPA passed deep signature,
  framework ABI, version, production-entitlement, and matching-symbol checks.
  The production JavaScript bundle contains the new features and excludes the
  visual test fixture.

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
