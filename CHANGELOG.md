# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

## [0.5.0] - Unreleased

### Added

- Anti-cheat. The server now watches for the cheats that matter on a
  roleplay server: teleporting, impossible running and flying speeds,
  super jumps, weapons that were never legitimately obtained, endless
  ammunition, impossibly fast firing, god mode, character model swaps,
  spawned vehicles, remote explosions and fires, and tampering with
  other players' weapons. Suspicious behaviour is recorded with the
  time, place, and evidence, and on-duty staff are alerted in chat the
  moment a pattern emerges. The same alert can be mirrored to
  Discord: point the anticheat_discord_webhook setting at a channel
  webhook and every alert posts there too, so staff who are not in
  game still see it. Left empty, the in-game alerts carry on alone.
- Anti-cheat enforcement ships switched off. The
  anticheat_enforcement setting decides what happens when a player
  crosses a detection's threshold. On "observe", the default,
  nothing is punished automatically - detections only record and
  alert, so the thresholds can be tuned against real play first. On
  "kick", a player past the threshold is additionally dropped from
  the server. Nothing else is wired up either way: no automatic
  bans, no freezes.
- Staff review the anti-cheat records in game with /ac. /ac recent
  lists the latest violations across everyone, /ac player <player_id>
  narrows to one connected player, /ac stats <player_id> shows the
  per-player hit statistics that make aim cheats stand out over time,
  and /ac status reports the current enforcement mode alongside live
  session scores. Founders also have /ac test, which runs the
  detection pipeline against themselves so the plumbing can be proven
  without a suspect.
- Inventory. Your character now carries a personal inventory with
  twenty slots and a twenty-kilogram weight limit, created the first
  time you spawn. Every change to it - every pickup, hand-off, use,
  and drop - is written to a permanent audit trail that staff can
  review, and the server outright refuses implausibly rapid bursts
  of inventory actions. Vehicle trunks, gloveboxes, property and
  business storage are reserved for later updates.
- Cash lives in your inventory. Money is now a physical item in
  your pockets rather than an invisible number: it stacks up to one
  hundred thousand dollars per stack, and new characters start with
  five thousand dollars. Bank balances are unaffected for now.
- Medical items. The bandage restores twenty-five health on a
  five-second cooldown, the body armor refills all one hundred
  armour points on a ten-second cooldown, and the medkit gives
  twenty-five health at once plus five per second over the next
  fifteen seconds on a thirty-second cooldown. No healing item can
  ever push you past one hundred health.
- Weapons, ammunition, and attachments. The catalog covers all 112
  holdable weapons in the game - handguns through launchers, melee,
  thrown weapons, and the utility cans - plus 223 attachments (a
  suppressor or grip is a single item that fits every weapon that
  accepts it), 18 ammunition classes, and six kinds of spent shell
  casing. Attachments occupy seven slots (magazine, sight, muzzle,
  grip, flashlight, barrel, and skin), so two attachments that
  cannot coexist on a gun compete for the same slot. Magazine sizes
  follow the game's own values, except that the belt-fed and charge
  weapons (minigun, Widowmaker, Unholy Hellbringer, stun gun) keep
  sensible reload caps instead of effectively endless ones.
- The server counts every shot itself. Ammunition is tracked
  entirely server-side, so a modified client cannot fake its ammo
  count or hold on to a weapon the server has taken away. Firing
  ejects a shell casing at your feet stamped with the weapon's
  serial number (or N/A when the serial has been filed off) - one
  casing per trigger pull, so a burst leaves a single casing
  rather than one per round - and
  every hit on a person is recorded with the weapon's serial, the
  ammunition type, and the victim - police can recover casings from
  a scene and investigators can trace a gun's full history.
  Revolvers, break-action weapons, energy weapons, and launchers
  retain their spent casings and leave nothing behind.
- Reloading pulls from your largest matching ammunition stack first,
  and mixed loads fire in the order they were loaded. Renamed
  rounds keep their custom name inside the magazine and only merge
  with rounds of the same type and the same name, so a boutique
  "9mm R.I.P." stack never blends into plain stock.
- Thrown weapons are their own ammunition: equipping one readies
  the whole stack, every throw spends exactly one, and the final
  throw empties your hands and removes the spent stack. The jerry
  can and fire extinguisher come fully charged - a fresh can pours
  and a fresh extinguisher sprays with no reload step - and the
  remaining charge survives drops, trades, and server restarts. No
  refill item exists yet, so /item reload reports no compatible
  ammo for them by design; refills (such as gas pumps for the jerry
  can) arrive in a later update.
- Holding rules. /item equip refuses while you already hold a
  weapon and /item unequip refuses when your hands are empty;
  /item drop, /item give, and /container store all refuse the
  weapon in your hand, so you cannot stuff it into a backpack or
  hand it off mid-grip. Players can now damage one another, dead
  characters no longer scatter free weapon pickups on the ground,
  and an empty gun stays in your hand dry-clicking until you
  /item reload - no automatic swap to fists.
- Items on the ground. /item drop places the item at your feet, at
  floor level, using the server's own reading of your position.
  Everyone within fifty metres sees the item's actual 3D object
  with a floating label showing its name, quantity, and drop ID -
  never the serial or any hidden details - that fades out between
  five and seven metres. Items without a fitting object of their
  own appear as a generic placeholder bag, dropped objects never
  block movement or gunfire, and drops survive server restarts.
  /item nearby lists the drops within /low range with their IDs,
  and /item pickup [drop_id] takes one - the nearest in range when
  you omit the ID. If two players grab the same drop at the same
  moment, exactly one of them gets it.
