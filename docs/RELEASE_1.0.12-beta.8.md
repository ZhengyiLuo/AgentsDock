# AgentsDock 1.0.12-beta.8

Matched desktop app and server beta. Install the paired server update to receive
changes to message delivery; updating the desktop app alone does not replace
an older server's Force Send behaviour.

- Send now remembers the selected message during Stop cleanup and sends it
  automatically once cleanup finishes, without requiring another click.
- Claude follow-ups use the existing native run and preserve background work.
- Pending message acknowledgement no longer appears as a delivery failure.
- Side chat panels resize by pointer or keyboard and retain their size. Multiple
  Side chats retain separate history and drafts on supporting servers.
- Manage and remove saved server connections even while disconnected. Saving a
  connection no longer requires a successful connection test.
- Chat beside file is directly accessible from file tabs. Chat drafts and file
  edits remain intact when changing the layout.
- Blocked-goal details open from the goal status within a clearer shared goal bar.

This candidate includes the previous beta-line fixes for Codex endpoint
switching, multiple Side chats and compacted-history message rendering.

Validation status: targeted source tests and isolated native app/server UI
journeys passed. Some provider boundaries in those journeys are synthetic.
Live Claude acknowledgement latency and interruption parity remain unverified;
this release must not be described as fixing all Claude sending delays.
Packaged app, native installation and upgrade acceptance are pending preparation.
Windows distribution follows the existing unsigned-installer policy.
