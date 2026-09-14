# AgentsServer 1.0.0

Bring the published `1.0.0-beta.6` improvements to the stable release channel,
together with the merged source-proven Claude history replay correction.
The API contract, dependencies, signing key and data formats are unchanged.

## Included improvements

- Preserve asynchronous cross-chat message receipts, reply relationships and
  exact-key retries. Canceled retries do not recreate messages or wake chats.
  Provider-tool message bodies work through either explicit arguments or stdin.
- Keep active Codex goals running across supported native steering, including
  first-turn goal creation and between-turn handoff, without presenting internal
  control prompts as new human messages.
- Reconcile large and forked native histories without duplicating scheduled
  runs, mailbox wake instructions or already-recorded answers. Original message
  identities and timestamps are preserved; incomplete proof defers import
  without advancing the durable cursor.
- Match Claude assistant history to its verified provider message identity,
  including replies whose emoji or shortcode decorations were cleaned for live
  display. Proven duplicate imports become metadata-only; distinct replies,
  genuine messages and ambiguous records stay visible. This applies before
  import and when reopening recent or historical pages, without rewriting logs.
- Provide token-gated Interactive and View only chat shares, including playback
  and seeking for explicitly shared videos. Revocation remains enforced; general
  workspace file browsing and tmux are not exposed through a shared chat.
- Publish explicit Codex child-thread titles and later name updates through the
  existing event stream. The matching desktop release displays these names.
- Deliver small, coalesced Team Mail and Bulletin notification hints through
  the existing negotiated stream, without content polling or automatic remote
  agent turns. Bulletin author edits retain their version history.

Team Network remains a beta feature within the stable app/server release.
Cross-server Team Mail is a server inbox, not an automatic remote-chat execution
request; chat-addressed messages retain their separate idle-wake behavior.

## Compatibility and updating

The API contract remains **28**, and Team Hub schema remains **22**. Upgrading
from beta.6 does not add a migration or rewrite provider transcripts. Upgrading
from older versions still applies the migrations already shipped in the beta
line. Keep a pre-update backup: downgrading across a Hub or snapshot-store schema
change requires restoring its compatible backup, not opening migrated data with
an older runtime. Older text-only snapshots must be recreated to include videos.

Stable-channel installations can discover `1.0.0` through the managed updater.
Existing beta-channel installations must select **Stable** to discover it;
publication does not silently change their selected channel. Numeric version
ordering treats `1.0.0` as newer than `1.0.0-beta.6`, and signed manifests continue
to require immutable, versioned archive URLs.

Desktop activity/Stop freshness corrections and subagent-name presentation
require the matching app update. An app-only installation cannot repair the
old server's imported-history duplicates.

## Release acceptance

The candidate includes the Claude history correction merged after beta.6.
Publication requires a fresh complete release workflow, followed by verification
of the downloaded signed manifest, archive checksum and exact committed source.
These notes do not claim that the stable release has already been published or
installed.

Publication does not restart a live server or alter active jobs, goals, routes
or permissions. Install through the managed updater and wait for idle unless
the operator explicitly authorizes interruption. A queued update is not an
installed update.
