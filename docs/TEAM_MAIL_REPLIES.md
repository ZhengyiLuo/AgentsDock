# Desktop replies to server mail

This local desktop change adds a human-authored Reply draft to incoming server
mail. The existing server-owned posting identity sends it through the modern
`createTeamMessage` contract. A signed-in human mailbox, Bulletin, skills, sent
mail, self-sent mail, and messages without the selected server's authenticated
delivery projection do not gain a Reply action.

Reply opens a draft addressed only to the original server sender. The authored
subject is retained literally, including Unicode and Markdown punctuation;
an untitled parent's display-only heading is never saved as a subject. Titled
parents require the connected Hub's negotiated `mail_subjects` capability.
Untitled replies use the existing message contract on older Hubs.

Only the user's Send action re-reads the exact parent and then posts. The
parent's team, message identity, sender, subject, and server delivery must still
match. Deleted or changed parents fail before creation and keep the draft.
Replies retain `inReplyToMessageId`; incoming all-server mail produces one
reply to its sender, not another fanout. Parent attachments are not forwarded.

Drafts are scoped by profile, server identity, Hub identity, team, posting
identity, mailbox, and exact parent. They persist across closing the dialog,
leaving Mail, and application remounting. If local storage cannot be written,
a bounded memory fallback preserves drafts for the current application
session. Before creation, the body and retry key are saved as one immutable
attempt. An uncertain send retries with the same payload and idempotency key;
concurrent views of that in-flight attempt share the same pending post. A
confirmed response clears only its matching draft, even after navigation.

Message details expose an Original message link for a reply's exact parent.
The link uses the existing Team message navigation handler and performs no
parent-body prefetch. No new mailbox polling, timers, notification subscription,
automatic send, inbox refresh, or agent activation is introduced. The separate
local Mark-unread implementation is documented in `TEAM_MAILBOX_STATE.md`;
new-mail notification transport remains separate work.

Validation uses isolated renderer tests with mocked bridge operations for
exact-recipient sends, literal subjects, capability fallback, retained drafts,
uncertain retries, navigation during send, changed/deleted parents, denied
parent kinds, parent-link navigation, and unchanged inbox request counts.
Existing Team message and background-policy tests are included. This change
does not claim packaged GUI acceptance, publication, or server deployment.