- Containers, narcotics, and alcohol. The small backpack and the
  small and medium ziploc bags hold their own inner inventory,
  worked through /container store and /container take. Weight is
  checked all the way through, so a heavy load cannot hide inside
  a backpack to dodge your carry limit. Cocaine and marijuana carry
  hidden purity, THC, and CBD values that blend by weighted average
  whenever batches merge - cutting a pure batch with a weak one
  produces a genuinely mixed result, and staff-spawned drugs arrive
  with standard reference-grade values so an unmarked batch can
  never dilute a real one toward zero. Beer, whiskey, and wine
  each carry their real alcohol strength; drinking any of them
  shows witnesses only "* takes a drink." and using a drug shows
  only "* uses something." - nobody reads the label or the
  substance off an animation.
- Licenses, phones, and papers. The driver's license and weapon
  license are bound to your character: they cannot be traded or
  dropped, and they are re-granted on every spawn - even if an
  administrator removes one mid-session, it returns immediately.
  Phones come in three models with identical mechanics for now: the
  iFruit and Badger touchscreen smartphones and the push-button
  Celltowa, with future phone interfaces matching the handset. Each
  phone is minted with its own unique 555 number, handing one over
  rebinds it to the new owner, and a found phone never reveals its
  former owner's number. Paper can be dropped and traded; a note
  can be dropped but never traded.
- A text-roleplay item set of twenty-four scene-driven types. The
  State Identification Card is bound to your character, permanent,
  and re-granted on every spawn alongside the licenses. The radio
  carries live text traffic over tunable frequencies; voice comes
  later. The cigarette burns away with a short narration when used,
  and the
  lighter completes the pair. Food and soft drinks - water, eCola,
  Sprunk, coffee, the burger, and the donut - restore a little
  health and pave the way for future hunger mechanics. Valuables
  (wristwatch, gold chain, ring) give robbery and pawn scenes loot
  that is neither cash nor a gun, engravable through the custom
  name and description queue. Zipties, rope, the lockpick, the
  digital scale ship as items only - restraint and lockpicking
  mechanics are later updates.
  Street drugs grow to five with methamphetamine, heroin, ecstasy,
  and prescription oxycodone, all using the same hidden-purity
  blending as cocaine, and medicine gains painkillers and the
  EMS-grade morphine.
- A second item wave ports the best of the previous servers'
  catalogs: thirteen more narcotics (crack, hashish, LSD,
  mushrooms, ketamine, PCP, fentanyl, opium, DMT, Xanax, Adderall,
  steroids, and GHB - powders blend their hidden purity, hashish
  blends THC like bud, pharmaceutical pills never blend), ten more
  containers (large ziploc bag, envelope, wallet, purse, paper bag,
  duffel bag, briefcase, suitcase, pill bottle, and crate -
  envelopes, wallets, and pill bottles refuse items that make no
  sense inside them, so a pistol cannot hide in an envelope), and
  fourteen scene tools: handcuffs, duct tape, boltcutters,
  screwdriver, shovel, spray can, camera, USB drive, breathalyzer,
  rolling papers, smoking pipe, bong, playing cards, and dice.
- Drinking leaves a measurable trace. Every beer, glass of wine,
  or shot of whiskey raises your character's blood alcohol in
  proportion to the drink's strength, and the level falls away
  steadily on its own - logging out sobers nobody up, though four
  hours after the final drink a character is guaranteed fully
  sober no matter how heavy the session was. The
  breathalyzer is a working instrument rather than a prop: use it
  alone to test your own breath, or use it on a player standing
  within reach to sample theirs. Every test is acted out openly in
  front of witnesses, and the measured percentage prints for
  whoever holds the device. Drunkenness itself - the stumbling,
  the blurred vision - waits for the bar update.
- Drugs are no longer flavour text. Using one moves your character's
  condition according to what the batch actually is: stimulants
  harden you with temporary armour that drains back away once the
  high runs its course, while opioids, sedatives, and cannabis knit
  health back over a short window - and a cut batch delivers exactly
  as much as its hidden purity deserves, so the dealer's honesty
  matters. There are deliberately no camera tricks, no stumbling, no
  screen effects; the high is stats and scenes, in keeping with a
  text-roleplay server.
- Habits form. Every dose of narcotics - and every drink - feeds a
  hidden dependence that builds with use and fades only across days
  of staying clean. A dependent character who goes too long without
  starts to show it: involuntary tremors, sweats, and restlessness
  acted out in front of everyone nearby, with a slow toll on their
  health that harasses but never kills on its own. Another dose buys
  quiet and deepens the habit; abstinence is the only way out.
- The narcotics test kit is now a working instrument. Use it on a
  drug in your own pockets with /item use <kit_slot> <target_slot>
  and it reads back the sample's true quality and purity - and the
  strain, THC, and CBD for cannabis - the values an ordinary
  inspection deliberately hides. The kit is reusable on a short
  cooldown, and the analysis is acted out openly, so a reading is
  never taken in secret.
- Identification can be shown. Use a driver's license, concealed-
  carry license, or State Identification Card with /item use <slot>
  to read your own card, or /item use <slot> <player_id> to present
  it to a person within reach. Presenting reveals your real name to
  them even while you are masked - identifying yourself is a
  deliberate choice - while bystanders see only that a document was
  shown.
- Handheld radios carry the airwaves. With a radio on you, /setradio
  on powers it up; tune up to three numbered slots to frequencies with
  /setfrequency. Speak on your main slot with /r (also /radio), or on a
  specific slot with /r1 through /r3, and everyone tuned to that
  frequency hears you - across the whole map, not only those nearby.
  Choose which slot your /r speaks on with /setmainradioslot (also
  /setmainradio). /partradio clears a slot, /muteradio silences one
  without losing it, and /setradio on its own lists your slots. A
  masked sender is heard as a stranger exactly as in ordinary speech.
  Your tuned slots are remembered between sessions; the radio itself
  starts switched off each time you log in. Part with the handset -
  drop it, hand it over, stow it in a bag - and the radio switches
  itself off shortly after: you cannot keep listening to a frequency
  on a radio you no longer carry. Voice over the radio comes later.
