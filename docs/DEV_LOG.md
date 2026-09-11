# Public development log

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

Future entries should describe public-facing changes and validation without
including credentials, user data, private infrastructure, or internal history.
