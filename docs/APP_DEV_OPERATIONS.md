# App development operational manual

Every feature must work for a person using the app, not just in a component
test. The implementer owns hands-on verification before claiming it is ready.
This applies to desktop, shared web views and changes requiring AgentsServer.

## 1. Establish the exact target

- Identify the source repo, working tree, app version/build, connected server
  version and machine available for testing. Preserve concurrent work.
- Reproduce the reported problem through the actual UI before changing it.
  Inspect the screenshot and underlying response, not just the displayed error.
- Write a short user journey: starting state, actions and expected visible
  result. State whether the correction belongs to app, server, or both.
- Use the user's designated test machine. Do not drive their working desktop,
  switch their chats, replace their running app, or restart research jobs as an
  incidental test. Use an isolated profile and disposable chats by default.
- Keep builds, caches and evidence on the designated development volume. Reuse
  the existing output directory rather than creating permanent build trees.

## 2. Implement the smallest complete workflow

- Follow the existing transport, authentication, component and state patterns.
  An existing UI pattern does not establish that its backend contract works.
- Trace UI action → IPC → actual transport → server authorization → provider
  or persistence → returned result → rendered state. Check each changed boundary.
- Keep request ownership tied to the selected server and chat. Late responses
  must not populate another chat or mutate a newly selected server.
- Never weaken authentication to compensate for a malformed desktop request.
- Do not add polling, retry loops or global store writes as a shortcut. No
  network request, full-history projection or forced layout per keystroke.
- Keep internal instructions, authority, cron wakes and provider lifecycle
  records out of user-authored bubbles. Preserve genuine content and ordering.

## 3. Personally exercise it

Use computer interaction with the actual built app, not just a DOM snapshot or
direct invocation of its handler. Click the entry point, type, submit, inspect
the result, and use it again. Use disposable test accounts/data and authorized
test services; do not involve real teammates without permission.

For each changed workflow, cover the applicable cases below. Do not turn a
small fix into an unrelated full-stack audit.

| Check | Required observation |
| --- | --- |
| Normal use | A first-time user can find and complete the action; the promised result actually exists. |
| Second use | A follow-up/repeated action works; it does not duplicate content or retain stale state. |
| Busy and idle | Existing work is not accidentally interrupted; queue/goal behavior matches the intended contract. |
| Cancel and failure | Cancel affects only its request; errors are truthful and leave a usable retry path. |
| Navigation | Switching chat/server, closing/reopening, and reconnecting cannot leak or misattribute replies. |
| Presentation | Check light/dark, narrow width, keyboard focus, scrolling and supported localization where affected. |
| Responsiveness | Type continuously and scroll chat list/timeline while the feature is open and idle; inspect requests and long tasks if work bursts appear. |

Client/server features require an actual request from the app's production
transport into server authorization, not a mocked success response. Verify the
server-side result as well as the optimistic UI. Inspect actual wire headers,
method, status and error body without recording credentials or private content.
For provider features, also complete a real provider request on a disposable
chat before marking provider integration accepted.

A native offscreen Electron run can verify rendering, interaction and real
transports safely. Label it as offscreen. A stubbed provider or server tests
only the boundaries it actually runs; it is not a successful live-provider test.
If computer access or a required service is unavailable, report that exact gap
and leave acceptance pending. Do not silently substitute mocks and say tested.

## 4. Focus checks on the failure

- Add the smallest regression that fails before the fix and passes afterward.
  When the bug crosses a boundary, the regression must cross that boundary too.
- Run the affected tests, TypeScript checks and production compilation. For
  release packaging, also follow the existing release validation requirements.
- Reuse focused fixtures/harnesses. Passing thousands of unrelated tests does
  not replace the user journey, and a large test count is not a readiness claim.
- Recheck the packaged candidate after packaging when shipping it. Record the
  exact version/build and source commit, not just the source checkout tested.

### Side-chat authorization example

A side-chat screen rendered correctly, but its client used generic `fetch`.
That added `Sec-Fetch-Mode`; the server's native-only guard rejected it with 403.
Mocked HTTP responses and a server test with mocked authorization missed this.

The relevant acceptance is: open Side chat, send a question, receive an answer,
send a contextual follow-up and cancel a pending side answer. Check the real
native POST/DELETE headers and server guard, and verify that the main task keeps
running. Keep the guard intact. A screenshot of the panel alone cannot pass it.

## 5. High-risk workflows: select the affected row

| Changed area | Real-use checks |
| --- | --- |
| Cross-chat/mail | Send A → B; verify exactly one receipt, inbox item and rendered message; read/reply B → A; test busy/idle wake and cancellation without pausing goals. |
| Timeline/cron/goals | Run a scheduled turn and reopen history; steer an active goal; inspect progress/final ordering and ensure no internal prompt becomes a user bubble. |
| Team Network | Join/approve from a second isolated client, send and read mail, edit/delete owned bulletin content, and verify offline recovery without idle polling. |
| Sharing | Open the real URL in a separate browser session; exercise token access/revoke, media and the actual read-only/interactive restrictions. |
| Updates | Validate installed-version → candidate update, failed/offline behavior, retained settings and active-work safety; do not infer install success from download success. |
| Storage | Simulate write failure in an isolated fixture/volume; preserve existing data and show a recoverable error. Never fill the user's disk deliberately. |

## 6. Handoff and release honestly

Change/build/test authorization is not publication, installation or server
restart authorization. Follow [DIRECT_RELEASES.md](DIRECT_RELEASES.md) when a
release is explicitly requested. Do not release over a failed acceptance check.

Record a compact verification note in the development log:

```text
Change and expected user behavior:
Source commit / app build / server version:
Test surface: actual installed app | isolated native app | component fixture
Actions exercised and observed outcomes:
Real boundaries exercised; any mocked/stubbed boundaries:
Focused regression / typecheck / production build:
Remaining limitations or blocked acceptance:
Availability: source only | local package | installed | published | deployed
```

Keep public notes free of credentials, private conversations and machine
inventories. Store detailed private evidence locally. Give the user the full
absolute path when handing over a local app; explicitly say whether a server
update is required. Never confuse built, installed, published and deployed.