- Phones can be used, no app screen required - everything runs through
  /phone (alias /ph). A handset carries its own number, a prepaid
  balance, and a contact book. /phone on its own is the home screen,
  printing your number, credit, and power state - /phone status does
  the same - and /phone help lists every action. Switch it on or off
  with /phone power, and if you carry more than one, choose the active
  handset with /phone main. Text someone with /phone sms send, by saved
  contact name or by number, and read your messages with /phone sms
  log; leave a voicemail with /phone vm send and check yours with
  /phone vm inbox and /phone vm read. Save numbers with /phone contact
  add, remove, and list. Place a call with /phone call dial, /phone
  call answer to pick up and /phone call hangup to end it, and review
  your recent calls with /phone call log; while connected, whatever you
  /say is heard by the people beside you and carried down the line to
  the other party. Texts, voicemails and calls cost a few cents of
  credit. Incoming messages and callers show your saved contact name for
  that number, or the bare number if you have not saved it - never the
  person's real name, so the phone cannot be used to unmask anyone. A
  phone holds its number, balance, contacts and history on the handset
  itself, so a phone that changes hands carries them with it; a passcode
  lock comes later. Group chats, on-screen apps, and emergency lines
  arrive in later updates.
- Evidence on the ground can be read where it lies. /item examine
  studies the nearest drop in reach, or a specific one by its
  number, without picking anything up: a pool of blood gives up
  its blood type, a spent casing its stamped serial, a dropped
  pile of cash its amount. The act is shown to everyone nearby,
  so nobody collects forensic details in secret, and fixtures that
  refuse to be picked up - blood above all - can finally be
  studied at all.
- Action narration floats above the head instead of filling the
  chat. Using a medical item, drinking, taking a substance, handing
  an item to someone, examining evidence, and administering a breath
  test all appear as a brief action line over the character - the
  same display /ame uses - so the chat box stays clear for
  conversation. Involuntary tells follow the same rule: collapsing,
  dying, withdrawal tremors, and helping someone to their feet all
  float over the character now rather than printing to chat. A
  downed or dead character keeps the standing "(( ... ))" notice
  above the nametag once the moment-of-collapse line fades.
- Three commands run the whole inventory. /inventory (aliases /inv
  and /i) shows your manifest, /item <subcommand> handles every
  action aimed at a slot, and /container <subcommand> works a held
  container; typing /item or /container alone prints the full
  subcommand list with descriptions. Item verbs: /item cash, use,
  inspect, examine, drop, pickup, nearby, give, move, split, equip,
  unequip, reload, attach, detach, rename, describe, and
  removeserial.
  Container verbs: /container info, store, and take. /inventory
  <container_slot> still opens a held container's contents
  directly.
- /item use acts on what the item is: medical items heal you, drugs
  and alcohol consume with their deliberately vague narrations, and
  a container opens to show its contents. /item give requires the
  recipient within three metres, refuses non-tradeable items and
  self-handovers, and shows witnesses only "* John gives something
  to Jane." - the item itself stays private. /item move accepts an
  optional amount: the stated units leave the source stack and
  merge into a matching stack (capped at the stack limit) or settle
  into an empty slot; without an amount the whole stack moves, and
  asking for more than you have is refused. The confirmation
  reports how many units actually moved, so a capped merge is never
  mistaken for a full transfer.
- Custom flavour goes through moderation. /item rename,
  /item describe, and /item removeserial submit your custom name,
  description, or serial-removal request to a staff-reviewed queue,
  capped at three pending requests of each kind per character.
  Passing the word "clear" to rename or describe skips the queue
  and wipes the custom text on the spot - removing flavour needs no
  moderator, only adding it does. /item inspect lists loaded
  ammunition batch by batch with a [next to fire] marker, shows
  attachments by slot, and shows a picked-up casing's firing-weapon
  serial - or N/A when the serial was defaced.
- Staff item tooling lives under a single /aitem <subcommand>
  command; typing /aitem alone prints the verbs grouped by required
  rank. Founder: /aitem give, create, and cleanlog - creating value
  gates at the top so a rogue moderator cannot quietly seed cash or
  weapons. Administrator: /aitem remove, extend, removeserial,
  setholder, cleardrops, and testcatalog, which proves the entire
  weapon catalog against the live game build. Moderator: /aitem
  list, find, history, trace, traceweapon, lastfired, requests,
  approve, and deny. /aitem give cash and /aitem
  remove cash take dollar amounts with up to two decimals (500 or
  420.69) and refuse anything finer. /aitem traceweapon <serial>
  lists every recorded hit across a weapon's lifetime, /aitem
  lastfired <character_id> lists the last ten distinct weapons a
  character has fired (older history comes to the web panel later),
  and every approved or denied flavour request permanently records
  which staff member actioned it.
- Staff phone tooling lives under /aphone; typing /aphone alone
  prints the verbs grouped by required rank. Moderator: /aphone find
  <555-number> traces a handset by its number, so a phone recovered
  at a scene or quoted in a report can be tied back to whoever is
  carrying it. Administrator: /aphone credits <player_id> <dollars>
  tops up a player's prepaid balance - topping up value gates one
  rank above merely looking a number up.
- Staff going on duty see the queue. When a Moderator or higher
  runs /aduty, chat reports how many item requests await review and
  which commands action them - no more polling the queue by hand.
  Helpers do not receive the notification, as they cannot view the
  queue.
