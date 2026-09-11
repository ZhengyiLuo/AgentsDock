# Electron Design System

This reference describes AgentsDock's Electron design system and the
2026-09-09 presentation updates. The system standardizes interface typography,
control shapes, and interaction feedback using the app's existing components.
The light theme uses cool zinc/white neutral surfaces instead of warm gray-yellow
backgrounds. Sent messages retain their original soft green, Send is near-black,
and blue accents and semantic status colors retain their original values.
Icons, layout structure, component architecture, and the dark palette remain
unchanged.

## Working rules

- Define shared values once in `src/renderer/src/styles.css`. Components consume
  tokens; they do not create their own theme palettes.
- Background cleanup must not recolor sent messages, the Send control, or
  semantic action/status colors. Keep those roles independent of neutral surfaces.
- Prefer semantic color tokens (`--surface`, `--text`, `--muted`, `--border`,
  `--accent`, and status roles) over a color named for its appearance.
- Put dark and light values on the same semantic token. A feature should not
  need a parallel block of light-theme overrides for ordinary surfaces and
  controls.
- Reuse the nearest scale token before adding a value. If a genuinely new role
  is needed, add and document a token rather than scattering a literal.
- Keep chat content, CodeMirror, terminal text, and syntax colors as specialized
  systems. They may opt out where using the UI scale would change their purpose.
- Keep existing widths, heights, padding, gaps, and responsive breakpoints.
  Larger interface text may wrap or truncate sooner; verify dense and narrow
  views before changing their geometry.
- Use the named text roles below for interface text. Do not choose an arbitrary
  size or weight per feature, or use bold to make every label compete for attention.

## Observed baseline

The 2026-09-07 audit covered all five first-party renderer style sheets (5,837
lines). These were the dominant literal values before token migration:

| Area | Most common values |
| --- | --- |
| Font size | 10px (194), 9px (150), 11px (145), 12px (51), 13px (23), 14px (12) |
| Font weight | 650 (49), 700 (24), 600 (16), 500 (11) |
| Radius | 7px (82), 6px (70), 8px (50), 5px (41), 9px and 10px (26 each) |
| Atomic spacing | 8px (233), 7px (215), 10px (187), 5px (180), 9px (157), 6px (152), 12px (125) |
| Shared control height | 28px icons, 30px buttons and menu items, 34px fields |
| Shadow geometry | 8px/24px, 12px/30px, and 18px/48px elevation families |

These counts describe the old baseline, not the current distribution. The
visual pass addresses its concentration of 9–11px text and 650–700 weights.
Existing spacing remains unchanged. Technical text and user-configurable chat
content remain specialized rather than being mechanically enlarged.

## Foundation tokens

### Light palette

The light palette separates neutral surfaces from action, message, and status
colors. Background refinements do not change those semantic color roles.

| Role | Value |
| --- | --- |
| Canvas / content / terminal | `#ffffff` |
| Sidebar / inputs / secondary surfaces | `#f4f4f5` |
| Selected rows | `#e4e4e7` |
| Sent-message background / border | `#e8f5ec` / `#a6d7b6` |
| Queued outgoing message background / border | `#edf6f1` / `#bdd4c8` |
| Sidebar hover / menus | `#fafafa` |
| Border / soft separator | `#e4e4e7` / `#ececf1` |
| Primary text | `#1a1a1e` |
| Supporting / quieter text | `#52525b` / `#71717a` |
| Send background / icon | `#1a1a1e` / `#ffffff` |
| Action / link / focus accent | `#0878e8` (original blue) |
| Success / danger status | `#18854f` / `#c73531` |
| Destructive action / label | `#c8413d` / `#b52d29` |

Supporting text deliberately uses the darker zinc step on gray surfaces for
readability. Send uses the near-black text token, a slightly lighter neutral
hover, and the existing zinc disabled state; it does not use the global accent.
The shared green surface/border tokens style sent messages in both themes, with
no gray light-theme override. Menu hover remains black at 6%, with pressed state
at 12%. Shadows use neutral black instead of brown-gray. These are changes to
existing CSS tokens and feature overrides, not a new theme layer.

Warnings, errors, network/provider identity, diff signals, syntax colors, and
terminal ANSI colors remain meaningful colored exceptions. Text selection and
the terminal cursor retain their original blue cues. Explicit editor
presets are unchanged: “Match app” currently resolves to the existing GitHub
Light preset in light mode, whose content canvas is already white/cool gray.

### Typography

| Token | Value | Intended role |
| --- | --- | --- |
| `--font-ui` | `system-ui`, Apple/Segoe UI fallbacks | Native system font; no downloaded font |
| `--font-mono` | system monospace stack | Paths, commands, and technical metadata |
| `--text-size-caption` | 11px | Tiny counts and status badges only |
| `--text-size-meta` | 12px | Supporting text, hints, timestamps, compact context controls |
| `--text-size-label` | 13px | Dense tree labels, tabs, compact toolbar controls |
| `--text-size-ui` | 14px | Main controls, menu items, navigation, primary labels |
| `--text-size-title` | 16px | Compact panel and section titles |
| `--text-size-heading` | 20px | Page and dialog headings |
| `--text-weight-body` | 400 | Body copy, ordinary controls and navigation |
| `--text-weight-label` | 500 | Group labels and restrained emphasis |
| `--text-weight-title` | 500 | Titles; hierarchy primarily comes from size |
| `--text-weight-emphasis` | 600 | Important status and prose emphasis |

