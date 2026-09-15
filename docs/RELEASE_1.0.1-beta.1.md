# AgentsServer 1.0.1-beta.1

## Fix Team Mail from joined servers

Fix valid `@@` mail sends from a joined server failing with “Team Network mail
is unavailable.” The receiving host's secure-peer gateway rejected the
recipient inbox-identity field used by durable chat-scoped mail routes before
the message could be stored. This affected approved members too; rejoining or
changing their permissions was not a solution.

The gateway now preserves that field for the existing transactional checks.
Revoked or replaced recipients, malformed identities and unknown fields remain
rejected. Stable-key retries still return the original mail receipt rather
than creating duplicate messages.

## Updating

- Update the **receiving Team Network host** to this beta to apply this fix.
  No desktop update or member re-enrollment is required for this correction.
- Previously rejected mail was not delivered and is not resent automatically.
  After the host updates, the sender can submit it again.
- No API-version, database-schema, dependency or signing-key change. No new
  polling or background inbox refresh has been added.
- Join approvals remain separate: the reusable server invite link still
  requires the host to approve each joining server's request.

## Validation and scope

Focused regression checks cover a freshly approved member's exact `@@`
resolution, durable grant admission and first send to another member through
private-socketpair mTLS, threaded replies, idempotent retries and recipient
revocation/rejoin during a send. These use isolated data, not live user mail.

This is a narrowly scoped beta after **1.0.0**. Other in-progress desktop,
cron-history and subagent-display changes are not included. The stable release
channel remains on 1.0.0.