- Bleeding. Bullet and blade wounds that draw blood now leave your
  character bleeding at one of three severities, and every further
  wounding hit deepens it. An open wound sheds blood onto the ground
  where you stand or walk: a victim lying still pools blood beneath
  them, while one on the move leaves a trail that medics, officers,
  and anyone else nearby can follow. Blood on the ground cannot be
  collected by hand and dries away on its own within the hour. Blunt
  weapons - bats, clubs, tools, and stun weapons - batter without
  ever opening a wound.
- Bleeding out. Light bleeding is a warning and nothing more. Steady
  bleeding saps your health toward the halfway mark and forces a
  wounded limp that rules out sprinting. Heavy bleeding keeps
  sapping until you collapse unconscious, slows you further, makes
  jumping impossible, and periodically staggers you off your feet. A
  bandage eases bleeding by one step, a medkit stops it outright,
  and being helped up, revived by staff, or waking at the hospital
  always closes the wound.
- Treatment requires consciousness. An incapacitated character can
  no longer use items on themselves - bandaging a downed friend
  means getting them on their feet first, or calling for a medic.
- Staff can set a player's bleeding severity directly with
  /asetbleeding, for testing and for directing scenes.

### Changed

- Switching characters with /changecharacter, using /logout, or
  disconnecting now strips your equipped weapon first, so a gun can
  never follow you across a character switch - even a modified
  client that ignores the instruction has already lost the weapon
  on the server's side.
- Injuries keep getting worse under continued damage. A downed
  character is no longer invincible: any further serious hit -
  gunfire from players or NPCs, vehicles, falls, fire, anything
  that hurts - pushes your injury state one step further down,
  with a ten-second breather between steps. The server also
  watches every player's health on its own, so a modified client
  that stays silent cannot keep itself out of the injury system.
- The damage flash on nametags is now driven by the server, so a
  modified client can no longer fake its own flash or suppress it.
  It triggers on weapon hits - gunfire and melee - taken from other
  players; vehicle impacts, falls, and fire no longer set it off.
- Healing and armour are now applied by the server. Armour resets
  from /acceptdeath and /arevive land directly, and a bandage heals
  from your actual current health, clamped at one hundred - using
  one at full health now does nothing instead of granting a free
  full heal.
- Vehicle chat now shows player IDs too. /cb and /cw were the last
  channels the /toggle nametagid (alias /toggle tagid) switch did not
  reach; an in-car OOC line or whisper now leads with the speaker's ID
  exactly as its proximity twin does, so the toggle behaves the same
  everywhere.
- Radio and phone traffic read as their own channels. A radio
  transmission renders in cyan from the frequency tag to the last
  word, and an incoming text or voicemail renders in indigo, so
  neither is mistaken for someone speaking beside you. The player-ID
  prefix is grey wherever it appears, marking it as the
  out-of-character handle it is. Radio lines carry that prefix; phone
  lines never do, since an ID beside a phone number would undo the
  anonymity the phone is built on.
- Plus internal groundwork behind the scenes, with no in-game effect:
  build and tooling repairs, automatic database upgrades on server
  start, a broad performance pass so the busiest paths - chat
  delivery, nametags, floating labels, and inventory bookkeeping -
  cost less per player and per message, hardening of the new inventory
  and communications systems ahead of release, and a full
  documentation pass over the codebase.

### Fixed

- The /inspect detail card now renders structured values readably
  instead of printing "[object Object]".
- PageUp and PageDown in chat scrolled by an assumed line height
  rather than the height actually on screen, so once a few messages
  wrapped onto two lines the page step drifted and reading back
  through history skipped or repeated lines. A page now moves exactly
  one screenful whatever your /fontsize and /pagesize.
- Nametags and floating labels could very occasionally bunch together
  at a single point in the world for a frame instead of sitting above
  the players and items they belong to.

### Notes

- Everything from 0.4.0 and earlier behaves as before; this release
  builds on top of it.
- Several parts of this release are deliberately groundwork for later
  ones. Radio and phone carry text only - voice comes later. Bank
  balances exist but are frozen until the banking update. Vehicle
  trunks, gloveboxes, and property and business storage are reserved
  for the updates that introduce them, as are refills for the jerry
  can and extinguisher, phone passcodes, group chats, and restraint
  and lockpicking mechanics for the items that imply them.
- Anti-cheat ships in observing mode. It records and alerts but
  punishes nothing automatically, so the thresholds can be tuned
  against real play before they affect anyone.

## [0.4.0] - 2026-06-06

### Added

- Injury, incapacitation, and death. When your character takes a
  killing blow they no longer just respawn — they fall through a
  four-stage cycle: Healthy, Unconscious, Badly Wounded, and Dead.
  The server has the final word on every stage change, so a modified
  client cannot pretend to be healthy. Your body stays exactly where
  it dropped, players within speaking range see a purple action line
  above the character announcing the collapse, and you receive a
  personal warning telling you how long until /acceptdeath unlocks.
  Your injury state is saved the moment it changes, so a server
  restart cannot put a wounded character back on their feet. A
  character who is already Dead and takes another killing blow is
  carried to the hospital automatically rather than dying over and
  over in place.
- /acceptdeath gives up the fight and respawns you at whichever
  hospital is closer to your body — Pillbox Medical Center or Mount
  Zonah Medical Center — after a mandatory two-minute wait. The
  timer restarts whenever you reconnect, so logging out and back in
  does not skip the wait. Respawning also updates your saved
  location straight away: disconnecting right after waking up at
  the hospital brings you back at the hospital, not at the spot
  where you died. Founders on admin duty skip the two-minute wait
  so the flow can be tested; every other staff rank waits the full
  timer like everyone else.
- /helpup <player_id> lets a healthy bystander pull an Unconscious
  character within three metres back onto their feet at half health.
  It refuses — each case with its own message — if you are
  incapacitated yourself, if the target is Badly Wounded or Dead
  rather than Unconscious, or if you are too far apart. Everyone in
  speaking range sees the rescue narrated in chat as
  `* Issuer helps Target up.`.
