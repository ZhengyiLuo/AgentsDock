# Merged feature recovery

This integration restores accepted changes to the maintained `server/` and desktop
sources in one branch. This source integration does not publish a new release.
Existing signed metadata and distribution channels are unchanged.

## Source map

| Original pull request | Recovered behavior | Integration notes |
| --- | --- | --- |
| [AgentsServer #102](https://github.com/ZhengyiLuo/AgentsServer/pull/102) | OpenCode provider, settings, skills and client support | Uses the newer accepted AgentsDock integration `6fcc7acc`; retains current side questions and update UI. |
| [AgentsServer #104](https://github.com/ZhengyiLuo/AgentsServer/pull/104) | Safe display labels for native history | Combined with native title discovery and fallback sanitization. |
| [AgentsServer #105](https://github.com/ZhengyiLuo/AgentsServer/pull/105) | Python test package | Moves all current server test modules to `server/tests/`, updates imports, shard discovery and npm workflow discovery. |
| [AgentsServer #106](https://github.com/ZhengyiLuo/AgentsServer/pull/106) | Cursor nested tool-call correlation | Original fallback and regression tests. |
| [AgentsServer #107](https://github.com/ZhengyiLuo/AgentsServer/pull/107) | Explicit user delegation in async mail | Target-bound, durable attestation; retains later stdin, wake, archived-sender and bounded-read fixes. Bodies and replies cannot mint delegation. |
| [AgentsServer #108](https://github.com/ZhengyiLuo/AgentsServer/pull/108) | Exclude archived and subagent sessions from import | Combined with the newer native-title filtering. |
| [AgentsServer #110](https://github.com/ZhengyiLuo/AgentsServer/pull/110) | Bounded parallel runtime discovery and slower Claude auth probes | Preserves custom Codex provider settings. |
| [AgentsServer #112](https://github.com/ZhengyiLuo/AgentsServer/pull/112) | Setup token/clipboard prompts, dependency checklist, Tailscale detection, named instances and removal | Preserves current activation/rollback protections; detailed server reference retained alongside short README. |
| [AgentsServer #118](https://github.com/ZhengyiLuo/AgentsServer/pull/118) + [AgentsDock #33](https://github.com/ZhengyiLuo/AgentsDock/pull/33) | Native titles, Cursor CLI history import and ownership checks | Server and desktop restored together; import rechecks ownership. |
| [AgentsServer #120](https://github.com/ZhengyiLuo/AgentsServer/pull/120) | Actionable low-memory errors | Restores the accepted explanation; does not change admission thresholds. |

Existing Claude history deduplication (AgentsServer #103), the current update
layout (AgentsDock #39, incorporating #38), and the intentional analytics UI
removal remain in place. Unmerged PRs are outside this recovery.

## Lifecycle compatibility

Named instances retain their individually named legacy service units and update
through the signed legacy activation path. The default installation retains the
current split gateway/execution lifecycle. Explicit split installation for a
named instance is rejected before service mutation because gateway names are
currently default-scoped. This avoids taking over another instance's service.

No release metadata is copied backward from historical branches. Recovery commits
are grouped by feature so reviewers can inspect each source integration without
reverting later accepted work.

## Validation and acceptance

Automated validation and the completed lightweight local acceptance are recorded
in the pull request. The following checklist also guides deeper release acceptance:

- Fresh interactive installation: URL/token output, opt-in clipboard, missing
  dependency prompts, and already installed Tailscale detection.
- Upgrade and rollback of an existing default split installation; history,
  authentication and service identity remain intact.
- Two named instances: independent credentials, ports, state, update and removal;
  the default installation remains available.
- Native Claude/Codex/Cursor import: human titles, archived/subagent exclusion,
  ownership recheck and same-provider resume through the desktop.
- OpenCode real-provider acceptance with model selection, tools and cancellation.
- Cross-chat explicit delegation, ordinary peer mail, replies and permission
  boundaries through the actual desktop/provider tool.
- App update/channel UI and current native side-question behavior.

Lightweight checks exercised real Claude, Codex, Cursor and OpenCode replies,
Cursor import/resume, Cursor/OpenCode tools, provider side questions and isolated
HTTP instances. This does not constitute full graphical or release-upgrade
acceptance. OpenCode currently resets native context after Stop, and atomic
workspace rename remains limited on filesystems without hard-link support.
Published npm releases are unchanged.

Integration with the latest main also retains synchronized side conversations,
provider goal controls, upgraded Codex CLI detection and Python installation
fixes. New server tests follow the recovered `server/tests/` package layout;
installation, deployment and archive manifests include both sets of modules.
