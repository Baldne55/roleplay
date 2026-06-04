# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-05-30

### Added

- IC speech commands. /say is the normal-volume channel (10 m) and is
  also the default for any plain text typed into the chat input
  without a leading slash. /shout (aliases: /s) carries 25 m for
  louder lines, /low (aliases: /l) tightens to 5 m for quiet
  exchanges, and /whisper (aliases: /w) tightens further to 3 m for
  one-on-one speech inside a crowd. /say and /shout render entirely
  in white - volume reads from the verb word and the broadcast range,
  no colour tint required. /low and /whisper tint the ENTIRE line
  (name, verb, and body together) so the muted register reads at a
  glance: /low in light gray, /whisper in pale orange. Receivers must
  be in the same routing bucket as the sender so players in different
  worlds never hear each other regardless of geometric distance.

- /b local OOC (alias: /ooc). Wraps the body in `(( Name: body ))`
  and broadcasts to nearby players (15 m). Renders in OOC grey so
  the line is visually distinct from IC speech and IC actions, and
  is parsed by other players as out-of-character commentary.

- /blow local OOC at low-voice range (5 m). Same `(( Name: body ))`
  wrap and grey palette as /b, but tightens to the Low bracket so
  out-of-character asides during intimate scenes do not leak to
  onlookers. Paired with /low (IC) and /b (OOC normal) it
  completes the close-range chat surface.

- /to (alias: /sayto), /shoutto (alias: /sto), /wto directed
  speech. The sender addresses a specific player by ID. Bystanders
  in range see `<Sender> <verb> to <Target>: <body>`; the target
  sees `-> <Sender> <verb> to you: <body>` with the `-> ` prefix
  in a bright pink-magenta so the cue lands visibly at the bottom
  of their scrollback. The broadcaster excludes the target from the
  bystander pass so the target only sees the marker-prefixed copy,
  not both versions. The marker colour is the only deliberate
  exception to the otherwise whole-line single-colour rule for
  communication channels: it has to read as "someone addressed me"
  at a glance, distinct from every other channel tint. Founders
  on admin duty can /to themselves (and /shoutto / /wto themselves)
  to probe both the bystander and target views in one chat panel
  for format verification - same exception class as the Founder
  self-PM bypass.

- /ame and /amy nametag actions. Both set a roleplay action that
  will display above the player's nametag once the overlay ships.
  /ame renders as `* Name <action>`, /amy as `* Name's <action>`.
  The server writes the formatted string to a replicated
  `Roleplay:NametagAction` state bag and auto-clears it after five
  seconds; the SPA overlay reads that key when it arrives. Until
  then a chat acknowledgement confirms the action set.

- /me / /do / /my roleplay actions in three range variants each
  (nine commands total). /me <action> renders as `* Name <action>`,
  /do <description> as `* <description> (( Name )) *`, /my
  <description> as `* Name's <description>`. The base variants
  carry the standard 10 m radius; the /melow, /dolow, /mylow
  variants narrow to 5 m for close-quarters detail; the /melong,
  /dolong, /mylong variants extend to 25 m for wide-area beats.
  All nine render in RP purple so action lines are visually
  separated from spoken lines.

- /pm <player_id> <message> private messaging (alias: /dm),
  with /reply <message> (alias: /rm) as a one-step round-trip back
  to whoever last PMed you. Both ends see the line wrapped in
  `(( PM to <Name>: body ))` / `(( PM from <Name>: body ))`
  rendered entirely in Highlight yellow (names and body alike).
  Names are mask-aware, so a masked sender or recipient appears as
  `Stranger <MaskID>` not their legal name; Source IDs are
  deliberately not echoed in the rendered line so pairing a numeric
  ID with a Stranger label across encounters cannot leak the
  wearer's identity. Self-PM is rejected by default; the single
  exception is the Founder rank on admin duty, who can /pm
  themselves to probe the rendered format live without needing a
  second client. Both the PM-to and PM-from lines land on the same
  connection in that case so the full two-sided format renders in
  one chat panel.

