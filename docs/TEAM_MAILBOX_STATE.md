# Desktop server Inbox read/unread

Local-only implementation. Current published app/server builds do not gain
this feature until an explicitly authorized release includes the new server
contract and Hub migration 0019.

The connected Hub must advertise the optional `team_mailbox_state_v1`
capability. The desktop then requests the owned server Inbox's private attention
projection. Right-click a read ordinary-mail row to choose **Mark as unread**;
the existing **Mark as read** action and opening unread mail use the same
versioned mutation. Older Hubs keep their original Mark as read behavior and
do not expose Mark as unread. Sent, Bulletin, skills, and human mailboxes are
not expanded by this change.

Unread attention is separate from historical recipient receipts. Marking a
message unread retains its original read timestamp and sender-visible Read
receipt. The server rejects stale versioned writes, deleted/dismissed messages,
and mutations for a mailbox the caller does not own. An uncertain retry retains
the same payload and idempotency key; a conflict asks for explicit refresh.
Newer local attention versions survive stale list/detail responses. Scope
generation changes fence late mutation results.

The successful action updates only the mounted Mail list and its existing
snapshot/unread callback. It does not emit a global refresh, fetch the Inbox,
start a timer or subscription, or introduce a notification transport. Existing
explicit refresh remains available. Human Reply drafts and exact parent links
are documented in `TEAM_MAIL_REPLIES.md`.

Focused tests cover parser strictness, capability negotiation/downgrade,
bridge delegation, exact service response matching, row actions, stable retry
keys, receipt preservation, fresh detail versions, stale refresh responses,
scope fences, and older-host fallback. No packaged GUI or deployment acceptance
is claimed.
