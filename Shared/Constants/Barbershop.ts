/**
 * Barbershop constants. Ported from roleplay_ragemp's
 * `CEF/src/Features/Identity/Appearance/Data/Barbershop.ts`.
 *
 * Hair lists carry the GTA V drawable IDs. Note non-contiguous gaps
 * (male list jumps from 22 -> 24 and again to 72-73; female list jumps
 * from 23 -> 25 and again to 76-77). The barber slider walks the list
 * indices, not the raw drawable IDs - `HairListByGender(Gender)[Index].ID`
 * resolves back to the native drawable on apply.
 *
 * Overlay value arrays mirror the same shape the creator uses for its
 * five exposed overlays (see `OverlayValueLabels` in Character.ts); these
 * are appended onto `OverlayValueLabels` for FacialHair / Eyebrows /
 * ChestHair so a single label catalog drives every slider.
 */

import type { Gender } from './Character.js';

export interface HairEntry {
  /** GTA V drawable variation index. */
  ID: number;
  Name: string;
}

export const MaleHairList: readonly HairEntry[] = [
  { ID: 0, Name: 'None' },
  { ID: 1, Name: 'Buzzcut' },
  { ID: 2, Name: 'Faux Hawk' },
  { ID: 3, Name: 'Hipster' },
  { ID: 4, Name: 'Side Parting' },
  { ID: 5, Name: 'Shorter Cut' },
  { ID: 6, Name: 'Biker' },
  { ID: 7, Name: 'Ponytail' },
  { ID: 8, Name: 'Cornrows' },
  { ID: 9, Name: 'Slicked' },
  { ID: 10, Name: 'Short Brushed' },
  { ID: 11, Name: 'Spikey' },
  { ID: 12, Name: 'Caesar' },
  { ID: 13, Name: 'Chopped' },
  { ID: 14, Name: 'Dreads' },
  { ID: 15, Name: 'Long Hair' },
  { ID: 16, Name: 'Shaggy Curls' },
  { ID: 17, Name: 'Surfer Dude' },
  { ID: 18, Name: 'Short Side Part' },
  { ID: 19, Name: 'High Slicked Sides' },
  { ID: 20, Name: 'Long Slicked' },
  { ID: 21, Name: 'Hipster Youth' },
  { ID: 22, Name: 'Mullet' },
  { ID: 24, Name: 'Classic Cornrows' },
  { ID: 25, Name: 'Palm Cornrows' },
  { ID: 26, Name: 'Lightning Cornrows' },
  { ID: 27, Name: 'Whipped Cornrows' },
  { ID: 28, Name: 'Zig Zag Cornrows' },
  { ID: 29, Name: 'Snail Cornrows' },
  { ID: 30, Name: 'Hightop' },
  { ID: 31, Name: 'Loose Swept Back' },
  { ID: 32, Name: 'Undercut Swept Back' },
  { ID: 33, Name: 'Undercut Swept Side' },
  { ID: 34, Name: 'Spiked Mohawk' },
  { ID: 35, Name: 'Mod' },
  { ID: 36, Name: 'Layered Mod' },
  { ID: 72, Name: 'Flattop' },
  { ID: 73, Name: 'Military Buzzcut' },
];

export const FemaleHairList: readonly HairEntry[] = [
  { ID: 0, Name: 'None' },
  { ID: 1, Name: 'Short' },
  { ID: 2, Name: 'Layered Bob' },
  { ID: 3, Name: 'Pigtails' },
  { ID: 4, Name: 'Ponytail' },
  { ID: 5, Name: 'Braided Mohawk' },
  { ID: 6, Name: 'Braids' },
  { ID: 7, Name: 'Bob' },
  { ID: 8, Name: 'Faux Hawk' },
  { ID: 9, Name: 'French Twist' },
  { ID: 10, Name: 'Long Bob' },
  { ID: 11, Name: 'Loose Tied' },
  { ID: 12, Name: 'Pixie' },
  { ID: 13, Name: 'Shaved Bangs' },
  { ID: 14, Name: 'Top Knot' },
  { ID: 15, Name: 'Wavy Bob' },
  { ID: 16, Name: 'Messy Bun' },
  { ID: 17, Name: 'Pin Up Girl' },
  { ID: 18, Name: 'Tight Bun' },
  { ID: 19, Name: 'Twisted Bob' },
  { ID: 20, Name: 'Flapper Bob' },
  { ID: 21, Name: 'Big Bangs' },
  { ID: 22, Name: 'Braided Top Knot' },
  { ID: 23, Name: 'Mullet' },
  { ID: 25, Name: 'Pinched Cornrows' },
  { ID: 26, Name: 'Leaf Cornrows' },
  { ID: 27, Name: 'Zig Zag Cornrows' },
  { ID: 28, Name: 'Pigtail Bangs' },
  { ID: 29, Name: 'Wave Braids' },
  { ID: 30, Name: 'Coil Braids' },
  { ID: 31, Name: 'Rolled Quiff' },
  { ID: 32, Name: 'Loose Swept Back' },
  { ID: 33, Name: 'Undercut Swept Back' },
  { ID: 34, Name: 'Undercut Swept Side' },
  { ID: 35, Name: 'Spiked Mohawk' },
  { ID: 36, Name: 'Bandana and Braid' },
  { ID: 37, Name: 'Layered Mod' },
  { ID: 38, Name: 'Skinbyrd' },
  { ID: 76, Name: 'Neat Bun' },
  { ID: 77, Name: 'Short Bob' },
];

