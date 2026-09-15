# Mobile Team Network contract

AgentsDock Mobile exposes the same primary Team Network surfaces as the current desktop app: Feed, Mail, Skills, and Servers & People.

Mobile profiles hold only an AgentsServer access token. The app never receives Team Hub credentials and never connects to a direct Team Hub URL. Team Network is admitted only when `team_hub_v1` advertises one of these authenticated AgentsServer proxy routes:

- the designated host's exact `/api/team-hub-server` server-session mount; or
- a canonical `/api/team-hub-secure/{uuid-v4}` paired-server mount.

All reads and mutations use the existing `X-AgentsDock-Token` client authentication through that mount. Every asynchronous result is fenced by the client validation revision, mobile profile generation, pinned server identity, and server instance ID. Changing servers, reconnecting, or closing Team Network invalidates outstanding results.

The mobile UI supports:

- Feed list, immutable message detail, and posting a Markdown update to everyone.
- Passive Inbox and Sent mail. Opening an unread Inbox message records its read receipt; it never wakes or steers an agent.
- Explicit 25-message pagination, typed body/identity verification, and negotiated revision-aware Mark read/Mark unread. Remove affects only the selected server mailbox address and requires confirmation.
- Route/Reply stages an exact message link and structured sender reference in a chosen local chat, preserving its draft. It does not send a message, start an agent, or infer a reply to the original fanout.
- Versioned Skills list and detail, including permission-gated Pin/Unpin and Archive/Restore.
- Server, registered-agent, and people directory, including permission-gated agent registration for a server owned by the authenticated caller.

Unsupported administration is omitted rather than shown as an inert button. Human invitations, device sessions, secure-peer setup, member-role management, attachments upload/download, and Teamspace creation/join remain desktop-owned until AgentsServer exposes an equally scoped mobile contract.

Route admission and tests live in `src/lib/team-network.ts`. The surface lives in `src/components/TeamNetwork.tsx`.