- /arevive <player_id> is the staff revive. It requires admin duty
  and the Administrator rank, works at any distance, and brings the
  target straight back to full health. The revived player receives
  `(( INFO: An administrator has revived you. ))` so they understand
  why their scene just reset.
- Downed characters are flagged above their head. Anyone in range
  sees a red out-of-character badge over an injured character —
  `(( This player is unconscious. ))`, `(( This player is badly
  wounded. ))`, or `(( This player is dead. ))` — displayed between
  the typing indicator and the /ame and /amy action line. The badge
  shows to everyone nearby and cannot be hidden by its wearer.
- The vanilla GTA death sequence is gone. A downed character slumps
  into a lifeless pose half a second after collapsing, cannot
  attack, aim, fight hand-to-hand, swap weapons, reload, throw
  grenades, or enter vehicles, and cannot be damaged again while
  down — a second hit will not pile a fresh injury onto one still
  playing out. The WASTED screen, the wanted stars, and the stock
  respawn countdown never appear.
- /noclip free-fly for staff. Requires admin duty and the
  Administrator rank. Toggling it makes you invisible, weightless,
  unhittable, and free of collision, then lets you fly with WASD
  relative to the camera, Space or E to rise, Left Ctrl or Q to
  descend, and Left Shift for a four-times speed boost. The server
  keeps track
  of who is flying, so typing /noclip twice or reconnecting
  mid-flight cannot leave the mode stuck half-on. It switches
  itself off when you use /changecharacter or /logout, so the next
  character never inherits the ghost state, and disconnecting while
  flying saves you at the spot you actually flew to.

### Changed

- Player IDs now show in chat, not just on nametags. The same
  /toggle nametagid (alias /toggle tagid) switch that adds the ID to
  nametags now also prepends the speaker's ID to what you read in
  chat — local speech and actions, directed speech, and private
  messages all lead with the other person's ID when you have the
  toggle on. It is your own preference: turning it on shows IDs to
  you without affecting what anyone else sees, exactly like the
  nametag setting.
- Revived characters no longer look wounded. Being put back on your
  feet — by /helpup, an administrator's revive, or being carried to
  the hospital — now wipes the blood, dirt, wetness, and impact marks
  the body picked up while it was down, so a healthy character looks
  healthy again instead of staying covered in damage.
- Incapacitated characters can no longer speak in character. While
  Unconscious, Badly Wounded, or Dead, every in-character channel —
  /say, /shout, /whisper, /low, /me, /melow, /melong, /do, /dolow,
  /dolong, /my, /mylow, /mylong, /ame, /amy, the directed-speech
  commands, and the vehicle chat commands — replies `You cannot
  speak. You are incapacitated.`. Out-of-character channels stay
  open: /b, /blow, /o, /pm, /reply, /id, /acceptdeath, and admin
  commands all keep working, so a downed player can always call
  for help and still be reached by staff.

## [0.3.2] - 2026-06-04

### Fixed

- Sending a /pm or /reply to someone who has blocked you no longer
  pretends to succeed. Previously the message was discarded before it
  reached them, but you still saw your own "(( PM to ... ))" line, so
  every message looked delivered and you could keep typing into the
  void without ever knowing. You now get a plain "Your message could
  not be delivered." error instead — worded exactly like the error
  for an offline target, so the rejection never gives away that you
  have been blocked.

## [0.3.1] - 2026-06-04

### Changed

- Typing /ame or /amy now prints your own action line back into your
  chat, in the same purple shade it floats above your head, with a
  `> ` marker in front so you can tell it apart from a regular /me
  or /my at a glance: /ame appears as `> * Name action` and /amy as
  `> * Name's action`, while /me stays `* Name action` and /my stays
  `* Name's action`. This replaces the old "INFO: Roleplay action
  set. It will clear automatically in 5 seconds." confirmation,
  which read as noise and left you with no trace in chat of what
  you had actually typed. Nothing changes for the players around
  you — they still see the floating text above your head exactly as
  before, without the marker.

## [0.3.0] - 2026-05-30

### Added

- In-character speech. /say is your normal speaking voice and is
  heard up to 10 metres away; it is also what happens when you type
  plain text into chat with no slash at all. /shout (alias: /s)
  carries 25 metres for louder lines, /low (alias: /l) drops to
  5 metres for quiet exchanges, and /whisper (alias: /w) drops to
  3 metres for one-on-one words inside a crowd. /say and /shout
  appear in plain white; /low lines render in light gray and
  /whisper lines in pale orange from the name to the last word, so
  a hushed line reads as hushed at a glance. Characters in
  different worlds never hear one another, no matter how close
  they appear to stand.
- /b local out-of-character chat (alias: /ooc). Your line appears
  as `(( Name: message ))` in grey to players within 15 metres, so
  OOC commentary stays visually apart from in-character speech and
  actions.
- /blow, local OOC at a quiet 5-metre range. Same `(( Name:
  message ))` wrap and grey colour as /b, just quieter — an
  out-of-character aside during a close scene stays between the
  people in it instead of reaching onlookers.
- Directed speech: /to (alias: /sayto), /shoutto (alias: /sto) and
  /wto address one specific player by their ID. Bystanders in
  range see the line as `Sender says to Target: message`, while
  the target sees `-> Sender says to you: message` with the arrow
  in bright pink so being spoken to jumps out of the scrollback —
  the one splash of colour no other channel uses. The target only
  ever sees their own copy, never both. Founders on admin duty may
  direct these at themselves to preview both versions at once.
