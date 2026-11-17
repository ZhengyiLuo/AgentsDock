# Desktop and shared-chat usage analytics

This catalog documents product-usage events emitted by the Electron app and the limited shared-chat browser tracker. Events measure whether a feature was used; they must not describe the user's content or identity.

## Privacy contract

Every desktop event has the same small app-owned envelope:

- a random per-install identifier used for aggregate unique-install and retention counts;
- a coarse platform value: `mac`, `windows`, `linux`, or `desktop`;
- selected provider-related events may include a fixed `backend` value: `codex`, `claude`, `cursor`, `opencode`, or `gemini` (never model names, connection names, endpoints or accounts);
- the event time;
- a random per-event `$insert_id`, reused with the original timestamp on bounded delivery retries (not a chat, run, request, or server identifier); and
- the Mixpanel project token used to route the event.

Some operations include an event-specific `success` boolean and selected events allow the fixed `backend` enum, as listed below. Only `message_sent` allows `connection_kind`: `default` or `custom_api`. Failed file-open/connection checks allow a fixed `failure_category`; file-open requests also allow `origin`. Submission outcomes and update-recovery coverage use only the fixed enums documented below. The runtime sanitizer discards all other properties and rejects unknown event names. A successful request is not proof that an agent completed its work or that an update finished installing. Network failures mean the client could not confirm the result, not necessarily that the server made no change.

`connection_kind` is a routing dimension, not a sixth Agent family. `custom_api` means an AgentsDock-managed API connection, including official-provider endpoints and Gemini API connections. `default` means the normal provider route; that CLI may independently use an API key, so this is not an OAuth/native-auth metric. Codex uses the submitting session's next-turn `codex_provider`, including a pending saved endpoint switch, exactly as the send path does; the other four Agents use `provider_connection`. Missing, unknown and legacy values are omitted, not inferred from credentials or counted as default. The snapshot is taken at submission, never from a later selected chat or the previous running turn's endpoint. Historical events without this property remain unknown; do not backfill them as default. Queued/steered events are subsets of `message_sent`, not additional messages to sum with it. Failed submissions and `/model` settings changes do not emit `message_sent`.

Never add message or prompt text, chat/job/agent/folder names, skill or command names, file names or contents, paths or working directories, URLs or access tokens, session/chat/job/route IDs, schedule expressions, exact run times, or destination metadata. The client posts directly with IP collection disabled, omits credentials and referrer data, and does not use SDK autocapture or session replay.

This allowlist describes the app-owned JSON payload, not all HTTP metadata. The
collector may retain the ordinary request User-Agent and attach receipt or
processing metadata. Version cohorts parsed from an `AgentsDock/version`
User-Agent are not an explicit app-version field, proof of a source commit or
proof that QA traffic is excluded. Missing and development-version markers must
remain separate from identifiable public-version cohorts.

## Active event catalog

