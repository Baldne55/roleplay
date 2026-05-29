# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-05-29

### Added

- In-game chat overlay. A custom Vue chat panel pinned to the top-left
  corner of the screen renders any line the server pushes, with a
  token-formatted hex-colour wire (`!{#RRGGBB}...!{#FFFFFF}`) parsed
  client-side into coloured segments. Press T to open the input bar;
  Enter submits, Tab applies the highlighted slash-autocomplete
  suggestion, Esc cancels, PageUp / PageDown scroll the scrollback
  while typing. The overlay stays mounted from the auth shell onward so
  server narration (welcome line, notice block, /help replies) is
  visible before the player has selected a character, but the input
  bar and T key are gated on a spawned character; chat is read-only
  during auth and selection. The overlay suppresses itself during the
  character Details and Creator views so the wizard chrome is not
  competing with chat for attention.

- Slash command registry and dispatcher. A central, server-side command
  registry holds every chat command with its aliases, category, staff
  level gate, character requirement, optional cooldown, and run handler.
  The dispatcher is forge-proof (source is taken from the FXServer
  connection, never from the payload), translates each typed outcome
  (Ok / UnknownCommand / PermissionDenied / NotOnDuty / RequiresCharacter /
  OnCooldown / BadArgs / HandlerError) into a chat line via the formatter,
  and evicts cooldown / rate-limit keys on disconnect.

- /help command. The first registered command iterates the registry
  and renders a category-grouped block (Chat, RP, Comms, Utility, Admin)
  wrapped in the emerald-bracketed header / footer framing used by the
  rest of the chat info dumps. The full command snapshot is also pushed
  to the client on spawn so the input-bar autocomplete suggestions are
  populated from the moment the player can type.

- /changecharacter command. From in-world, /changecharacter (aliases:
  /changechar, /switchcharacter, /switchchar) returns the player to the
  character selector without disconnecting. The current character's
  position, heading, world, HP, armour, mask state, cash, bank balance,
  injury status, and bleeding status are persisted; the runtime cache
  and validator entry are detached; the routing bucket flips back to
  the per-player auth bucket so the player vanishes from the world;
  the chat scrollback is wiped; and the SPA navigates to
  /Character/Select with the character list re-fetched from the server.

- /logout command. /logout (alias: /signout) performs the same teardown
  as /changecharacter and then releases the account-session claim and
  rewinds the phase to pre-auth. The auth panorama camera re-mounts,
  the Enter Server button is re-enabled, and the connection stays
  alive — clicking Enter Server re-claims the session and lands the
  player back at the selector without a reconnect.

- Connection welcome line. The first line a joining player sees in
  chat is "Welcome to Legacy.mp - Roleplay, <Discord display name>"
  with the .mp accented in emerald and the line wrapped in (( )) as
  out-of-character narration.

- Per-connection notice block. Immediately after the welcome line the
  chat surfaces a fixed disclaimer: the server is non-monetised, not
  affiliated with Rockstar Games or Take-Two Interactive or any of
  their parent companies, subsidiaries, or rights holders; players
  must be of legal adult age in their country of residence; roleplay
  may depict violence, injury, and other content unsuitable for
  minors; continued play constitutes acceptance of all server rules.
  The block is wrapped in the same emerald-bracketed header / footer
  framing as /help.

- Spawn welcome card. The first line a freshly spawned character sees
  is a "Welcome Back" card listing their character first and last name
  with the linked Discord display name in parentheses, their numeric
  player ID, and conditionally their staff rank (when not None) and
  active premium tier with expiry suffix. The chat scrollback is
  cleared before the card lands so the panel is uncluttered.

- Account settings persistence. A new `settings` JSON column on the
  accounts table holds free-form per-account preferences, currently
  Theme Mode (Light / Dark / System); the schema is forward-compatible
  so future preferences slot in without further migrations. The SPA
  writes through to the server on every change; the server validates
  with a strict Zod schema (unknown keys rejected) and echoes the
  resolved snapshot back so the client store always mirrors persisted
  state. A localStorage cache survives across reloads as a first-paint
  fallback so the theme picker is never blank for the millisecond
  between AuthCompleted and store hydration.

- Cancel character creation. Players who already own at least one
  character can cancel out of the Details view or the Creator view
  back to the selector without committing the new character. The
  Cancel control is hidden for accounts with zero characters, where
  the only path forward is to finish the wizard.

- Custom loading screen. The previously blank loadscreen now carries
  a centred brand logo, a darkened background panel, and an emerald
  progress bar pinned to the bottom centre. The bar tracks the engine
  load fraction and the label tracks the current init / map / data-file
  phase. The "Loading game (NN%)" busy spinner FXServer paints in the
  bottom-right corner is suppressed via the documented replicated
  convar `setr sv_showBusySpinnerOnLoadingScreen false` so the bottom-
  centre bar is the only progress UI on screen.

- Configurable log level. server.cfg now carries a replicated
  `log_level` convar (debug / info / warn / error) read by both the
  Backend and Frontend Logger at module init. The development default
  is info; setting the convar to warn for production silences the
  per-connect / per-spawn / per-handler chatter without losing the
  lifecycle and failure lines.

### Changed

- Log line format. Every log line now opens with a `DD-MM-YYYY -
  HH:MM:SS` timestamp, an uppercased level tag, and the source scope —
  for example, `29-05-2026 - 15:30:42 [INFO] [Bootstrap] Backend
  ready.`. The previous ISO `T` / `Z` / millisecond suffix is gone.

- Logger verbosity. Per-source / per-event / handler-registration
  lines (state-phase transitions, routing-bucket assignments, account
  and character runtime attach / detach, controller handler
  registration, HTTP route mounts, queue events, Frontend service
  lifecycles) are demoted to Debug. Info now only fires for genuine
  lifecycle events: boot completion, account creation, character
  creation, the auth gate holding a pending account, the create-
  rejected warning, and a refused settings update.

- Theme picker hydration. The Auth view's theme picker reads from the
  new per-account settings store rather than its own short-lived
  Theme store. The chosen mode now survives logout / reconnect via
  the server snapshot rather than relying on the local browser cache.

### Fixed

- Loading-screen progress bar tracking. The earlier
  `addEventListener('loadProgress', ...)` listener never fired because
  FXServer dispatches loadscreen telemetry via `window.postMessage`,
  not as a named CustomEvent. The bar was effectively pinned at 0%
  and the engine's bottom-right fallback kept painting real progress
  on top of it. The page now listens via
  `window.addEventListener('message', ...)` and reads
  `event.data.eventName` to dispatch, so the bar tracks the actual
  load fraction.

- Loading-screen black-screen regression. A short-lived attempt to
  use `loadscreen_manual_shutdown 'yes'` so the loadscreen would wait
  for the auth shell to be live before dismissing stranded players on
  a black screen whenever the auth path took longer than the engine's
  own game load. The flag has been removed; FXServer auto-dismisses
  when the engine reports the game has loaded, and the Frontend's own
  `ShutdownLoadingScreen` / `ShutdownLoadingScreenNui` calls in
  `PrepareAuthShell` become harmless no-ops at that point.

### Notes

- This release is additive over 0.1.0 — the Discord-gated auth, the
  character creator wizard, the selector, the spawn pipeline, the
  anti-teleport position validator, and the disconnect persistence
  pathway from that release are unchanged in surface area and
  behaviour. In-world systems (movement commands, IC chat channels,
  inventory, vehicles, economy, injury and death) still land in
  subsequent releases.
