# AgentsDock 1.0.12 stable preparation

Status: scope and acceptance preparation, reviewed 2026-11-24. No stable
candidate is frozen or published by this plan.

## Version and source

- Published desktop, legacy server, `agentsdock` CLI and `@agentsdock/server`
  are aligned at stable **1.0.11** and beta **1.0.12-beta.6**.
- Target **1.0.12** for the matched stable app and server. Use
  **1.0.12-beta.7** for the next validation iteration if one is distributed;
  keep this base version throughout stabilization.
- Prepare from reviewed main while retaining the published beta.6 release
  tooling and baseline pins. Beta.6 source is
  `0e46b3f81e98596da3d91c73137f89efeee05686`; main and that release line have
  diverged. Audit the release-only changes before freezing a new source commit.
- Main's development desktop version `0.2.0` / build 86 is not the proposed
  public version. Allocate the official build number during release preparation.
  Update the preparation inputs and acceptance baseline mappings for stable
  1.0.12 without rewriting earlier releases' associations or artifacts.

Public baselines: [stable desktop](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.11),
[beta.6 desktop](https://github.com/ZhengyiLuo/AgentsDock/releases/tag/v1.0.12-beta.6),
[legacy server releases](https://github.com/ZhengyiLuo/AgentsServer/releases).

## Proposed feature scope

Ship the reviewed main features together: optional tabbed, resizable chat
workspaces; file tabs and code intelligence; workspace chat creation and
navigation; provider model inventories; goal, queue and child-task reliability;
agent-created chats with mailbox routes; and coordinated recoverable updates.

Include the completed [workspace resize fix (#180)](https://github.com/ZhengyiLuo/AgentsDock/pull/180)
and [pinned-message jump fix (#181)](https://github.com/ZhengyiLuo/AgentsDock/pull/181).
Their combined local package already passed native pin, file-tab, split-pane,
draft-preservation and divider-extreme checks. That evidence does not replace
acceptance of the final stable package.

Review the narrow [inline-image fix (#177)](https://github.com/ZhengyiLuo/AgentsDock/pull/177)
and [local-file reveal fix (#156)](https://github.com/ZhengyiLuo/AgentsDock/pull/156)
for inclusion before freezing scope. Both have native macOS evidence; confirm
image sizing on Linux, the originally reported platform.

Do not add unrelated new features during this stabilization pass. Mobile has
its own release train and is outside this desktop/server cut.

## Remaining product work

1. Finish [pending paired-server updates (#170)](https://github.com/ZhengyiLuo/AgentsDock/pull/170).
   The existing draft addresses the state where the app is current but its
   paired server remains pending without an actionable control. Complete its
   authenticated packaged-app acceptance; the prior attempt stopped at isolated
   credential setup. The normal update should remain one coordinated operation,
   with a visible retry or cancel path after failure.
2. Fix [Claude duplicate history after interrupted updates (#166)](https://github.com/ZhengyiLuo/AgentsDock/issues/166).
   This was reproduced with real background work and a queued follow-up.
   Reconcile provider message identity and turn provenance; do not hide
   legitimate repeated messages using global text deduplication.
3. Investigate [installer lock handoff (#168)](https://github.com/ZhengyiLuo/AgentsDock/issues/168)
   in the real isolated updater. Its release race is reproduced, but the
   user-visible update impact is not established. Resolve or record the
   observed impact before deciding its stable disposition.
4. Decide the supported external-peer upgrade path before freezing scope.
   [External mailbox support (#172)](https://github.com/ZhengyiLuo/AgentsDock/pull/172)
   remains draft with failing checks and incomplete live delivery acceptance.
   Do not silently lose existing supported Duet routes during an upgrade, or
   describe that unaccepted draft as part of the stable feature set.

## Test the actual candidate

Use isolated installations and the exact signed candidate through the app's
production transport. Preserve the observations and package identity in the
release record; do not count historical beta receipts as new candidate results.

| Journey | Required visible result |
| --- | --- |
| Stable 1.0.11 and beta.6 to the candidate | One coordinated app/server update, retained connections, chats and settings; a failed server update leaves a usable retry/cancel path and cannot be mistaken for a completed bundle. Exercise the pending-server repair button. |
| Update while work exists | Install when idle leaves work alone. Explicit interruption recovers the intended work and queued follow-up without duplicate visible history. Cover Claude background completion, history refresh and reopening the app, plus Codex goal/child state. |
| Fresh npm and daily app use | Install/start the published-format npm packages in isolated state; connect and send. Exercise workspaces, pins, file opening, Linux images, goal/queue controls and mailbox delivery with the matching app/server candidate. |

Repeat failures with their specific regression cases. Carry forward platform
packaging, signature, native update and rollback checks from
[Direct releases](DIRECT_RELEASES.md) and [npm releases](NPM_CLI_RELEASES.md).
Document untested boundaries plainly; a green source build is not proof that
an installed app upgraded successfully.

## Freeze and distribution

After the selected fixes and real-use checks pass, pin one source commit,
matching server descriptor and immutable artifact checksums. Record the
accepted build and remaining limitations in `DEV_LOG.md`, then prepare concise
user-facing release notes. Publication is a separate explicit action; preserve
the canonical and legacy update feeds and existing signing identities.