- /me, /do and /my roleplay actions, each in three ranges — nine
  commands in total. /me shows as `* Name action`, /do as
  `* description (( Name )) *`, and /my as `* Name's description`.
  The base commands reach the standard 10 metres; /melow, /dolow
  and /mylow narrow to 5 metres for close-quarters detail; /melong,
  /dolong and /mylong stretch to 25 metres for scene-wide beats.
  All action lines render in purple, clearly set apart from speech.
- /ame and /amy nametag actions. Both place a short roleplay
  action above your head — /ame as `* Name action`, /amy as
  `* Name's action` — visible to nearby players for five seconds
  before it clears on its own.
- /pm <player id> <message> private messages (alias: /dm), with
  /reply <message> (alias: /rm) to answer whoever messaged you
  last. Both sides see the exchange as `(( PM to Name: message ))`
  and `(( PM from Name: message ))`, rendered entirely in yellow.
  A masked sender or recipient appears as `Stranger` plus their
  mask number instead of their legal name, and player IDs are
  never printed inside the message, so private messages cannot be
  used to unmask anyone. You cannot message yourself; the single
  exception is a Founder on admin duty, who may self-message to
  check the format without a second player.
- /blockpm and /unblockpm. Blocking a player silently drops their
  private messages to you — they still see their own "sent" line
  and never learn they were blocked. Blocks are tied to the
  account, so they survive your reconnects and still apply even if
  the blocked player returns with a different player ID.
- /o, a global out-of-character broadcast that reaches the whole
  server. For now it is restricted to Founders on admin duty until
  a fuller staff channel system arrives.
- /cb and /cw vehicle chat. Both speak only to the people sharing
  your vehicle and politely refuse if you are on foot. /cb is the
  in-car OOC channel in the familiar grey `(( ))` wrap; /cw is an
  in-car whisper in the same pale orange as /whisper.
- /aduty and /admins. /aduty switches admin duty on or off for
  staff ranked Helper and above. /admins lists every staff member
  currently on duty in a framed emerald block — a masked admin
  still appears under their mask, not their legal name.
- /dice (alias: /rolldice) rolls a six-sided die and /coin (alias:
  /flipcoin) calls Heads or Tails. Both announce the result as a
  purple action line to everyone within the normal 10-metre
  speaking range.
- /id <name or id> player lookup. A number is matched against
  player IDs first and falls back to a name search, so looking up
  a masked player's number still finds their `Stranger` label.
  Words search every connected player's display name, ignoring
  case. Multiple hits render as a framed list capped at ten
  entries, with a hint when more matched.
- /clearchat wipes your own chat window and nobody else's. Handy
  before screenshots, between scenes, or after a long /help dump.
- /toggle <setting> gathers the chat and nametag switches into one
  command: timestamp (message timestamps), chat (chat visibility),
  charactercounter (alias: counter — the character count in the
  input bar), selfnametag (alias: selftag — your own nametag),
  nametagid (alias: tagid — the player ID, shown both inside nametags and in chat), and
  blindfold (a solid black backdrop behind chat for screenshots).
  Chat switches apply instantly, and every choice is saved to your
  account.
- /fontsize <0.5-1.5> resizes the chat text live, and /pagesize
  <5-40> sets how many chat rows are visible at once — the window
  always shows exactly that many rows whatever font size you pick.
  PageUp and PageDown scroll a page at a time while the input bar
  is open. These choices, together with the chat toggles, survive
  reconnecting, /changecharacter and /logout.
- In-world nametags. Every player now carries a floating tag above
  their head, visible within 15 metres, shrinking and fading with
  distance and hidden entirely while a wall stands between you. Up
  to four lines stack above a player: their current /ame or /amy
  action in purple, a red injury indicator when they are hurt, an
  orange `[...]` while they are typing in chat, and their name
  with player ID at the bottom. Names are white for ordinary
  characters; an admin on duty shows in yellow with a `[Rank]`
  prefix and their Discord name; the name flashes red for 0.6
  seconds when that player takes damage; and characters under 18
  carry an ` [M]` marker. A masked player's tag reads `Stranger`
  plus their mask number — a mask hides your legal name in the
  world exactly as it does in chat.
- Your own nametag stays hidden by default to keep your screen
  clean; /toggle selfnametag (alias: /toggle selftag) shows it so
  you can see exactly what others see. /toggle nametagid (alias:
  /toggle tagid) hides or shows the player ID on every tag and is
  on by default. Both choices are saved to your account.
- In-game chat overlay. A chat panel in the top-left corner of the
  screen shows every line the server sends, in full colour. Press
  T to open the input bar; Enter sends, Tab accepts the
  highlighted command suggestion, Esc cancels, and PageUp /
  PageDown scroll the history while typing. Chat is readable from
  the moment you connect, so welcome messages and notices are
  never missed, but typing unlocks only once your character has
  spawned — and the panel steps aside during character creation so
  it does not compete with the wizard.
- /help lists every command available to you, grouped by category
  (Chat, RP, Comms, Utility, Admin) in a framed block. The same
  list feeds the input bar's autocomplete suggestions from the
  moment you spawn.
- Command handling is enforced by the server end to end: the
  server itself decides who issued each command and whether they
  are allowed to run it, so a modified client cannot impersonate
  another player or skip a permission or cooldown check. Every
  mistyped or disallowed command answers with a clear chat
  message.
- /changecharacter (aliases: /changechar, /switchcharacter,
  /switchchar) returns you to the character selector without
  disconnecting. Your position, heading, world, health, armour,
  mask state, cash, bank balance, injuries and bleeding status are
  all saved, your character vanishes from the world, chat is
  cleared, and the selector reloads your character list.
- /logout (alias: /signout) does everything /changecharacter does
  and then signs you out of your account entirely. The login
  screen returns, and clicking Enter Server signs you straight
  back in — no reconnect required.