Legacy `--font-size-*` and `--font-weight-*` names remain aliases for existing
consumers. Size aliases `xs/sm/md/lg/xl/2xl/3xl/display` resolve to
`11/12/13/14/14/14/16/20px`; weight aliases
`regular/medium/semibold/strong/bold` resolve to `400/500/600/500/600`.
Use the role names for new interface styles.

The chat font preference (14px default), composer text/mirror metrics, code,
terminal output, and CodeMirror typography retain their own settings. Markdown
strong emphasis remains 600 even though ordinary interface `strong` text is 500.

Line-height roles are `--line-height-tight` (1.35), `--line-height-ui` (1.4),
`--line-height-body` (1.45), and `--line-height-relaxed` (1.5).

### Spacing and shape

| Token | Value |
| --- | --- |
| `--space-1` through `--space-8` | 2px, 4px, 6px, 8px, 10px, 12px, 16px, 24px |
| `--radius-compact` | 6px |
| `--radius-icon` | 6px |
| `--radius-control` | 8px |
| `--radius-selection` | 8px |
| `--radius-popover` | 8px |
| `--radius-dialog` | 12px |
| `--radius-dialog-large` | 16px |
| `--radius-circle` | 50% |
| `--radius-pill` | 999px |

Radius names describe a role rather than a size. This keeps callers stable if a
later product decision changes the shape of all dialogs or all selections.

### Controls and elevation

| Token | Value | Intended role |
| --- | --- | --- |
| `--control-height-sm` | 28px | Icon buttons and compact controls |
| `--control-height-md` | 30px | Buttons and menu items |
| `--control-height-lg` | 34px | Fields and prominent controls |
| `--shadow-tooltip` | 0 8px 24px | Tooltips and small floating surfaces |
| `--shadow-popover` | 0 16px 40px | Menus and popovers |
| `--shadow-dialog` | 0 25px 80px | Standard form dialogs |
| `--shadow-dialog-large` | 0 28px 90px | Large settings and workspace dialogs |

Shadow color belongs to the token so elevation remains appropriate in both
themes. Focus rings and inset borders are state treatments, not extra elevation
levels. The generic and large dialog roles are intentional size variants, not
competing recipes: standard form dialogs use `--radius-dialog` and
`--shadow-dialog`, while large settings or workspace dialogs use the `-large`
pair. Control heights and shadow recipes are unchanged by the visual pass.

### Interaction states

| Token | Value | Intended role |
| --- | --- | --- |
| `--interaction-hover` | Text color at 7% in dark; black at 6% in light | Quiet icon and menu highlights |
| `--interaction-pressed` | Text color at 12% in dark; black at 12% in light | Pressed feedback |
| `--motion-control` | 120ms ease | Short color/opacity transitions and menu entry |

Menu hover, Radix keyboard highlight, and submenu-open states share a neutral
inset fill. Destructive labels remain red; schedule metadata retains its accent.
Neither becomes an entirely colored row. Disabled items cannot acquire the
interactive highlight. Selected checkmarks and existing segmented-control fills
remain distinct from pointer hover. Preserve visible keyboard focus on buttons
and fields. Motion respects reduced-motion preferences; controls do not resize
or bounce on hover.

## Existing component styles

This pass stays within `.icon-button`, `.quiet-button`, `.primary-button`,
`.menu-item`, `.menu-content`, and existing feature style sheets. It introduces
no new component layer, theme engine, or dependencies. Feature selectors retain
their existing arrangement while consuming the same typography and shape roles.
The remaining literal technical text and feature-specific status surfaces are
intentional exceptions or later audit work, not a second theme to expand.

## Guard and verification

`src/renderer/src/DesignSystem.test.ts` scans every renderer CSS file. It keeps
the foundation token names present and rejects `var(--name)` references that
have no CSS declaration. The exceptions are the three workspace sizing
properties injected by `WorkspaceEditor.tsx` and the menu transform origin
supplied by Radix at runtime; runtime state is not a design token.

`LightThemeStyles.test.ts` also guards cool-neutral backgrounds, original
semantic colors, green sent messages, and near-black Send. It checks normal-text
contrast for supporting copy, sent-message text, and the Send icon. Terminal tests
verify that theme changes update its neutral canvas without changing ANSI hues.

Run the focused contract from `electron/`:

```bash
pnpm exec vitest run src/renderer/src/DesignSystem.test.ts
```

Before handing off an Electron UI change, also run:

```bash
pnpm test
pnpm typecheck
pnpm build
```

When adding a token, define its default value, define a light-theme value when
the role is theme-dependent, add it to this reference and the contract test,
then migrate consumers according to the approved visual scope. For a
visual change, also inspect both themes, narrow windows, hover, keyboard focus,
disabled items, and selected states in an isolated local renderer.