export function HairListByGender(Gender: Gender): readonly HairEntry[] {
  return Gender === 'Female' ? FemaleHairList : MaleHairList;
}

export function FindHairName(ID: number, IsFemale: boolean): string | null {
  const List = IsFemale ? FemaleHairList : MaleHairList;
  const Entry = List.find((H) => H.ID === ID);
  return Entry !== undefined ? Entry.Name : null;
}

export const MaleHairDecalNames: readonly string[] = [
  'Close Shave', 'Buzzcut', 'Faux Hawk', 'Hipster', 'Side Parting', 'Shorter Cut', 'Biker',
  'Ponytail', 'Cornrows', 'Slicked', 'Short Brushed', 'Spikey', 'Caesar', 'Chopped', 'Dreads',
  'Long Hair', 'Shaggy Curls', 'Surfer Dude', 'Short Side Part', 'High Slicked Sides',
  'Long Slicked', 'Hipster Youth', 'Mullet', 'Classic Cornrows', 'Palm Cornrows',
  'Lightning Cornrows', 'Whipped Cornrows', 'Zig Zag Cornrows', 'Snail Cornrows', 'Hightop',
  'Loose Swept Back', 'Undercut Swept Back', 'Undercut Swept Side', 'Spiked Mohawk', 'Mod',
  'Layered Mod', 'Flattop', 'Military Buzzcut',
];

export const FemaleHairDecalNames: readonly string[] = [
  'Close Shave', 'Short', 'Layered Bob', 'Pigtails', 'Ponytail', 'Braided Mohawk', 'Braids',
  'Bob', 'Faux Hawk', 'French Twist', 'Long Bob', 'Loose Tied', 'Pixie', 'Shaved Bangs',
  'Top Knot', 'Wavy Bob', 'Messy Bun', 'Pin Up Girl', 'Tight Bun', 'Twisted Bob', 'Flapper Bob',
  'Big Bangs', 'Braided Top Knot', 'Mullet', 'Pinched Cornrows', 'Leaf Cornrows',
  'Zig Zag Cornrows', 'Pigtail Bangs', 'Wave Braids', 'Coil Braids', 'Rolled Quiff',
  'Loose Swept Back', 'Undercut Swept Back', 'Undercut Swept Side', 'Spiked Mohawk',
  'Bandana and Braid', 'Layered Mod', 'Skinbyrd', 'Neat Bun', 'Short Bob',
];

export function HairDecalNamesByGender(Gender: Gender): readonly string[] {
  return Gender === 'Female' ? FemaleHairDecalNames : MaleHairDecalNames;
}

/**
 * GTA decal collection/overlay names for each hair-decal index. The
 * native side resolves these to hashes via `GetHashKey` and applies
 * them through `AddPedDecorationFromHashes`. Index here matches the
 * `Hair.Decal.Index` stored on AppearanceData (after the slider-0 ->
 * 255 off-by-one): index 0 = first entry, ..., index 37 (male) /
 * index 39 (female) = last entry. Index 255 is the sentinel for "no
 * decal" and skips the native call.
 *
 * Ported verbatim from ragemp Manager.ts `hairDecalsList`. A handful
 * of female slots intentionally reuse male overlays (`NG_M_Hair_014`,
 * `NG_M_Hair_015`) - kept as-is to preserve the legacy look.
 */
export interface HairDecalEntry {
  Name: string;
  Collection: string;
  Overlay: string;
}