- /blockpm and /unblockpm. /blockpm silently drops incoming PMs
  from a specific player; the blocked sender continues to see
  their own PM-to acknowledgement so they cannot tell the message
  was dropped (matches ragemp / lc-rp norms - the block reads as
  "I got ignored" rather than the confrontational "you have been
  blocked"). /unblockpm reverses it. Blocks are keyed by account,
  so they survive the blocker's reconnect and correctly identify
  the blocked target even if the target's player ID changes
  between sessions.

- /o global out-of-character broadcast. Currently gated on the
  Founder staff rank on admin duty until a broader staff-channel
  system ships. Reuses the local OOC grey palette for now; the
  global channel will earn its own colour and bracket convention
  when the broader system lands.

- /cb and /cw vehicle chat. Both filter by shared FXServer vehicle
  handle (server-side natives), gracefully decline outside a vehicle,
  and broadcast only to fellow passengers. /cb reuses the /b grey
  OOC wrap; /cw reuses the /whisper pale-orange full-line tint.

- /aduty and /admins. /aduty toggles the issuing player's admin-duty
  flag (gated on staff rank Helper or above; bypasses the duty check
  itself so a staff member can turn it on). /admins lists every
  spawned staff member currently on duty inside the emerald-bracketed
  header / footer frame, resolving names through the mask-aware
  display chokepoint so a masked admin still hides their identity.

- /dice (alias: /rolldice) and /coin (alias: /flipcoin). /dice rolls
  a six-sided die (1-6) and broadcasts a /me-style RP-purple action
  line at the standard 10 m Say range. /coin flips a fair coin and
  announces Heads or Tails the same way. Both resolve the actor
  through the mask-aware display chokepoint.

- /id <name or id> player lookup. A numeric argument first attempts
  an exact Source-ID match against any spawned player and surfaces
  the resolved name; if no Source matches, the numeric argument
  falls through to a substring search so `/id 4421` against a
  masked player still matches their `Mask 4421` display label.
  Text arguments do a case-insensitive substring match across every
  spawned player's display name. Multi-hit results render inside
  the emerald-bracketed header / footer frame, capped at ten
  entries with an overflow hint when more match.

- ProximityBroadcaster service. The single chokepoint every IC chat
  command routes through. It owns the live native-coord read per
  submission, the routing-bucket equality check, the Spawned-phase
  gate on receivers, and the mask-aware name resolution. Every
  display name in chat (speech, action, OOC, PM, lookup) flows
  through one method here, so the anti-metagame mask rule is
  enforced in exactly one place.

- /clearchat. Wipes the issuing player's local chat scrollback
  without affecting anyone else. The server emits a clear event
  through the existing ChatService; no other player sees anything
  change. Useful before screenshots, between scenes, or after a
  noisy /help dump.

- /toggle <setting> sub-command dispatcher. One command for the
  chat / nametag UI knobs. Settings: timestamp (display message
  timestamps), chat (overlay visibility), charactercounter (alias:
  counter - the input-bar character count), selfnametag (alias:
  selftag - your own nametag), nametagid (alias: tagid - the
  player ID inside nametags), blindfold (solid black background
  behind chat for screenshots). The chat-side toggles (timestamp,
  chat, charactercounter, blindfold) take effect live in the SPA
  on the next push and persist to the account; the nametag-side
  toggles (selfnametag, nametagid) write a replicated state bag
  now and will activate once the nametag overlay ships.

- /fontsize <0.5-1.5> scales the chat overlay font live via a CSS
  custom property so every nested rule resizes together. /pagesize
  <5-40> sets how many chat rows are visible at once; the row
  height auto-scales with /fontsize so the visible window stays at
  exactly N rows regardless of font choice. PageUp / PageDown
  scroll by the configured row count when the input bar is open.

- Chat-UI preference persistence. The chat-side /toggle entries
  (timestamp, chat, charactercounter, blindfold) plus /fontsize
  and /pagesize round-trip through AccountSettingsService now, so
  every choice survives reconnect, /changecharacter, and /logout.
  The server reads the current value, flips or replaces it,
  writes back to the `accounts.settings` JSON column, then emits
  the resolved value to the client - the SPA applies the result
  directly rather than flipping a local copy that could drift
  from the persisted one. AuthCompleted hydrates the Chat store
  from the snapshot so the overlay starts in its persisted state
  before the first message arrives.

- Backend now emits a `Roleplay:Net:Chat:SettingChanged` event for
  every /toggle / /fontsize / /pagesize so the Frontend can
  forward it as a NUI message; the SPA Chat store applies the
  setting in one switch. State-bag writes still happen for
  cross-resource consumers.

- CharacterRuntime now carries the character's first name, last
  name, and mask ID alongside the existing per-session fields.
  Attached at spawn so every chat broadcast resolves a Source to
  the displayed name in one in-memory lookup, with no DB read on
  the hot path. The mask flag is read from the same struct so the
  identity swap is atomic with the per-character cache attach.

- In-world nametag overlay. Every spawned player carries a stacked
  text tower above their ped, rendered client-side via the native
  3D text draw path (not a Vue overlay) so the engine handles the
  world-to-screen projection and walls occlude naturally. Four
  optional lines stack top-to-bottom: the /ame /amy roleplay
  action in purple, an OOC injury indicator in red when the
  player is not Healthy, an orange `[...]` typing indicator while
  the player has the chat input focused, and the name + Source ID
  line at the bottom. The name line goes white for regular
  characters, swaps to yellow plus a `[Rank]` prefix and the
  player's Discord display name while admin duty is active, and
  flashes red for 600 ms whenever the player takes damage. A
  trailing ` [M]` flags minor characters (age strictly under 18,
  derived at spawn from the stored birth date). Nametags are
  visible within 15 m, scale from 0.45 down to 0.30 across that
  range, and fade linearly to invisible at the cutoff. A
  300 ms-cached line-of-sight raycast hides nametags whose
  bearer is behind a wall or other geometry; same routing bucket
  is enforced automatically because the engine does not stream
  out-of-bucket players. The mask-aware display name is published
  server-side through the existing
  `ProximityBroadcaster.DisplayName` chokepoint, so a masked
  player's legal name never reaches another client - the in-world
  tag reads `Stranger <MaskID>` for the duration of the mask
  exactly as the chat surface does.

- /toggle selfnametag (alias: /toggle selftag) renders the local
  player's own nametag above their own ped so they can probe what
  others see; off by default to keep the camera clean. /toggle
  nametagid (alias: /toggle tagid) hides or shows the `(<id>)`
  Source ID suffix on every nametag; on by default. Both round-
  trip through `AccountSettingsService` so the choice survives
  reconnect, /changecharacter, and /logout. The persisted values
  are also mirrored into the local player's state bag at
  AuthSuccess so the nametag renderer reads them every frame
  without a round-trip through the SPA.

### Changed

- Plain text typed into the chat input without a leading slash now
  routes through /say instead of replying `((INFO: No chat channel
  selected. Try /help.))`. The dispatcher remains the single owner
  of the broadcast path (permission gate, cooldown stamping,
  rate-limit accounting), so slashless and explicit /say have
  identical server-side semantics.

- Masked-character chat label uses `Stranger <MaskID>` rather than
  `Mask <MaskID>`. The `Stranger` framing is in-fiction (an
  observer who does not recognise the masked person) rather than
  the meta `Mask` label, which kept the underlying mechanic
  visible inside the IC channel. Every IC line (speech, action,
  local OOC, directed speech, nametag action, lookup) goes
  through the same single ProximityBroadcaster.DisplayName
  chokepoint, so the rename is one source of truth.

- Chat palette retune. WARNING now renders in true orange `#FFA500`
  (was warm peach) so it reads as attention rather than soft
  caution. INFO is a clearer blue `#5B9BFF` (was a light periwinkle
  that competed with body text). USAGE moves to light yellow
  `#FFE066` matching the Highlight tone, so usage hints sit
  visually with the inline-emphasis family rather than the
  error-red family. /command inline references, feature-prefix
  BRANDs (BANK:, BOOMBOX:, etc.), and block headers / sections /
  footers all default to emerald `#10B981`, matching the brand
  primary - the entire branded surface (welcome card, /help, /id,
  feature notices, command references) now reads in one consistent
  emerald rather than the previous mix of saturated red and soft
  red. $amount formatting deepens to a standard green `#22C55E`.
  The /b local OOC wrap shifts to grey `#9CA3AF` so out-of-character
  commentary fades into the panel rather than competing with IC
  speech. /whisper verb tint moves to pale orange `#FFCC99` -
  paired with /shout's vivid orange, the speech surface now reads
  volume through saturation rather than hue. ADMIN broadcasts and
  ERROR severity keep soft red `#FF8080`.

### Fixed

- Nametag draw origin was being pinned to world coordinates
  `(0, 0, headZ)` for every tracked player rather than to the
  ped's actual head position - so every tag was rendering, just
  stacked at the world spawn anchor where nobody could see it.
  The most visible symptom was `/toggle selftag` appearing to do
  nothing. `RenderTower` now takes the full head `{X, Y, Z}` and
  `SetDrawOrigin` projects from the correct world point.

- Chat history navigation no longer misbehaves around the edges
  of the buffer. Pressing Down from a fresh, non-recall input is
  now a no-op (it previously jumped to the *oldest* submission
  because the entry branch picked index 0 for any Down step).
  Pressing Down past the most recent recall now exits history
  mode and empties the buffer, so a second Down does nothing and
  the player is back in fresh-typing mode (it previously stayed
  clamped at the newest entry forever). Once history mode is
  active, arrow keys keep walking history regardless of whether
  the recalled line starts with `/` and triggers the suggestion
  box - so recalling `/help`, then pressing Up again, walks to
  the previous submission instead of silently flipping into
  suggestion-row scrolling.

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