### App, chats, and messages

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `app_launched` | Once per Electron renderer lifetime, including development StrictMode remounts. | None |
| `app_initialized` | Once per renderer: cached bootstrap applied, or initialization failed. Not proof of a reachable server. | `success` |
| `app_server_ready` | First identity-scoped, compatible live server Health succeeds; explicitly incomplete chat readiness does not count. Older servers without readiness metadata establish connection only. | None |
| `app_first_message_accepted` | First explicit submission with a matching server turn/queue receipt in this renderer. Not first-ever installation use. | None |
| `app_first_reply_observed` | First non-imported assistant output with final-answer or legacy absent phase, tied to a locally accepted run. Reasoning/commentary and unknown phases do not count. Queued sends must first match their exact queued id to a started run. Missing ownership, other clients' messages and history replay do not count. | None |
| `message_submission_attempted` | Locally validated submission reaches native send IPC. Invalid/empty drafts are excluded. | `backend` |
| `message_submission_settled` | That submission has a turn/queue receipt, an explicit HTTP rejection, or an unknown transport/legacy result. No automatic message resubmission. | `backend`, `outcome`: `accepted`, `rejected`, `unknown` |
| `chat_created` | A quick-create or new-chat request succeeds. | `backend` |
| `chat_opened` | A session becomes newly visible in a chat pane. This can result from navigation or restoration, not only a mouse click. | None |
| `split_view_opened` | The chat layout transitions from one visible chat to two distinct visible chats. Replacing a chat in an already-open split does not count. | None |
| `chat_forked` | Creating a fork of an existing chat succeeds. | None |
| `chat_share_opened` | The sharing dialog opens for a valid chat in the active server workspace. | None |
| `chat_share_snapshot_selected` | The user chooses View only, before creation/address validation. A failed creation still counts as a selection. Disabled/re-entrant clicks do not count. | None |
| `chat_share_interactive_selected` | The user chooses Interactive, before creation/address validation. A failed creation still counts as a selection. Disabled/re-entrant clicks do not count. | None |
| `chat_share_snapshot_created` | Creating a view-only chat snapshot succeeds. Clipboard or browser-opening failures after creation do not change this outcome. | None |
| `chat_share_interactive_created` | Creating an interactive shared-chat session succeeds. Clipboard or browser-opening failures after creation do not change this outcome. | None |
| `chat_share_revoked` | Revoking an existing snapshot or interactive share succeeds. | None |
| `chat_resumed` | A single external provider session is successfully resumed, including resume by session ID. Selecting an already-imported AgentsDock chat does not count. | `backend` |
| `chats_bulk_imported` | At least one chat succeeds through the multi-select import workflow. A single-session Resume action no longer emits this event. | `success: true` |
| `message_sent` | A composer message is accepted or queued successfully. | `backend`, `connection_kind` when explicitly known |
| `message_queued` | The server accepts a submitted message into its queue, including a message subsequently steered. Companion to, not a replacement for, `message_sent`. | `backend` |
| `message_steered` | A direct steering submission is accepted or a newly queued submission is successfully promoted by the send-now path. A refused/cancelled promotion does not count. | `backend` |
| `slash_skill_used` | An accepted message uses a provider inventory item classified as a skill. | None |
| `slash_command_used` | An accepted message uses a provider inventory item classified as a non-skill command. | None |
| `builtin_slash_command_used` | A built-in slash-menu action is selected, or a valid typed `/model` action is requested. Measures selection, not successful completion. No command name is sent. | None |
| `chat_reference_sent` | An accepted message contains one or more structured `@Chat` route references. This measures use of the reference, not whether the agent later performs a handoff. | None |
| `team_reference_sent` | An accepted message contains one or more structured Team Network (`@@`) references. | None |
| `team_network_opened` | The Team Network surface transitions from closed to open. Navigating within an already-open Team Network does not count. | None |

### Scheduled jobs

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `job_schedule_opened` | The scheduled-job editor opens for either create or edit. | None |
| `scheduled_job_created` | Creating a scheduled job succeeds. | None |
| `scheduled_job_updated` | Saving changes to a scheduled job succeeds. | None |
| `scheduled_job_deleted` | Deleting the recurring scheduled-job definition succeeds. | None |
| `scheduled_job_paused` | Pausing future runs from the scheduled-jobs menu succeeds. | None |
| `scheduled_job_resumed` | Re-enabling future runs from the scheduled-jobs menu succeeds. | None |
| `scheduled_job_run_requested` | A manual Run once request is accepted, whether it starts immediately or waits for admission. | None |
| `scheduled_job_run_cancelled` | Removing one queued scheduled-job occurrence or stopping a proven active scheduled-job run succeeds. This is separate from deleting the recurring definition. | None |

### Folders and working directory

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `folder_created` | A unique chat folder is created. | None |
| `folder_deleted` | Folder deletion and any required moves to General complete successfully. | None |
| `folder_reordered` | A drag-and-drop folder reorder is applied. | None |
| `chat_reordered` | A drag-and-drop reorder within the same chat folder succeeds. | None |
| `chat_moved_to_folder` | A server-confirmed chat update changes its organizational folder. This covers the header picker, sidebar menu, and drag-and-drop. | None |
| `working_directory_changed` | A server-confirmed chat update changes its working directory. | None |

