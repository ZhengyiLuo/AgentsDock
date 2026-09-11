# Agent-only replies to server Mail

Reply chooses a local chat and stages a draft there. It does not open a manual
mail form, send mail, or start an agent. The draft reads
`Reply to [exact mail title](exact message link) from @@sender`; existing chat
text is preserved. The link identifies the team, message, mailbox and server.
Its structured sender reference uses the same reviewed grant path as Route.
The user sends that chat draft when ready; the chat's agent reads the mail and
uses the server's authorized exact-parent reply operation.

Reply is offered on incoming server Mail with the selected server's
authenticated delivery projection. Bulletin, skills, human-mailbox,
self-sent and unverified delivery entries do not gain a Reply action. In a
thread opened from Sent, an eligible incoming reply can still be answered.
The server independently validates the parent and recipient at send time.
Replies go only to that sender, not to the original all-server fanout.

Route and Reply share a searchable local chat list, with keyboard selection
and stable IDs distinguishing duplicate names. Filtering runs only while the
picker is open. No network search, roster refresh or per-keystroke global state
write is added. Route retains its existing `Read` draft behavior. Saved data
from the removed manual Reply form is left untouched, not silently deleted.

## On-demand thread

The optional negotiated `team_mail_threads_v1` capability enables
`GET /v1/teams/{team}/network/messages/{message}/thread` with
`after_sequence` and `limit` (maximum 25). It follows exact parent IDs, never
subjects or timestamps. Each entry must independently remain readable.
Unavailable/deleted ancestors and bounded traversal are reported as incomplete
history; private branches and Bulletin/skill entries are not traversed.

Mail detail fetches one page on open. Load more and Refresh thread are explicit
actions. It retains readable original content on fetch failure and fences late
responses by the selected profile/team/message. Incoming/outgoing rows show
the sender, original time, recipients and outgoing receipts. Older hosts keep
single-message detail and the exact Original message link; they are not probed
for the unsupported thread endpoint. Agent-only Reply still works there using
the existing explicit sender reference on the draft.

No thread timer, automatic refresh, send or receiving-agent activation exists.
Quiet recipient-scoped push hints are separate and update only the badge;
see `TEAM_MAIL_NOTIFICATIONS_PLAN.md`. Read/unread remains documented in
`TEAM_MAILBOX_STATE.md`. Neither source changes nor tests deploy a server.
