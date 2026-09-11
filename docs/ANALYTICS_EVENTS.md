# Electron usage analytics

This catalog documents every product-usage event emitted by the Electron app. Events measure whether a feature was used; they must not describe the user's content or identity.

## Privacy contract

Every event has the same small app-owned envelope:

- a random per-install identifier used for aggregate unique-install and retention counts;
- a coarse platform value: `mac`, `windows`, `linux`, or `desktop`;
- the event time; and
- the Mixpanel project token used to route the event.

Only `connection_tested`, `server_added`, `server_switched`, and the legacy `chats_bulk_imported` event include an event-specific `success` boolean. The runtime sanitizer discards every other property.

Never add message or prompt text, chat/job/agent/folder names, skill or command names, file names or contents, paths or working directories, URLs or access tokens, session/chat/job/route IDs, schedule expressions, exact run times, or destination metadata. The client posts directly with IP collection disabled, omits credentials and referrer data, and does not use SDK autocapture or session replay.

## Active event catalog

### App, chats, and messages

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `app_launched` | The Electron renderer mounts. | None |
| `chat_created` | A quick-create or new-chat request succeeds. | None |
| `chat_opened` | A session becomes newly visible in a chat pane. This can result from navigation or restoration, not only a mouse click. | None |
| `chat_resumed` | A single external provider session is successfully resumed, including resume by session ID. Selecting an already-imported AgentsDock chat does not count. | None |
| `chats_bulk_imported` | At least one chat succeeds through the multi-select import workflow. A single-session Resume action no longer emits this event. | `success: true` |
| `message_sent` | A composer message is accepted or queued successfully. | None |
| `slash_skill_used` | An accepted message uses a provider inventory item classified as a skill. | None |
| `slash_command_used` | An accepted message uses a provider inventory item classified as a non-skill command. | None |
| `chat_reference_sent` | An accepted message contains one or more structured `@Chat` route references. This measures use of the reference, not whether the agent later performs a handoff. | None |
| `team_reference_sent` | An accepted message contains one or more structured Team Network (`@@`) references. | None |

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
| `chat_moved_to_folder` | A server-confirmed chat update changes its organizational folder. This covers the header picker, sidebar menu, and drag-and-drop. | None |
| `working_directory_changed` | A server-confirmed chat update changes its working directory. | None |

### Tools and discovery

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `terminal_opened` | The terminal is explicitly opened. | None |
| `file_view_opened` | A supported file or media preview is opened from a tracked surface. | None |
| `digest_opened` | The digest dialog opens. | None |
| `search_opened` | The chat-search dialog opens. | None |
| `open_file_clicked` | The workspace editor's Open File button is clicked. Keyboard-only opens are not currently included. | None |

### Server connections

| Event | Emitted when | Event-specific properties |
| --- | --- | --- |
| `connection_tested` | A server connection test finishes. | `success` |
| `server_added` | Adding a server profile finishes. | `success` |
| `server_switched` | Explicitly switching to a server from Settings finishes. | `success` |

## Cleanup notes

- All 14 pre-existing event names still had live feature callsites; none were removed as dead code.
- `chats_bulk_imported` had also been emitted by one-chat Resume. That mixed meaning is removed: single-session flows now emit `chat_resumed`, while the multi-select workflow keeps the historical bulk event.
- `message_sent` remains the overall talk metric. The new companion events separate anonymous aggregate use of provider slash skills/commands and structured agent references without recording their contents or destinations.
- `job_schedule_opened` remains for historical continuity, while successful create, update, delete, and queued-run cancellation now have distinct events.

## Known follow-up

An earlier Settings cleanup removed the analytics opt-out control, while the privacy page still says it is available in Settings. The stored opt-out decision is still honored by the analytics runtime, but the UI and published explanation should be reconciled in a separate product decision.