### Tools and discovery

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `terminal_opened` | The terminal is explicitly opened. | None |
| `file_view_opened` | A supported file or media preview is opened from a tracked surface. | None |
| `digest_opened` | The digest dialog opens. | None |
| `search_opened` | The chat-search dialog opens. | None |
| `open_file_clicked` | The workspace file picker transitions to open, including its button, keyboard shortcut and other picker entry points. Historical name retained; previously this counted the button only. | None |

### Side chat, providers, and goals

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `side_chat_opened` | A side-chat popup opens for a different target or after being closed; refocusing an open popup does not count. | None |
| `side_chat_message_submitted` | One explicit side-chat submission settles. Current servers acknowledge submission before the answer; legacy servers return the answer in this request. No replay/history synchronization is counted. | `success` |
| `side_chat_stop_requested` | An explicit Stop request settles. Closing/clearing the UI and automatic cleanup do not count. | `success` |
| `provider_settings_opened` | The My Agents settings page opens. | None |
| `provider_connection_tested` | An explicit custom API connection check settles. Passive discovery is excluded. | `success`, `backend` |
| `provider_connection_saved` | Saving custom API credentials/configuration settles. Only the success flag and built-in provider family are sent, never the provider URL, key, account or model. | `success`, `backend` |
| `provider_connection_forgotten` | A confirmed Forget endpoint operation settles. | `success`, `backend` |
| `provider_default_model_saved` | Saving a custom API default model settles. The selected model is not sent. | `success`, `backend` |
| `goal_saved` | A user-requested Codex or Claude goal create/update request settles. This is not goal completion. | `success` |
| `goal_cleared` | A user-requested goal-clear request settles. | `success` |
| `goal_paused` | A user-requested native Codex goal-pause request settles. | `success` |
| `goal_resumed` | A user-requested native Codex goal-resume request settles. | `success` |

### Workspace and attachments

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `workspace_file_saved` | An editor write settles, including a new document, ordinary save, or confirmed overwrite. No filename, contents or path is sent. | `success` |
| `attachment_uploaded` | One explicit upload batch settles. Success requires all selected files to be returned; partial/unconfirmed batches are false. No file metadata is sent. | `success` |

### Updates

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `app_update_checked` | A user-requested desktop update check settles. Passive startup/status checks are excluded. | `success` |
| `app_update_channel_changed` | A user's Stable/Beta selection request settles, including its automatic check. No channel/version is sent. | `success` |
| `app_update_install_requested` | The user requests Restart to update. Counted before the renderer quits; not installation success. | None |
| `app_update_cancelled` | A user-requested download cancellation or discard settles. | `success` |
| `server_update_retry_requested` | The user requests retry for a coordinated server update. | None |
| `server_update_recovery_observed` | An exact client-owned forced-update receipt reaches a terminal coordinator observation, but the current server exposes no recovery-proof contract. This measures unsupported observability, not recovered tasks or unique server updates across clients. | `outcome: unknown`, `coverage: unsupported`, `work_kind: unknown` |

iOS/iPadOS analytics remain disabled. Team Network instrumentation is unchanged. Chat-reference submission is not proof of agent-to-agent delivery/read/reply. No background history, streamed tokens, or typing are counted.

### Server connections

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `connection_tested` | An explicit server connection test finishes, including onboarding. | `success`; fixed `failure_category` on failure |
| `server_added` | Adding a server profile finishes. | `success` |
| `server_switched` | Explicitly switching to a server from Settings or the sidebar finishes. Automatic and superseded switches do not count. | `success` |

