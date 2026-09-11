# Electron localization

## Source of truth

Each language has one flat JSON catalog of semantic keys to strings:

- [en.json](../electron/src/shared/locales/en.json): English source and fallback.
- [zh-CN.json](../electron/src/shared/locales/zh-CN.json): approved Simplified Chinese wording.
- [locales/index.ts](../electron/src/shared/locales/index.ts): registry exporting `catalogs`, `defaultLocale`, `localeOptions`, and `Locale`.

Edit the catalogs to change wording. Do not maintain a second mapping in documentation, paired-language modules, or inline bilingual component strings. Existing keys remain stable even when wording changes; use separate keys when the same English word has different meanings.

## Using translations

[shared/i18n.ts](../electron/src/shared/i18n.ts) provides `t(key, params?, localeOverride?)`, locale resolution, and subscriptions. Renderer components import `t` and `useLocale` from [renderer/src/lib/i18n.tsx](../electron/src/renderer/src/lib/i18n.tsx):

```tsx
function GeneralHeading() {
  useLocale()
  return <h2>{t('settings.general')}</h2>
}
```

Call `t` once for each label; it selects the active catalog. Native menus use the shared translator too. An explicit locale override is for scoped exceptions, not a global locale change.

Use named placeholders such as `{count}`, `{name}`, and `{detail}`, with exactly the same names in every catalog. Pass values through `t(key, { count, name })`; never interpolate by translating user values or concatenating English plural suffixes. Catalog entries should contain complete phrases or sentences. Interpolated values remain literal, including dollar signs, paths, IDs, and diagnostic detail.

## Adding a locale

1. Create `<locale>.json` beside the existing catalogs, with the same semantic keys and placeholder names as `en.json`.
2. Import it and add one entry to `languages` in `locales/index.ts`, with its catalog, native label, and system-locale matcher. The `Locale` type, catalog lookup, valid preferences, and selector options derive from that registration; do not edit UI components.
3. Add tests for the new entry's `matchesSystemLocale` rule. Do not claim support for a script or regional variant that the catalog does not cover. Keep `defaultLocale` English unless a product decision changes it.
4. Run catalog-integrity, locale-resolution, settings, native-menu, and live-switch tests, then typecheck and build locally.

The Settings → General → Language selector uses the registered options. English is the default without a saved choice; following the system is an explicit preference. Unsupported system languages fall back to English. Simplified Chinese must not silently stand in for Traditional Chinese.

## Approved terminology

These constraints guide catalog edits; the catalogs contain the complete mapping.

| Context | Chinese UI wording |
|---|---|
| Conversational Chat / Conversation / Session / Thread | 会话, never 聊天 |
| Resume/import chat; import action | 导入会话; 导入 |
| ID import; local-history import | 通过会话 ID 导入; 从本机导入会话 |
| Backend selector | Agent |
| Server / Servers | 服务端 |
| Frequent phrases; Queue message; Plan mode | 常用回复; 加入消息队列; Plan 模式 |
| OS language/theme matching; system font | 和系统一致; 系统字体 |
| Workspace editor Match app | 和app一致 |
| Timeline System role | 系统 |

Latest screenshot-review labels are exact:

| English/context | Approved wording |
|---|---|
| Pin / Pinned / Unpin | 置顶 / 已置顶 / 取消置顶 |
| Pin chat / Unpin chat | 置顶会话 / 取消置顶会话 |
| Review / Code review | 查看 / 代码查看 |
| Explorer / File explorer | 源文件 |
| Refresh Explorer / Refresh file explorer | 刷新源文件 |
| Resize file explorer | 调整源文件面板大小 |
| Pinned-panel empty-state instruction | 从该会话中置顶重要消息或者文件 |
| Per-chat System Prompt placeholder (Inspector and new-session dialog) | 只适用该会话的通用指令 |

Keep **Agent/Agents**, **Subagent/Subagents**, **Prompt**, **Reasoning**, **Persistent goal/goals**, and **Persistent Codex goal/goals** in English, including within Chinese sentences. Use spaces around these English terms where they adjoin Chinese prose. Product/provider/model names, commands, standards, paths, IDs, user titles/messages/drafts, raw tool output, and arbitrary server/provider errors are not translation targets.

The entire **Team Network** feature remains English: Teamspace, Team Hub, Team Messages, Bulletin, Mail Board, Team Skills, secure pairing, and all related controls, errors, and accessibility text. This takes precedence over general terminology, including Pin/Pinned and 会话. Shared Markdown controls use the existing English-UI override when rendered inside Team UI; normal Markdown controls still follow the selected language.

Apply terminology contextually: fixed versions/counts, durable queues, persistent tmux sessions, approval reviewer roles, and existing 检查 wording retain their separate meanings. Do not globally replace English or Chinese substrings.

## Live-switch safety

- Subscribe with `useLocale()` wherever rendered labels depend on language, including memoized components.
- Include locale in memo dependencies only when caching translated display text; do not add it to data identity, connection scopes, or unrelated callbacks.
- Never force a remount, change component keys, navigate, reconnect, or restart the app to apply a language choice.
- Preserve drafts, user content, scroll, selections, undo history, terminals, and active operations. CodeMirror phrases update in place.
- Preference persistence uses the native language bridge with a renderer cache; keep startup, event synchronization, rapid changes, and save-failure handling intact.

## Validation and runtime boundaries

Tests cover catalog key/placeholder integrity, protected terminology, preference fallback/persistence, renderer and native labels, Team exceptions, and state preservation. Relevant suites include `shared/i18n.test.ts`, `renderer/src/lib/i18n.test.tsx`, `LanguageSettings.test.tsx`, `Localization.integration.test.tsx`, `MarkdownContent.localization.test.tsx`, `CodeMirrorEditor.test.tsx`, and `main/language.test.ts`.

From `electron/`, run `pnpm typecheck`, `pnpm exec vitest run --maxWorkers=4`, `node --test ../scripts/tests/verify_electron_compile_output.test.mjs`, and `pnpm build`. This guide does not record fresh test results; report results from the actual change being validated.

Initial implementation used isolated automated checks. The user later authorized a live desktop launch for local review; that does not authorize automatic reloads or restarts for subsequent edits. Stop after local validation unless the current request explicitly authorizes further runtime or release actions.
