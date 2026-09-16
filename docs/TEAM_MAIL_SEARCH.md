# Mail and Bulletin search

Implementation for the next coordinated desktop/server update; not present in
the already published desktop 1.0.1 artifacts.

Mail (Inbox and Sent) and Bulletin have a search field. Type words and press
Enter or Search; Clear search returns to the ordinary list. Input stays in the
small search component until submission. There is no debounce request, timer,
subscription, background refresh, or per-character store write.

Search covers the entire accessible Team Messages history, not just loaded
cards. It matches word prefixes in the current subject and body, or the current
sender name. All words must match the content or all must match the sender.
For example, `roll rev` can match “rollout review”. Case and accents are ignored;
query text never becomes SQL or FTS operators. Attachment contents, obsolete
revision bodies, internal provenance, and legacy Bulletin posts are excluded.
The UI explicitly identifies excluded legacy posts when they are present.

## Contract and compatibility

- Existing message-list IPC accepts optional `q`, up to 200 Unicode characters.
  Empty desktop input omits `q`; it never downgrades a failed search to an
  unfiltered request.
- The host advertises sibling `team_message_search_v1` with version 1, fields
  `subject`, `body`, `sender`, and `max_query_chars: 200`. Main maps the verified
  capability to the desktop's optional `TeamMessagesCapability.search`.
- Indexed search requires standalone Hub migration 0023 and matching HTTP and
  secure-peer forwarding. Both the Team Network host and the member's connected
  server must support it. Older hosts keep ordinary Mail/Bulletin and explain
  the update requirement; there is no incomplete loaded-page substitute.
- Each explicit search or Load more reads one bounded page. Changing the query,
  mailbox, owned address, team, profile or connection invalidates its cursor and
  fences late responses. The ordinary list's existing bounded catch-up behavior
  is unchanged.

## Attention and state safety

Search results never replace ordinary mailbox/feed snapshots, update aggregate
unread counts, request mailbox coverage, or acknowledge Mail/Bulletin arrival
hints. A filtered result does not prove that all messages were seen. Opening a
result still uses the existing exact-message read action; routing, editing and
deletion retain their normal authorization.

Errors are shown as errors, not “no matches”. Clearing search cannot reuse an
old prefetched Bulletin page. A sender rename immediately changes the host's
indexed sender projection without copying the new name to every historical
message. Editing a Bulletin item while searching explicitly refreshes that
query so a nonmatching edited item is not left among the results.

The server indexes current content transactionally. Existing history is indexed
once during the normal atomic migration, which needs disk space proportional
to that content and holds the migration write transaction until complete.
Normal upgrade backup/rollback requirements still apply. No live migration,
deployment, installer replacement or publication is implied by this change.