## Desktop additions (October 2026)

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `chat_agent_changed` | Explicit new-chat Agent choice changes after server confirmation. Not inherited defaults. | `backend` |
| `chat_model_changed` | An explicit model patch is confirmed different. Not Agent resets, startup, model retirement migration or history refresh. | `backend` |
| `chat_permission_mode_changed` | An explicit permission patch changes a confirmed value; multi-field Codex changes count once. Not a tool approval or permission-profile name. | `backend` |
| `imported_chat_api_connected` | An explicit Gemini native-history API binding/import returns a confirmed result. Already-imported and unconfirmed bulk results do not count. | `backend`, `success` |
| `chat_archived` | An explicit archive patch changes the confirmed state. | None |
| `chat_unarchived` | An explicit unarchive/folder-move patch restores a previously archived chat. | None |
| `workspace_files_opened` | A user opens the Files panel via its tab or file-open action. Not startup restoration, repeated selection or history refresh. | None |
| `file_open_requested` | The native open-file/open-link request settles. Success means the native request resolved, not that the person read the file. This excludes ordinary editor/media previews. | `success`, `origin`: `artifact` or `linked_file`; failures additionally allow `failure_category` |
| `language_changed` | User selects a different language in Settings. Not Follow-system OS changes or preference replay. Does not assert persistence. | None |
| `chat_font_changed` | User changes chat size/typeface in Settings or the native menu. No value is recorded. Not restoration or a no-op. Does not assert persistence. | None |
| `error_details_copied` | User's explicit Copy error request settles. Never includes copied text. | `success` |
| `issue_report_opened` | The prefilled report URL is handed off to the browser, or that request fails. Does not mean an issue was submitted. Never includes the URL/prefilled fields. | `success` |
| `server_restart_requested` | Explicit validated restart reaches the native restart call, including a separately confirmed force retry. | None |
| `server_restart_reconnected` | That restart's bootstrap and hydration finish or fail while it still owns the connection. Superseded responses do not count. Not automatic reconnect or upgrade completion. | `success` |

The existing `chat_created`, `chat_resumed`, `message_sent`, `message_queued`,
`message_steered`, `provider_connection_tested`, `provider_connection_saved`,
`provider_connection_forgotten`, and `provider_default_model_saved` events now
also allow the fixed `backend` enum. Existing event names and counting boundaries
remain unchanged. `message_sent` includes accepted queue submissions; queue/steer
events are subsets, not additional messages to sum. Older builds lack `backend`;
missing values must not be interpreted as an unknown provider or zero adoption.
No actual model, permission mode, language, font, file, server, error or content
value is uploaded. Team Network and the hidden QR entry are unchanged.

## Retired desktop surfaces (historical names retained)

These seven Git Changes events and four legacy server-update events are not reachable through the current UI. The implementation is retained for compatibility; zero current usage is not evidence of low demand. The coordinated retry event remains active.

| Event | Historical meaning (retired surface) | Event-specific properties |
| --- | --- | --- |
| `workspace_changes_opened` | The Git Changes panel becomes active. Refreshes and file selection do not count. | None |
| `workspace_git_staged` | A user-requested stage operation settles, once per action rather than per file. | `success` |
| `workspace_git_unstaged` | A user-requested unstage operation settles. | `success` |
| `workspace_git_committed` | A reviewed commit request settles. The commit message and repository metadata are not sent. | `success` |
| `workspace_git_conflict_resolved` | A conflict-resolution write settles. | `success` |
| `workspace_git_continued` | Continuing an existing merge/rebase settles. | `success` |
| `workspace_git_aborted` | Aborting an existing merge/rebase after confirmation settles. | `success` |
| `server_update_checked` | An explicit server check or channel-selection check settles. Passive reconciliation is excluded. | `success` |
| `server_update_requested` | The user requests a supported managed server update, including deferred admission. Not installation success. | None |
| `server_update_now_requested` | The user confirms Update now and the identity/reservation checks allow the restart request. | None |
| `server_update_cancelled` | A user's explicit queued-update cancellation request settles. | `success` |

## Delivery and funnel limitations (source changes, not yet released)

Desktop delivery is memory-only, bounded to 100 pending events, eight in flight, three attempts and a 30-minute lifetime. Transient HTTP/network failures get bounded backoff; explicit payload rejection is dropped. HTTP and response body are checked, but neither proves downstream dashboard inclusion. Retry envelopes keep their timestamp and random event id. Online/pagehide recovery and fetch keepalive are best effort; quitting/crashing can still lose events. No event queue is stored on disk. Opt-out clears queued events and aborts in-flight requests. If identifier storage fails, one identifier is reused for this renderer lifetime, not regenerated per event. A later app launch can still obtain a different identifier.