- A welcome line greets you the moment you connect: "Welcome to
  Legacy.mp - Roleplay" with your Discord name, the .mp accented
  in emerald, wrapped in (( )) as out-of-character narration.
- A notice block follows the welcome line on every connect: the
  server is non-monetised; it is not affiliated with Rockstar
  Games, Take-Two Interactive, or any of their parent companies,
  subsidiaries or rights holders; players must be of legal adult
  age in their country of residence; roleplay may depict violence,
  injury and other content unsuitable for minors; and continued
  play means accepting the server rules.
- A "Welcome Back" card greets every freshly spawned character
  with their full name, linked Discord name, numeric player ID,
  staff rank when they hold one, and active premium tier with its
  expiry date. Chat is cleared first so the card lands on a clean
  panel.
- Your theme choice (Light / Dark / System) is now saved to your
  account, so it survives logging out and reconnecting instead of
  living only inside one game client.
- Cancel during character creation. If you already own at least
  one character, you can back out of the creation pages to the
  selector without committing the new character. With zero
  characters the only way forward is to finish the wizard.
- A proper loading screen. Connecting now shows the server logo on
  a darkened backdrop with an emerald progress bar at the bottom
  centre that tracks real loading progress, replacing the blank
  screen and the engine's default corner spinner.

### Changed

- Typing plain text with no slash now simply speaks through /say
  instead of replying "((INFO: No chat channel selected. Try
  /help.))". Slashless text behaves exactly like an explicit /say.
- Masked characters are now labelled `Stranger` plus their mask
  number rather than `Mask` plus the number — the wording of an
  observer who does not recognise the person, instead of a label
  that exposed the mechanic. The new label applies everywhere a
  name can appear: speech, actions, local OOC, directed speech,
  nametags, private messages and lookups.
- Chat colours retuned. Warnings are now a true orange, info lines
  a clearer blue, and usage hints a light yellow. Command
  references, feature prefixes (BANK:, BOOMBOX: and friends) and
  the framed block headers all share the brand emerald, dollar
  amounts deepen to a richer green, local OOC fades to grey so it
  stops competing with speech, and /whisper turns pale orange so
  that beside /shout's vivid orange, volume reads through colour
  intensity. Admin broadcasts and error lines keep their soft red.

### Fixed

- Nametags were drawing in entirely the wrong place — every tag
  stacked at one far-off point in the world where nobody could see
  it, which made /toggle selftag appear to do nothing. Tags now
  sit above each player's head as intended.
- Chat history recall behaves at the edges. Pressing Down in a
  fresh input no longer jumps to your oldest message, pressing
  Down past your newest message now exits recall cleanly, and the
  arrow keys keep walking your history even when the recalled line
  is a /command that opens the suggestion box.
- The loading bar used to sit at 0% while the engine painted its
  own progress in the corner; it now tracks the actual loading
  progress.
- A short-lived change could strand players on a black screen when
  signing in took longer than the game load; it has been reverted
  and the handover from loading to login is clean again.

### Notes

- Everything from 0.1.0 — the Discord-gated login, the character
  creator, the selector, spawning and disconnect saving — behaves
  exactly as before; this release builds on top of it. Movement
  commands, inventory, vehicles, the economy, and the injury and
  death systems land in upcoming releases.
- Plus internal logging, tuning and groundwork behind the scenes
  with no in-game effect.

## [0.2.0] - 2026-05-29

### Added

- In-game chat. A chat panel now sits in the top-left corner of your
  screen and shows every line the server sends, in full colour. Press
  T to open the input bar; Enter sends your message, Tab fills in the
  highlighted command suggestion, Esc cancels, and PageUp / PageDown
  scroll back through older lines while you type. Chat is on screen
  from the moment you log in — the welcome line, the server notice,
  and /help replies are all readable before you have even picked a
  character — but you can only type once your character has spawned.
  The panel also steps aside while you are naming or designing a new
  character, so the creation screens get your full attention.
- Chat commands with proper feedback. Every slash command now runs
  through a single server-side system that knows each command's
  aliases, its staff-rank requirement, whether it needs a spawned
  character, and any cooldown. Mistype a command, lack the rank, try
  it while off duty, or fire it too quickly, and chat tells you
  exactly what went wrong. The server also decides for itself who
  sent each command, so a modified client cannot pose as another
  player.
- /help. Lists every command available to you, grouped by category —
  Chat, RP, Comms, Utility, and Admin — inside the same
  emerald-framed block the server uses for its other info displays.
  Your chat box also receives the full command list the moment you
  spawn, so autocomplete suggestions work from your first keystroke.
- /changecharacter (aliases: /changechar, /switchcharacter,
  /switchchar). Switch characters without leaving the server. Your
  current character's position, facing, health, armour, mask, cash,
  bank balance, and injury and bleeding state are all saved first;
  you vanish from the world, your chat is wiped clean, and you land
  back on the character selector with a freshly updated list.
- /logout (alias: /signout). Does everything /changecharacter does,
  then signs you out of your account entirely and returns you to the
  login screen — without dropping your connection. Click Enter Server
  again and you are back at the selector with no reconnect needed.
- Welcome line. The first thing you see in chat after joining is
  "Welcome to Legacy.mp - Roleplay" followed by your Discord display
  name, with the ".mp" accented in emerald and the whole line wrapped
  in (( )) as out-of-character narration.
- Server notice on join. Right after the welcome line, chat shows a
  fixed disclaimer: the server is non-monetised; it is not affiliated
  with Rockstar Games, Take-Two Interactive, or any of their parent
  companies, subsidiaries, or rights holders; you must be of legal
  adult age in your country of residence; roleplay may depict
  violence, injury, and other content unsuitable for minors; and
  continuing to play means you accept all server rules.