export const MaleHairDecals: readonly HairDecalEntry[] = [
  { Name: 'Close Shave', Collection: 'mpbeach_overlays', Overlay: 'FM_Hair_Fuzz' },
  { Name: 'Buzzcut', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_001' },
  { Name: 'Faux Hawk', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_002' },
  { Name: 'Hipster', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_003' },
  { Name: 'Side Parting', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_004' },
  { Name: 'Shorter Cut', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_005' },
  { Name: 'Biker', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_006' },
  { Name: 'Ponytail', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_007' },
  { Name: 'Cornrows', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_008' },
  { Name: 'Slicked', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_009' },
  { Name: 'Short Brushed', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_013' },
  { Name: 'Spikey', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_002' },
  { Name: 'Caesar', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_011' },
  { Name: 'Chopped', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_012' },
  { Name: 'Dreads', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_014' },
  { Name: 'Long Hair', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_015' },
  { Name: 'Shaggy Curls', Collection: 'multiplayer_overlays', Overlay: 'NGBea_M_Hair_000' },
  { Name: 'Surfer Dude', Collection: 'multiplayer_overlays', Overlay: 'NGBea_M_Hair_001' },
  { Name: 'Short Side Part', Collection: 'multiplayer_overlays', Overlay: 'NGBus_M_Hair_000' },
  { Name: 'High Slicked Sides', Collection: 'multiplayer_overlays', Overlay: 'NGBus_M_Hair_001' },
  { Name: 'Long Slicked', Collection: 'multiplayer_overlays', Overlay: 'NGHip_M_Hair_000' },
  { Name: 'Hipster Youth', Collection: 'multiplayer_overlays', Overlay: 'NGHip_M_Hair_001' },
  { Name: 'Mullet', Collection: 'multiplayer_overlays', Overlay: 'NGInd_M_Hair_000' },
  { Name: 'Classic Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_M_Hair_000' },
  { Name: 'Palm Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_M_Hair_001' },
  { Name: 'Lightning Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_M_Hair_002' },
  { Name: 'Whipped Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_M_Hair_003' },
  { Name: 'Zig Zag Cornrows', Collection: 'mplowrider2_overlays', Overlay: 'LR_M_Hair_004' },
  { Name: 'Snail Cornrows', Collection: 'mplowrider2_overlays', Overlay: 'LR_M_Hair_005' },
  { Name: 'Hightop', Collection: 'mplowrider2_overlays', Overlay: 'LR_M_Hair_006' },
  { Name: 'Loose Swept Back', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_000_M' },
  { Name: 'Undercut Swept Back', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_001_M' },
  { Name: 'Undercut Swept Side', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_002_M' },
  { Name: 'Spiked Mohawk', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_003_M' },
  { Name: 'Mod', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_004_M' },
  { Name: 'Layered Mod', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_005_M' },
  { Name: 'Flattop', Collection: 'mpgunrunning_overlays', Overlay: 'MP_Gunrunning_Hair_M_000_M' },
  { Name: 'Military Buzzcut', Collection: 'mpgunrunning_overlays', Overlay: 'MP_Gunrunning_Hair_M_001_M' },
];

export const FemaleHairDecals: readonly HairDecalEntry[] = [
  { Name: 'Close Shave', Collection: 'mpbeach_overlays', Overlay: 'FM_Hair_Fuzz' },
  { Name: 'Short', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_001' },
  { Name: 'Layered Bob', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_002' },
  { Name: 'Pigtails', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_003' },
  { Name: 'Ponytail', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_004' },
  { Name: 'Braided Mohawk', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_005' },
  { Name: 'Braids', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_006' },
  { Name: 'Bob', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_007' },
  { Name: 'Faux Hawk', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_008' },
  { Name: 'French Twist', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_009' },
  { Name: 'Long Bob', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_010' },
  { Name: 'Loose Tied', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_011' },
  { Name: 'Pixie', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_012' },
  { Name: 'Shaved Bangs', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_013' },
  { Name: 'Top Knot', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_014' },
  { Name: 'Wavy Bob', Collection: 'multiplayer_overlays', Overlay: 'NG_M_Hair_015' },
  { Name: 'Messy Bun', Collection: 'multiplayer_overlays', Overlay: 'NGBea_F_Hair_000' },
  { Name: 'Pin Up Girl', Collection: 'multiplayer_overlays', Overlay: 'NGBea_F_Hair_001' },
  { Name: 'Tight Bun', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_007' },
  { Name: 'Twisted Bob', Collection: 'multiplayer_overlays', Overlay: 'NGBus_F_Hair_000' },
  { Name: 'Flapper Bob', Collection: 'multiplayer_overlays', Overlay: 'NGBus_F_Hair_001' },
  { Name: 'Big Bangs', Collection: 'multiplayer_overlays', Overlay: 'NGBea_F_Hair_001' },
  { Name: 'Braided Top Knot', Collection: 'multiplayer_overlays', Overlay: 'NGHip_F_Hair_000' },
  { Name: 'Mullet', Collection: 'multiplayer_overlays', Overlay: 'NGInd_F_Hair_000' },
  { Name: 'Pinched Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_F_Hair_000' },
  { Name: 'Leaf Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_F_Hair_001' },
  { Name: 'Zig Zag Cornrows', Collection: 'mplowrider_overlays', Overlay: 'LR_F_Hair_002' },
  { Name: 'Pigtail Bangs', Collection: 'mplowrider2_overlays', Overlay: 'LR_F_Hair_003' },
  { Name: 'Wave Braids', Collection: 'mplowrider2_overlays', Overlay: 'LR_F_Hair_003' },
  { Name: 'Coil Braids', Collection: 'mplowrider2_overlays', Overlay: 'LR_F_Hair_004' },
  { Name: 'Rolled Quiff', Collection: 'mplowrider2_overlays', Overlay: 'LR_F_Hair_006' },
  { Name: 'Loose Swept Back', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_000_F' },
  { Name: 'Undercut Swept Back', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_001_F' },
  { Name: 'Undercut Swept Side', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_002_F' },
  { Name: 'Spiked Mohawk', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_003_F' },
  { Name: 'Bandana and Braid', Collection: 'multiplayer_overlays', Overlay: 'NG_F_Hair_003' },
  { Name: 'Layered Mod', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_006_F' },
  { Name: 'Skinbyrd', Collection: 'mpbiker_overlays', Overlay: 'MP_Biker_Hair_004_F' },
  { Name: 'Neat Bun', Collection: 'mpgunrunning_overlays', Overlay: 'MP_Gunrunning_Hair_F_000_F' },
  { Name: 'Short Bob', Collection: 'mpgunrunning_overlays', Overlay: 'MP_Gunrunning_Hair_F_001_F' },
];

export function HairDecalsByGender(Gender: Gender): readonly HairDecalEntry[] {
  return Gender === 'Female' ? FemaleHairDecals : MaleHairDecals;
}

export const FacialHairValues: readonly string[] = [
  'None', 'Light Stubble', 'Balbo', 'Circle Beard', 'Goatee', 'Chin', 'Chin Fuzz',
  'Pencil Chin Strap', 'Scruffy', 'Musketeer', 'Mustache', 'Trimmed Beard', 'Stubble',
  'Thin Circle Beard', 'Horseshoe', "Pencil and 'Chops", 'Chin Strap Beard',
  'Balbo and Sideburns', 'Mutton Chops', 'Scruffy Beard', 'Curly', 'Curly & Deep Stranger',
  'Handlebar', 'Faustic', 'Otto & Patch', 'Otto & Full Stranger', 'Light Franz',
  'The Hampstead', 'The Ambrose', 'Lincoln Curtain',
];

export const EyebrowValues: readonly string[] = [
  'None', 'Balanced', 'Fashion', 'Cleopatra', 'Quizzical', 'Femme', 'Seductive', 'Pinched',
  'Chola', 'Triomphe', 'Carefree', 'Curvaceous', 'Rodent', 'Double Tram', 'Thin', 'Penciled',
  'Mother Plucker', 'Straight and Narrow', 'Natural', 'Fuzzy', 'Unkempt', 'Caterpillar',
  'Regular', 'Mediterranean', 'Groomed', 'Bushels', 'Feathered', 'Prickly', 'Monobrow',
  'Winged', 'Triple Tram', 'Arched Tram', 'Cutouts', 'Fade Away', 'Solo Tram',
];

export const ChestHairValues: readonly string[] = [
  'None', 'Natural', 'The Strip', 'The Tree', 'Hairy', 'Grisly', 'Ape', 'Groomed Ape',
  'Bikini', 'Lightning Bolt', 'Reverse Lightning', 'Love Heart', 'Chestache', 'Happy Face',
  'Skull', 'Snail Trail', 'Slug and Nips', 'Hairy Arms',
];

/**
 * Legacy quirk preserved verbatim: ragemp's data.js exports
 * `maxHairColor: 64`, but Barbershop.js shadows it with a local
 * `var maxHairColor = 63` at runtime. The in-game palette uses 63.
 */
export const MaxHairColor = 63;

/**
 * Highest valid HairVariation slider value. GTA's variation count is
 * style-dependent (`GetNumberOfPedDrawableVariations` returns 1..N) - the
 * ragemp UI defaults to 1 until the host pushes the per-style maximum
 * back via `setHairVariationMax`. We park it at 1 here too; the slider
 * stays in-range for every style and pushes via Hair.Highlight will fall
 * back to 0 when 1 is out of range for the native.
 */
export const MaxHairVariation = 1;
