# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-06-06

### Added

- Injury, incapacitation, and death system. Characters now progress
  through a four-stage cycle - Healthy, Unconscious, Badly Wounded,
  Dead - each step triggered by a lethal-damage event the client
  detects via a 250 ms health poll on the local ped and the server
  confirms by sending an authoritative HP / armour / teleport payload
  back over the `Roleplay:Net:Injury:Apply` channel for the client to
  apply through the engine-side natives. Each transition snapshots the
  ped's coordinates so the body stays exactly where it fell during the
  wait window, broadcasts a purple `/me` auto-narration at Say range so
  nearby players witness the collapse in the same chat voice as the
  rest of the world, and sends the victim a personal warning toast
  carrying the remaining wait before `/acceptdeath` becomes available.
  State changes persist to the character row on every transition so a
  server restart cannot roll an injured character back to Healthy.
- `/acceptdeath` respawns the character at the nearest hospital
  (Pillbox Medical Center or Mount Zonah Medical Center, picked by
  Euclidean distance from the body) after a mandatory two-minute wait.
  The wait clock restamps on every reconnect so logging out for two
  minutes wall-clock cannot bypass the gate. The hospital warp also
  resets the anti-teleport position-validator baseline so the saved
  last-position reflects where the player respawned, not the grave -
  without that reset, the validator's "last sane" coords pin at the
  death site and a quick disconnect after respawn wakes the player
  back up at the grave on next login. Founder accounts on admin duty
  skip the two-minute wait so the respawn flow can be probed in
  isolation; every other staff rank waits the full timer.
- `/helpup <player_id>` lets a Healthy bystander lift an Unconscious
  character within three metres back to half health. Refuses on the
  three failure modes - issuer is themselves incapacitated, target is
  Badly Wounded or Dead instead of Unconscious, or the two are too far
  apart - each with a specific message. The help is auto-narrated to
  everyone in Say range as `* Issuer helps Target up.`.
- `/arevive <player_id>` is the administrator path. Requires admin
  duty and the `Administrator` staff level. No proximity gate; revives
  to full Healthy at HP 100 regardless of where the target is. Routes
  an OOC `(( INFO: An administrator has revived you. ))` to the target
  so they understand why their pose just cleared mid-sequence.
- Nametag overlay now surfaces the injury state above non-Healthy
  characters as a red OOC badge - `(( This player is unconscious. ))`,
  `(( This player is badly wounded. ))`, or `(( This player is dead. ))`
  - rendered between the typing indicator and the `/ame /amy` action
  line. The badge is visible to everyone in range; the wearer cannot
  hide it.
- Client-side suppression of the engine death cycle. Players who
  reach a non-Healthy state see the local ped fall into a looped
  `dead/dead_a` pose half a second after the collapse, lose access
  to attack, aim, melee, weapon swap, reload, grenade throw, and
  vehicle entry, and gain invincibility so a second damage source
  cannot stack while the engine is still resolving the first hit's
  animation. The WASTED big-text overlay, the WANTED stars HUD, and
  the arrest/respawn timer are pinned hidden per frame so the
  vanilla flow never surfaces.
- `/noclip` admin free-fly toggle. Requires admin duty and the
  `Administrator` staff level. Flips the local ped into an invisible,
  collision-free, gravity-frozen, invincible state and registers a
  per-frame movement tick driven by camera-relative WASD (forward /
  back / strafe) plus Space (up), Left Ctrl (down), and Left Shift
  (four-times boost). The server owns the on/off bit per Source so a
  duplicate `/noclip` or a reconnect mid-noclip cannot desync state,
  and the client auto-disables on `/changecharacter` and `/logout` so
  collision and visibility never carry across into the next character.
  The anti-teleport position validator is suspended for the flying
  admin so shift-boosted flights (~120 m/s, well over the validator's
  200m-per-2s threshold) do not flood the warn channel or pin the
  saved position at the takeoff coords. The validator still walks the
  entry under suspension and refreshes its baseline from native reads,
  so a disconnect while noclipping saves wherever the admin actually
  flew to.

### Changed

- IC chat channels - `/say`, `/shout`, `/whisper`, `/low`, `/me`,
  `/melow`, `/melong`, `/do`, `/dolow`, `/dolong`, `/my`, `/mylow`,
  `/mylong`, `/ame`, `/amy`, the directed-speech cluster, and the
  vehicle chat cluster - now refuse to dispatch while the character
  is in any non-Healthy state, replying `You cannot speak. You are
  incapacitated.`. Local OOC (`/b`, `/blow`), global OOC (`/o`), PMs
  (`/pm`, `/reply`), `/id`, `/acceptdeath`, and admin commands stay
  available so the incapacitated player can still call for help and
  receive moderation. The block is enforced as a shared `BeforeRun`
  guard composed alongside each command's existing argument checks.