- Spawn welcome card. The first thing a freshly spawned character
  sees is a "Welcome Back" card listing your character's first and
  last name with your Discord display name in parentheses, your
  player ID, your staff rank if you hold one, and your premium tier
  with its expiry date if you have one. Chat is cleared just before
  the card lands, so the panel starts uncluttered.
- Account settings that follow you. Your preferences — currently the
  Theme Mode picker (Light / Dark / System) — are saved to your
  account on the server the instant you change them, and your chosen
  theme appears immediately on every screen, including the brief
  moment right after login.
- Cancel character creation. If you already own at least one
  character, you can back out of the naming or design screens and
  return to the selector without creating anything. Accounts with no
  characters yet do not see the Cancel option — finishing the wizard
  is the only way forward.
- A real loading screen. The previously blank loading screen now
  shows a centred brand logo over a darkened backdrop, with an
  emerald progress bar pinned to the bottom centre. The bar follows
  the actual game load and its label tells you which loading phase
  you are in. The game's default spinner in the bottom-right corner
  has been switched off, so the bar is the only progress display.

### Changed

- Your theme choice now lives on your account rather than in your
  browser, so it survives logging out, reconnecting, and switching
  machines.
- Plus internal logging and diagnostics tidy-up behind the scenes.

### Fixed

- The loading-screen progress bar sat frozen at 0% while the game's
  own spinner painted the real progress over the top of it. The bar
  now tracks the actual load on its own.
- An earlier attempt to hold the loading screen up until login was
  ready could strand you on a black screen whenever login took longer
  than the game itself. The loading screen now dismisses itself as
  soon as the game has finished loading.

### Notes

- This release builds on 0.1.0 without touching it: Discord-gated
  login, the character creator, the selector, spawning, the
  anti-teleport check, and save-on-disconnect all behave exactly as
  before. In-world systems — movement commands, in-character chat
  channels, inventory, vehicles, economy, injury and death — still
  arrive in later releases.

## [0.1.0] - 2026-05-28

### Added

- Discord-gated login. Connecting to the server runs an identity check
  against your linked Discord account: you must be logged in to Discord
  on the same machine and a member of the server's guild. The welcome
  card renders your Discord display name and avatar before the Enter
  Server button. Accounts that are pending approval are held with a
  link to the roleplay-quiz UCP; banned accounts are kicked outright.
  Reconnecting from another session kicks the previous one — only one
  active session per account.
- Character creation wizard. A multi-page flow covering Heritage
  (parent blend + skin tone + eye colour), four facial-morph pages
  (jaw, nose, brow, lips), five skin overlay sliders (blemishes,
  ageing, complexion, sun damage, moles & freckles), Hair Style /
  Colour / Highlight, Hair Decals, Eyebrows, plus Male-only Facial
  Hair and Chest Hair pages. Each page applies live to the ped you
  see on the right side of the screen as you drag sliders, with
  Camera Rotation / Zoom / Height / Slide controls for inspecting
  your work. A Randomize button on the first page rerolls every
  appearance slider at once (face features clamped to a human-shaped
  range, eyebrows never roll to "None") while preserving your camera
  framing and any clothing you've already picked.
- Outfit wizard tail. The final wizard pages walk every clothing
  category — Shirts, Undershirt, Pants, Shoes, Hat, Glasses, Earrings,
  Watches, Bracelets, Mask, Bag, Decals, Body Armour — each with its
  own Drawable and Texture sliders. The slider maxima auto-fit the
  GTA variation count for the freemode ped you picked, so you can
  walk every legitimate variant without overshooting into invalid
  drawables. The starting outfit you pick at creation persists as
  your character's default wardrobe entry.
- Character selector. Accounts that already own at least one
  character land on a selector screen after login instead of being
  forced back into the creator. Each row shows the character's name,
  slot number, gender, and last-played date, with a Play button per
  row and a Create New Character button at the bottom. Picking Play
  spawns the chosen character into the world; clicking a character
  you don't own is silently rejected by the server.
- Auto-spawn after creation. Finishing the creator wizard drops you
  straight into the world at your character's saved spawn — no extra
  Play click, no detour through the selector. New characters spawn
  at Los Santos International Airport (the apron south of the main
  terminal). Returning characters spawn at the position they last
  disconnected from.
- Spawn transition fades. The handoff from the auth-shell camera to
  in-world is wrapped in a fade-out / fade-in so the model swap and
  teleport happen off-screen. The gameplay camera reattaches behind
  the ped at the spawn coord rather than carrying a stale angle from
  the previous scene.
- HUD and minimap stay disabled through spawn. The chrome is hidden
  during the auth shell and never turned back on during the spawn
  pipeline. A future settings surface can re-enable them when one
  ships.
- Character persistence on disconnect. When you leave the server,
  your character's current position, heading, world, HP and armour
  are captured server-side (validated against a moving-average
  position checker, which throws out implausible teleports during
  the session), and your mask state, cash, bank balance, injury
  status and bleeding status are flushed from the in-memory session
  cache in a single database write. Reconnecting lands you where
  you logged off in the same condition.
- Server-side anti-teleport position validator. A 2-second tick
  watches every spawned player and discards any position delta over
  200 metres per tick — covers all legitimate vehicles (including
  jets ramping up smoothly) but catches obvious teleport hacks
  mid-session. The last validated position is what gets saved on
  disconnect, so any in-flight hack at the moment of quitting is
  dropped in favour of the last verified coord. A 5-second grace
  window around spawn absorbs slow client model loads without false
  positives.

### Notes

- This is the first tagged release. Auth, character creator, character
  selector, spawn, and disconnect persistence are functional end-to-end;
  in-world systems (movement commands, chat, inventory, vehicles,
  economy transactions, injury / death) are not yet shipped and land
  in subsequent releases.
