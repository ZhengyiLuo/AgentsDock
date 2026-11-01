# AgentsDock 1.0.11 — stable candidate

This candidate promotes the desktop/server functionality shipped in
`1.0.11-beta.12`, source `ab95ad3284f91997c2b249ac413b155f99c09ce6`.
It does not incorporate later changes from main. The desktop app, npm runtime,
short CLI and signed legacy server bridge will share version `1.0.11`.

## Changes since stable 1.0.10

- Add the Gemini API backend on desktop and server, using the supported Gemini
  CLI runtime. Google/CLI sign-in is not included.
- Improve large-history loading, repair-record visibility and provider-session
  recovery. Fix Claude running-chat forks with fractional-second timestamps.
- Add terminal pairing QR output and improve server address selection and
  connection recovery.
- Group desktop chats into Unread and Running sections while retaining saved
  folders and pins.
- Improve CLI setup and managed server lifecycle behavior; expose Codex goal
  status in server summaries for compatible mobile clients.
- Extend privacy-limited desktop and shared-chat usage reporting.

## Preparation and acceptance

This is an unpublished candidate. Prior beta signing and scoped checks are
historical evidence, not acceptance of the new stable packages. New signed
packages, exact npm/bridge parity and native upgrade checks are required.

Before publication, exercise existing populated provider histories, attachments,
saved connections and settings through the actual app/server update boundary.
Verify follow-up messages after upgrading, busy/queued work handling, cold
restart and failure/retry behavior. Record any platform or logout/reboot
boundaries that remain untested. Publication is held for review of these results.

Windows installers use the existing unsigned distribution policy and may show
security warnings. Official macOS packages require Developer ID signing and
Apple notarization. Mobile builds are separate. Later main fixes, including
Codex model-switch compaction recovery and subsequent mobile queue recovery,
are outside this frozen product source.
