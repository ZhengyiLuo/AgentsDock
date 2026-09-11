# Secure peer transport V1

Secure peer transport lets one AgentsServer join an existing, authoritative
Team Hub by entering the host's literal IP address. It is a server-to-server
transport. It does not send an AgentsServer administrator token, Team Hub
session token, or message body to an unauthenticated remote endpoint.

This protocol provides TLS 1.3 encryption in transit, a pinned host identity,
mutual certificate authentication after approval, durable revocation, and a
bounded relay for cross-server handoffs. The authoritative Team Hub decrypts
and stores Teamspace messages, so this protocol is deliberately **not**
described as end-to-end encryption.

## Roles and trust

- The **host** is the AgentsServer that owns the authoritative Team Hub.
- A **peer** is another AgentsServer requesting a secure connection.
- Every outgoing peer connection gets its own Ed25519 client key. Its private
  key is an owner-only regular file, never leaves that server, and is not
  reused as a global node identity. Renewal may rotate that connection's key.
- The host has a stable Ed25519 certificate authority and TLS server identity.
  The host CA fingerprint, not its IP address, is its cryptographic identity.
- An IP address is only a route. It is never treated as identity or proof that
  the route belongs to a LAN, Tailnet, or particular operator.
- The host operator remains inside the Team Hub trust boundary. TLS protects
  traffic between servers; it does not hide content from the host.

Existing `direct_ip` routes are legacy plaintext routes. They are never
silently converted, selected as a fallback, or treated as proof of a secure
peer relationship.

## Pairing

1. The host explicitly enables the secure listener and chooses an advertised
   canonical literal IPv4 address. The default TLS port is 7851.
2. A peer enters `IP[:port]`. Its local AgentsServer connects without sending
   any existing administrator or Team Hub credential and reads the host's
   public protocol health and CA fingerprint.
3. The peer creates a short-lived signed request containing a UUID, its stable
   server identity, display name, Ed25519 public key and CSR, requested scopes,
   creation time, and fresh nonce. The signature binds the exact host CA
   fingerprint observed on the connection.
4. The host records the request durably and returns a short-lived polling
   capability, host identity, Hub ID, host CA certificate and fingerprint,
   transcript hash, peer-key fingerprint, expiry, and six-word short
   authentication string (SAS). There is no host nonce; freshness comes from
   the signed peer nonce and the request's bounded creation/expiry window.
   Only a hash of the polling capability is stored in the pairing record.
5. Both Teamspace UIs show the same transcript-bound SAS and full
   fingerprints. The host owner or administrator compares the SAS through a
   separate trusted channel, selects a team and narrow scopes, and explicitly
   approves or rejects the request. Approval without that comparison is TOFU
   and does not rule out an active man-in-the-middle.
6. Approval signs the peer's CSR. The certificate binds the peer server
   identity, team, scopes, request, transcript, and key. The peer verifies the
   complete response against the pinned host CA before storing it.
7. All later traffic uses TLS 1.3, the pinned host CA, and a client certificate.
   The host checks the presented certificate against live revocation state on
   every request. Client certificates rotate before expiry; revocation applies
   immediately to the current and overlapping renewal certificates.

Pairing requests expire after ten minutes, are one-use, are rate-limited by
source address and globally, and are idempotent only for the exact same UUID
and canonical request body. Reusing a UUID with different bytes is rejected.
Polling, approval, rejection, renewal, activation, and revocation are likewise
idempotent only for an exact request body.

## Local desktop boundary

The renderer never contacts the entered IP. It asks the authenticated active
AgentsServer to create or manage a pairing. The local server performs all TLS,
pinning, certificate, and private-key operations.

After approval, the peer advertises a local control-origin proxy path:

`/api/team-hub-secure/<connection-uuid>`

The Electron main process sends the AgentsServer control credential only to
that same active control origin. The local control token authenticates only the
request to the local proxy and is removed before forwarding; the remote Hub
authority comes solely from the pinned mTLS peer certificate and its live
peer/team/scopes record. The proxy removes the outer
control credential, and forwards an allowlisted Team Hub request over mTLS.
Before binding or using that local secure route, Electron verifies the remote
Hub health, Hub ID, host identity, connection ID, active profile, server
identity, and profile generation. A profile or route change aborts the
operation. There is no plaintext fallback.

The secure gateway never proxies local bootstrap, owner/device recovery,
AgentsServer administration, raw filesystem, update, restart, or unbounded URL
paths. Hop-by-hop, cookie, origin, forwarding, local-proof, and core
administrator headers are rejected or stripped.

Joining a server enrolls a node/service principal; it does not create a human
membership and the secure proxy never transports a human Hub bearer. Human
membership remains a separate invitation/session relationship.

## Cross-server handoffs

Cross-server delivery is an explicit, durable relay layered on the approved
peer connection. Passive Teamspace messages never execute an agent.

- Only an explicitly shared destination and an approved cross-chat scope may
  receive a handoff.
- Envelopes bind an immutable UUID, idempotency key and body digest, source and
  target server identities, destination, kind, exchange, parent leg, expiry,
  and delivery receipt.
- Inbox delivery uses a claim lease and exactly-once durable receipt. A crash
  may cause a redelivery, but never a second committed target turn.
- `instruction` is one-way. `request_reply` uses the existing bounded exchange
  rule: at most six directed legs (three round trips), expiring after 72 hours.
  Six is a ceiling, not a quota. Either agent may finish earlier. Requesting
  another response requires room for both the request and its answer.
- Every target turn treats relayed text as untrusted user content. The relay
  grants no authority over the source server, its files, credentials, tools,
  transcript, or any unlisted chat.
- Cross-chat scopes and an exact published route are nevertheless an explicit
  delegation to start the destination chat's normal agent turn. That turn uses
  the destination chat's saved provider context and may invoke whatever tools
  and permissions its owner configured there. For that reason cross-chat
  scopes are off by default, approval is explicit, and each destination/action
  is separately published and revocable. Passive Teamspace messages never
  receive this execution authority.
- Remote routes are user-created, revision-bound grants. Pairing alone never
  exposes every chat and never grants permission to address arbitrary session
  IDs.

## Persistence and operations

Secure-peer keys, certificates, requests, connections, relays, receipts, and
audit events live in a separate owner-private state directory and database.
They are not part of a release directory and survive a normal signed update.
The listener and connector stop before process shutdown and recover durable
state on startup. In-flight network calls are safe to retry only when their
idempotency contract says so.

An update or restart must not rewrite peer identity, silently activate another
connection, clear revocation, or replace the selected Hub. Rollback to a server
without secure-peer support leaves the owner-private state untouched and fails
the route closed.

Reachability remains an operational requirement. A LAN, public, or Tailscale
IP works only when the host port is reachable. Public NAT-to-NAT connectivity
without an inbound route requires a separate rendezvous/relay service and is
not implied by this protocol.