Retry delays and queue age use a monotonic clock, so a wall-clock correction
does not freeze delivery or expire fresh events. Exported event timestamps still
use the original wall clock; invalid/future timestamps need their own data-quality
bucket rather than being silently moved to ingestion time.

Only failed `file_open_requested` and `connection_tested` events accept `failure_category`: `not_found`, `authentication`, `scope_changed`, `download`, `native_open`, `network`, `timeout`, `unavailable`, `unknown`. Categories are conservative local classifications, not raw errors. `native_open` means the OS could not open the downloaded file, not necessarily that its default handler is missing. Unknown/older failures must not be backfilled into a specific cause. `origin` identifies the artifact versus linked-file API, not a filename or UI element. No new environment, model, path, content, server, chat or run identifier is transmitted.

Launch milestones are once per renderer, not a new installation or a completed onboarding funnel. They cannot establish a startup crash from absence alone. Explicit message attempts/outcomes are a separate metric from historical `message_sent`; do not sum them. Missing/legacy receipts remain unknown; the first-reply metric excludes uncorrelated runs and replies delivered only to another client. Internal run/queue ownership stays in memory and is never uploaded.

Update-observation deduplication keeps at most 128 one-way receipt hashes locally. They contain no raw identifiers and are never uploaded; opt-out removes them. Clearing storage, resetting consent or exceeding that bound may allow an old observation to count again. This is neither a cross-client unique-update count nor a per-task recovery metric. A versioned server recovery-proof contract is still needed before any recovery-success outcome can be added.

## Shared-browser events

The shared page keeps generic desktop analytics disabled. A separate fixed allowlist emits only these three events; no caller-supplied properties are accepted.

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `shared_chat_snapshot_activated` | A valid read-only transcript is rendered after access is authenticated. Not the token form, HEAD requests, redirects, errors or link previews without authentication. | None |
| `shared_chat_interactive_activated` | An authenticated interactive state is accepted and applied to the page. Not the empty app shell or token redemption alone. | None |
| `shared_chat_message_sent` | The interactive prompt endpoint returns a validated acceptance receipt, including accepted queued messages. Refused or unconfirmed submissions do not count; agent completion is not implied. | None |

The browser payload contains only the event name, project token, timestamp, `platform: shared_web`, and an empty `distinct_id`. It creates no persistent visitor identifier and does not send share/session/request IDs, their hashes, URLs, access tokens, titles, message text, files or identities. Requests omit credentials and referrers and use `ip=0` to disable IP geolocation. Normal network metadata such as IP and Origin is still visible to the receiving service; this is not a promise of network anonymity. There is no SDK, autocapture or session replay.

One-way deduplication markers stay in tab-scoped sessionStorage. Reloading, pagination, reconnecting and accepted-receipt replay in the same tab do not count again. A new tab/browser can count again: activation does not prove a different person, and these unlinked events cannot form a per-user cross-device funnel. Read-only legacy token links and separate-token links have separate local markers. Browser privacy controls (DNT/GPC), an existing same-origin opt-out, or unavailable storage suppress tracking. Best-effort delivery has no retry and can undercount; after 4,096 tab markers, further events are skipped instead of evicting and recounting earlier ones.

The snapshot page allows only its exact compiled analytics script via a CSP hash and the Mixpanel connection destination. Other scripts remain blocked; unlock forms and error pages remain scriptless. Interactive pages retain their restricted bridge. Deploying source alone is not enough: the served shared-web bundle and snapshot script must be regenerated and included in the server release.

## Dashboard calculation and audit contract

The event tables above are the per-event emission specification. Every dashboard
query must retain its source revision, event allowlist, success/outcome filters,
platform and version eligibility, timezone, window boundaries, numerator and
denominator. A new event name does not become meaningful activity automatically.
Adding an event to the source is not evidence that its collecting build shipped.

### Normalize before comparing

1. Use the last 7 or 30 **complete calendar days** in the declared project
   timezone, represented as a half-open interval `[start, end)`. Compare equal
   complete windows; do not compare today's partial total with yesterday's full
   total. Retention cohorts need the full follow-up period before inclusion.
