# Electron usage analytics

This catalog documents every product-usage event emitted by the Electron app. Events measure whether a feature was used; they must not describe the user's content or identity.

## Privacy contract

Every event has the same small app-owned envelope:

- a random per-install identifier used for aggregate unique-install and retention counts;
- a coarse platform value: `mac`, `windows`, `linux`, or `desktop`;
- the event time; and
- the Mixpanel project token used to route the event.

Some operations include an event-specific `success` boolean, as listed below. The runtime sanitizer discards every other property. A successful request is not proof that an agent completed its work or that an update finished installing. Network failures mean the client could not confirm the result, not necessarily that the server made no change.

Never add message or prompt text, chat/job/agent/folder names, skill or command names, file names or contents, paths or working directories, URLs or access tokens, session/chat/job/route IDs, schedule expressions, exact run times, or destination metadata. The client posts directly with IP collection disabled, omits credentials and referrer data, and does not use SDK autocapture or session replay.

## Active event catalog

### App, chats, and messages

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `app_launched` | The Electron renderer mounts. | None |
| `chat_created` | A quick-create or new-chat request succeeds. | None |
| `chat_opened` | A session becomes newly visible in a chat pane. This can result from navigation or restoration, not only a mouse click. | None |
| `split_view_opened` | The chat layout transitions from one visible chat to two distinct visible chats. Replacing a chat in an already-open split does not count. | None |
| `chat_forked` | Creating a fork of an existing chat succeeds. | None |
| `chat_share_opened` | The sharing dialog opens for a valid chat in the active server workspace. | None |
| `chat_share_snapshot_created` | Creating a view-only chat snapshot succeeds. Clipboard or browser-opening failures after creation do not change this outcome. | None |
| `chat_share_interactive_created` | Creating an interactive shared-chat session succeeds. Clipboard or browser-opening failures after creation do not change this outcome. | None |
| `chat_share_revoked` | Revoking an existing snapshot or interactive share succeeds. | None |
| `chat_resumed` | A single external provider session is successfully resumed, including resume by session ID. Selecting an already-imported AgentsDock chat does not count. | None |
| `chats_bulk_imported` | At least one chat succeeds through the multi-select import workflow. A single-session Resume action no longer emits this event. | `success: true` |
| `message_sent` | A composer message is accepted or queued successfully. | None |
| `message_queued` | The server accepts a submitted message into its queue, including a message subsequently steered. Companion to, not a replacement for, `message_sent`. | None |
| `message_steered` | A direct steering submission is accepted or a newly queued submission is successfully promoted by the send-now path. A refused/cancelled promotion does not count. | None |
| `slash_skill_used` | An accepted message uses a provider inventory item classified as a skill. | None |
| `slash_command_used` | An accepted message uses a provider inventory item classified as a non-skill command. | None |
| `builtin_slash_command_used` | A built-in slash-menu action is selected. Measures selection, not successful completion. No command name is sent. | None |
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
| `provider_connection_tested` | An explicit custom API connection check settles. Passive discovery is excluded. | `success` |
| `provider_connection_saved` | Saving custom API credentials/configuration settles. Only the success flag is sent, never the provider URL, key, account or model. | `success` |
| `provider_connection_forgotten` | A confirmed Forget endpoint operation settles. | `success` |
| `provider_default_model_saved` | Saving a custom API default model settles. The selected model is not sent. | `success` |
| `goal_saved` | A user-requested Codex or Claude goal create/update request settles. This is not goal completion. | `success` |
| `goal_cleared` | A user-requested goal-clear request settles. | `success` |
| `goal_paused` | A user-requested native Codex goal-pause request settles. | `success` |
| `goal_resumed` | A user-requested native Codex goal-resume request settles. | `success` |

### Workspace and attachments

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `workspace_file_saved` | An editor write settles, including a new document, ordinary save, or confirmed overwrite. No filename, contents or path is sent. | `success` |
| `workspace_changes_opened` | The Git Changes panel becomes active. Refreshes and file selection do not count. | None |
| `workspace_git_staged` | A user-requested stage operation settles, once per action rather than per file. | `success` |
| `workspace_git_unstaged` | A user-requested unstage operation settles. | `success` |
| `workspace_git_committed` | A reviewed commit request settles. The commit message and repository metadata are not sent. | `success` |
| `workspace_git_conflict_resolved` | A conflict-resolution write settles. | `success` |
| `workspace_git_continued` | Continuing an existing merge/rebase settles. | `success` |
| `workspace_git_aborted` | Aborting an existing merge/rebase after confirmation settles. | `success` |
| `attachment_uploaded` | One explicit upload batch settles. Success requires all selected files to be returned; partial/unconfirmed batches are false. No file metadata is sent. | `success` |

### Updates

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `app_update_checked` | A user-requested desktop update check settles. Passive startup/status checks are excluded. | `success` |
| `app_update_channel_changed` | A user's Stable/Beta selection request settles, including its automatic check. No channel/version is sent. | `success` |
| `app_update_install_requested` | The user requests Restart to update. Counted before the renderer quits; not installation success. | None |
| `app_update_cancelled` | A user-requested download cancellation or discard settles. | `success` |
| `server_update_checked` | An explicit server check or channel-selection check settles. Passive reconciliation is excluded. | `success` |
| `server_update_requested` | The user requests a supported managed server update, including deferred admission. Not installation success. | None |
| `server_update_now_requested` | The user confirms Update now and the identity/reservation checks allow the restart request. | None |
| `server_update_cancelled` | A user's explicit queued-update cancellation request settles. | `success` |
| `server_update_retry_requested` | The user requests retry for a coordinated server update. | None |

Shared-chat browser views and iOS/iPadOS intentionally send no analytics. This desktop addition does not enable them, add Team Network events, or infer agent-to-agent delivery/read/reply from reference submission. No background snapshots, replayed history, streamed tokens, or typing are counted by the new events.

### Server connections

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `connection_tested` | A server connection test finishes. | `success` |
| `server_added` | Adding a server profile finishes. | `success` |
| `server_switched` | Explicitly switching to a server from Settings or the sidebar finishes. Automatic and superseded switches do not count. | `success` |

## Cleanup notes

- All 14 pre-existing event names still had live feature callsites; none were removed as dead code.
- `chats_bulk_imported` had also been emitted by one-chat Resume. That mixed meaning is removed: single-session flows now emit `chat_resumed`, while the multi-select workflow keeps the historical bulk event.
- `message_sent` remains the overall talk metric. The new companion events separate anonymous aggregate use of provider slash skills/commands and structured agent references without recording their contents or destinations.
- `job_schedule_opened` remains for historical continuity, while successful create, update, delete, and queued-run cancellation now have distinct events.

## User control

Settings does not expose a usage analytics switch; it was removed on purpose and must not be reintroduced (Dialogs.test.tsx guards this). A previously stored opt-out from an older build is still honored: it aborts pending requests, deletes the anonymous per-install identifier, and prevents subsequent events.
