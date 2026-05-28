# Changelog

All notable changes to this project are listed here, newest first.
This project follows [Keep a Changelog](https://keepachangelog.com/) and uses
[Semantic Versioning](https://semver.org/).

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