2. Keep raw-export rows and deduplicated events as separate counts. For desktop
   rows with a nonempty `$insert_id`, deduplicate by exact event name,
   `distinct_id`, original event time and `$insert_id`. Do not round timestamps
   further. Rows without that field remain separate with missing-key coverage
   reported: two legitimate clicks in one second are not necessarily duplicates.
   Conflicting properties under the same key are a data-quality error, not an
   invitation to silently choose success. Mixpanel's raw export does not perform
   report deduplication. See its [deduplication contract](https://docs.mixpanel.com/reference/event-deduplication).
3. Restrict desktop queries to the declared desktop platform values. Android,
   shared-browser and website events are separate populations; iOS currently
   emits no analytics. Empty/missing IDs may contribute event totals but must
   never create a fictitious single installation. Do not manufacture IDs.
4. Count distinct **anonymous installations**, not people, accounts or devices.
   Compute the union across the whole window, not the sum of daily uniques.
   One installation may use several Agents or versions; summing their unique
   counts overcounts the total. Storage reset or failure can change identifiers.
5. Split identifiable public versions, identifiable development/QA versions and
   missing/unrecognized User-Agent versions. Version-identifiable coverage is
   not public-release coverage. Do not backfill version/backend/connection kind
   from another event or a later profile. An identifiable release marker is not
   proof of a source commit or proof that testing traffic is absent.

### Counts and denominators for every event

For each eligible event `e`, publish `raw_rows`, `deduplicated_events`,
`nonempty_id_events`, `unique_installations`, `missing_id_events` and
`missing_dedup_key_events`. The catalog's properties determine the additional
columns; do not infer semantics from an event's name alone:

- **Boolean outcome events:** count exact boolean `success=true` and
  `success=false` separately. Missing, null and string values are unknown.
  Observed success rate is `true / (true + false)`; publish unknown coverage
  alongside it and show N/A for a zero denominator. This measures the client
  operation's documented boundary, not downstream completion. In particular,
  `side_chat_message_submitted` has a version-dependent acknowledgment boundary.
- **Success-only emission events:** count all eligible events as the documented
  confirmed action. They have no failure denominator. Missing `success` is
  intentional for events such as `chat_created`, `message_sent`, job mutations
  and share creation; filtering these to `success=true` would erase valid use.
- **Open/selection/request events:** count recorded actions only. They are not
  success or completion rates, even when their names contain `used` or
  `requested`. Preserve the specific boundaries in the catalog, including
  `builtin_slash_command_used`, `chat_opened` and `app_update_install_requested`.
- **Submission outcome events:** separate `accepted`, `rejected`, `unknown` and
  missing/invalid outcomes. Report accepted share among settled observations and
  unknown coverage. Attempts minus settled observations is **not** a proven
  failure count: requests can cross windows, the app can quit, and delivery can
  fail. No request identity is uploaded, so these totals cannot reconstruct an
  exact per-request latency or failure funnel.
- **Recovery coverage:** `server_update_recovery_observed` currently reports
  unknown/unsupported only. There is no valid recovered-task success numerator
  or per-server update denominator. Do not turn current/healthy/reconnected
  into proof of task recovery.
- **Identifier-free shared events:** publish event totals only, separately for
  each of the three names. Same-tab local dedup is not cross-tab unique-person
  counting. Do not calculate unique recipients or join to a desktop sender.

For feature reach, use the union of installations with qualifying feature
events divided by the union of installations with any reported, eligible
desktop event in the same window/cohort. Label this **reach among reporting
installations**, not adoption among all installed users. Use successful outcomes
for outcome-based features and the catalog's confirmed emissions for success-only
features; report requests/failures separately. Actual feature exposure is not
recorded, so absence alone does not establish disinterest. A custom "meaningful
activity" denominator must publish its exact current-event allowlist and outcome
rules; exclude launches, failures and retired surfaces, and never silently mix
it with the broader reporting-installation denominator.

### Derived metrics requiring special treatment

| Metric family | Correct interpretation / calculation |
| --- | --- |
| Messages and Agents | `message_sent` is composer submission volume. Queue/steer are companion subsets, not extra messages. Side-chat submissions are a separate workflow. Agent shares use only the eligible `message_sent` backend values and disclose missing coverage. Installation reach by Agent can overlap and need not sum to 100%. |
| Custom API | Among messages with a known `connection_kind`, custom share is `custom_api / (custom_api + default)`; publish missing-kind count and coverage. It is routing, not API-key vs OAuth usage. Pending Codex endpoint switches in older builds can be misclassified; do not claim an exact historical correction without evidence. |
| Files | Native open failure rate is false divided by true plus false for `file_open_requested` only. Internal previews, editor opens and saves are different boundaries. Failure category share uses failed attempts, with missing category shown separately. Repeated failed clicks are attempts, not distinct affected files or people. |
| Share | Open, mode selection, creation, activation and browser send are separate counts. An installation can choose both modes or create multiple shares per open. Do not divide raw counts and call the result a paired conversion probability. No share/token IDs are uploaded, so cross-device invite-to-activation conversion is unavailable. |
| Startup / first reply | Milestones occur once per renderer, not per installation lifetime. No renderer ID is uploaded, so ratios across windows are descriptive counts, not a joined first-install funnel or crash diagnosis. Only compare versions that actually emit the milestones. A missing reply can reflect unsupported ownership, queue waiting, interruption or lost telemetry. |
| Jobs / imports / attachments | A job mutation or Run once does not mean a completed run. Bulk import counts successful batches, not imported chats; `chat_resumed` is the single-session path. Upload counts batches, not files, bytes or provider delivery. |
| Updates / restarts | Check, channel choice, restart/install request and reconnection are distinct boundaries. Retired server-update UI events are historical only. There is currently no end-to-end installation/task-recovery success rate derivable from these events. |

### Minimum query fixtures before publishing metrics

Run these on synthetic data in the query layer, never by replaying into the
production collector:

- Two identical retry rows with the same full dedup key: raw 2, events 1. Two
  clicks in the same second with different insert IDs: events 2. Two legacy
  rows without insert IDs: retain 2 and mark missing-key coverage.
- One `message_sent`, one `message_queued`, one `message_steered` from an
  accepted queue-and-promote flow: composer volume 1, queued 1, steered 1.
- A boolean-outcome event with true, false and missing values: confirmed
  success 1, confirmed failure 1, unknown 1, observed success rate 50%, known
  outcome coverage 2/3. A success-only `chat_created` without a success field
  still contributes one creation.
- The same installation on two days or two Agents: one window installation;
  one installation in each Agent group. An empty ID never adds an installation.
- One known custom message, one known default message and one missing kind:
  known custom share 50%, known-kind coverage 2/3, not 1/3 "API adoption".
- One internal preview and one failed native open: native open failure rate
  100% of one attempt, not 50% of two file actions. This does not diagnose the
  reason or claim all previews failed.
- QA, development, missing-version and identifiable public-version events:
  four separate provenance buckets before any public-cohort filtering.
- Only `app_launched` on an older build with no milestone implementation:
  initialization/reply rates are unsupported, not 0% or proof of a crash.
- A shared-page activation with empty ID: one activation event, no inferred
  recipient installation and no cross-device join to a share creator.

For each displayed result retain the exact query revision and fixture results.
Compare independent aggregate queries with raw-export calculations on a small
fixed window, allowing for receipt delay, report deduplication and timezone
differences. Only approved non-content enums and aggregate counts belong in
an audit report; never publish installation IDs or private event payloads.

## Cleanup notes

- All 14 pre-existing event names still had live feature callsites; none were removed as dead code.
- `chats_bulk_imported` had also been emitted by one-chat Resume. That mixed meaning is removed: single-session flows now emit `chat_resumed`, while the multi-select workflow keeps the historical bulk event.
- `message_sent` remains the overall talk metric. The new companion events separate anonymous aggregate use of provider slash skills/commands and structured agent references without recording their contents or destinations.
- `job_schedule_opened` remains for historical continuity, while successful create, update, delete, and queued-run cancellation now have distinct events.

## User control

Settings does not expose a usage analytics switch; it was removed on purpose and must not be reintroduced (Dialogs.test.tsx guards this). A previously stored opt-out from an older build is still honored: it aborts pending requests, deletes the anonymous per-install identifier, and prevents subsequent events.
