# Postmortem: zen-nv Soft Lockup During Isaac Rendering

Date: 2026-05-17

## Summary

`zen-nv` became unresponsive and later rebooted. The evidence points to a host/kernel-level soft lockup caused by Python/Isaac rendering work, not a ZenithDock scheduled-job loop or a memory OOM.

The clearest culprit was a ZenithDock-driven CMA-ES chat run rendering Isaac grids with `render_saved_rollout.py`. The run left render subprocesses that did not exit even after `SIGKILL`. Kernel logs show CPU 11 stuck for 700-900 seconds in a Python process inside `unlink()` / ext4 inode eviction.

## Impact

- ZenithDock server stopped being usable from clients.
- Fresh SSH sessions hung, and an existing SSH session eventually died.
- The machine had to come back from a hard reboot/power cycle.

## Timeline

All times below are Pacific time unless otherwise noted.

- 2026-05-16 23:55:18: CMA-ES chat `sess_7c68618110564ebd` started `run_d1a67871c96c4494`, launching:
  - `stdbuf -oL -eL python3 render_multispec6144_depth_3x3_grids_051626.py`
- 2026-05-17 00:05:18: The run reported the second grid was rendering cleanly.
- 2026-05-17 00:07:23: The run reported the current Isaac render was taking longer than earlier tiles.
- 2026-05-17 00:10:58: Process inspection showed stuck render children:
  - PID `1597587`: `render_saved_rollout.py` for `episode_000049/can_0/front`
  - PID `1680471`: `render_saved_rollout.py` for `episode_000049/coffee_cup_10/front`
- 2026-05-17 00:11:11: The agent reported `can_0` hanging inside the Isaac render process with no log output and low GPU use.
- 2026-05-17 00:11:15: The agent sent `kill 1597587 1486882`.
- 2026-05-17 00:15:57: The agent sent `kill -9 1597587`.
- 2026-05-17 00:17:42 through 00:21:22: Kernel repeatedly logged:
  - `watchdog: BUG: soft lockup - CPU#11 stuck ... [python:1489616]`
  - call trace included `do_unlinkat`, `ext4_evict_inode`, and `truncate_inode_pages_range`
- 2026-05-17 00:18:08: The agent reported stuck Isaac child processes were not exiting even under `SIGKILL`.
- 2026-05-17 00:19:48: Kernel logged blocked `systemd` and MOTD tasks.
- 2026-05-17 00:21:48: Previous boot stopped logging.
- 2026-05-17 14:43:28: Current boot started.

## Evidence

Current host state after reboot:

- Uptime was about 1 minute when checked.
- Memory was healthy: roughly 122 GiB available.
- Disk was not full: `/` about 56%, `/hdd` about 52%.
- Agent server was listening on `0.0.0.0:7850`.

Kernel evidence from previous boot:

- No OOM-killer evidence found in the checked logs.
- Repeated soft lockups on CPU 11.
- The stuck process was `python`.
- The kernel stack was in filesystem unlink/inode eviction, not user-space Python compute.

ZenithDock event evidence:

- The active failing run was `sess_7c68618110564ebd`, title `CMA-ES`, backend `codex`, cwd `/hdd/zen/dev/nv/gr00t`.
- The run launched real Isaac rendering, specifically `render_multispec6144_depth_3x3_grids_051626.py`.
- Its children were `render_saved_rollout.py` commands writing under:
  - `/home/zen/fit_render_artifacts/multispec6144_depth_3x3_grids_20260517/raw/...`
- The stuck children remained in `R` state after `kill -9`.
- One inspected stuck child had `Cpus_allowed_list: 11`, matching the kernel's CPU 11 soft lockup.

Scheduled-job evidence:

- Scheduled jobs were enabled, but the jobs near the incident were status checks, not the direct renderer.
- `A3 Training` job ran at 2026-05-16 23:04, 23:05, and 23:43.
- The CMA-ES "check status and submit more processing jobs" job was created at 2026-05-16 23:26, but the observed crash path was the manual/active render run.
- Conclusion: scheduled jobs may be a general risk, but they were not the primary cause of this incident.

## Root Cause

Most likely root cause:

An IsaacLab `render_saved_rollout.py` child process wedged in the kernel while unlinking/evicting files on ext4. Because the process was stuck in a kernel path, `SIGKILL` could not remove it. The lockup then degraded the host enough that system services and SSH became unreliable.

This was not an ordinary Python CPU loop and not a memory OOM.

## Contributing Factors

- Rendering spawned heavyweight Isaac subprocesses from inside an agent turn.
- Render subprocesses used existing output/cache directories and performed filesystem cleanup/unlink work.
- There was no server-side host breadcrumb logger at the time.
- There was no global host-pressure launch guard at the time.
- The running server still used the older event append implementation, where each event append scanned large `events.jsonl` files.
- The CMA-ES event log had grown to about 48 MB / 15k events, making the old append path increasingly expensive.
- Public tunnel logs showed many external `/api/health` probes. This was probably not causal, but it is noisy and should be tightened.

## Follow-Up Work

Already implemented locally:

- `4eae6a4` `Harden scheduled job runner`
  - avoids full event-log scans on append
  - adds scheduled-job backpressure
- `7ed03de` `Add server crash guardrails`
  - adds host-health breadcrumbs
  - adds launch guards for manual/queued turns
  - adds `/api/diagnostics/host`

Recommended next:

- Deploy the local server hardening commits to `/home/zen/Zenithbot`.
- Temporarily pause high-risk scheduled jobs until the guarded server is live.
- Add a render-specific wrapper:
  - unique output directory per tile attempt
  - avoid deleting active/raw render directories in place
  - use external timeout and kill-after behavior
  - record PID, PGID, command, output path, and log path per render tile
  - avoid retrying a tile/object after a kernel-stuck render signature
- Consider moving risky Isaac rendering to an isolated worker or tmux/job lane instead of running directly inside the agent turn.
- Tighten public tunnel exposure for health endpoints.

