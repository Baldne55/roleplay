/**
 * Outfit constants. Ported from roleplay_ragemp's
 * `CEF/src/Features/Identity/Outfit/Shop/Data/OutfitShop.ts`.
 *
 * The fourteen categories below cover every clothing component + prop the
 * legacy boutique exposed. The slot indices match GTA V's component / prop
 * native enumeration verbatim - the renames here are PascalCase identifier
 * surface only; runtime semantics are unchanged.
 *
 * Components vs Props are two separate native APIs (SetPedComponentVariation
 * vs SetPedPropIndex / ClearPedProp), but both share the same
 * `{ Drawable, Texture }` payload shape; a Drawable of -1 on a Prop is the
 * "no prop equipped" sentinel handled by the Frontend on apply.
 */

export type ComponentType = 'Component' | 'Prop';

/**
 * Static category catalog. `Id` is the stable key used both as the slider
 * prefix (`<Id>_Drawable` / `<Id>_Texture`) and the OutfitData record key.
 * `Index` is the GTA V slot. The Type discriminates which native bucket
 * the Frontend uses on apply.
 */
export interface ClothingCategory {
  Id: string;
  Label: string;
  Index: number;
  Type: ComponentType;
}

export const ClothingCategories: readonly ClothingCategory[] = [
  { Id: 'Shirts',      Label: 'Shirts',      Index: 11, Type: 'Component' },
  { Id: 'Undershirts', Label: 'Undershirt',  Index: 8,  Type: 'Component' },
  { Id: 'Pants',       Label: 'Pants',       Index: 4,  Type: 'Component' },
  { Id: 'Shoes',       Label: 'Shoes',       Index: 6,  Type: 'Component' },
  { Id: 'Torsos',      Label: 'Torso',       Index: 3,  Type: 'Component' },
  { Id: 'Hats',        Label: 'Hats',        Index: 0,  Type: 'Prop' },
  { Id: 'Glasses',     Label: 'Glasses',     Index: 1,  Type: 'Prop' },
  { Id: 'Ears',        Label: 'Ears',        Index: 2,  Type: 'Prop' },
  { Id: 'Watches',     Label: 'Watches',     Index: 6,  Type: 'Prop' },
  { Id: 'Bracelets',   Label: 'Bracelets',   Index: 7,  Type: 'Prop' },
  { Id: 'Accessories', Label: 'Accessories', Index: 7,  Type: 'Component' },
  { Id: 'Decals',      Label: 'Decals',      Index: 10, Type: 'Component' },
  { Id: 'Hands',       Label: 'Hands',       Index: 5,  Type: 'Component' },
  { Id: 'Armour',      Label: 'Armour',      Index: 9,  Type: 'Component' },
];

/**
 * One slot of an outfit. Same shape for components and props - the only
 * semantic split is the Props sentinel: Drawable = -1 means "no prop
 * equipped" and triggers ClearPedProp on apply.
 */
export interface ComponentSlot {
  Drawable: number;
  Texture: number;
}

/**
 * Full outfit blob persisted on `character_outfits.outfit_data`. Keyed by
 * `ClothingCategory.Id` within each bucket; the buckets stay separate so
 * the Frontend can iterate without re-checking the category Type.
 */
export interface OutfitData {
  Components: Record<string, ComponentSlot>;
  Props: Record<string, ComponentSlot>;
}

/**
 * Skin model hashes used by the legacy outfit shop's drawable lookup. Kept
 * here for downstream features that need to discriminate per-gender;
 * unused by the wizard apply path itself.
 */
export const SkinMaleHash = 1885233650;
export const SkinFemaleHash = -1667301416;

/**
 * Identity outfit - every component starts at drawable 0 / texture 0, and
 * every prop starts unequipped (drawable -1). Matches the legacy boutique
 * "no clothing selected" baseline so the freshly-loaded freemode ped is
 * dressed in default zero-index gear.
 */
export function DefaultOutfitData(): OutfitData {
  const Components: Record<string, ComponentSlot> = {};
  const Props: Record<string, ComponentSlot> = {};
  for (const Category of ClothingCategories) {
    if (Category.Type === 'Component') {
      Components[Category.Id] = { Drawable: 0, Texture: 0 };
    } else {
      Props[Category.Id] = { Drawable: -1, Texture: 0 };
    }
  }
  return { Components, Props };
}

/**
 * Outfit-name validation for the wider Wardrobe feature. The wizard's
 * default outfit is created server-side with a fixed name ("Default") so
 * the regex never applies at creation time; published here for the future
 * rename / create-new flows.
 *
 * Allows alphanumerics, hyphens and spaces; rejects leading or trailing
 * spaces so a stored name does not appear empty in lists.
 */
export const OutfitNameRegex = /^[a-zA-Z0-9-](?:[a-zA-Z0-9- ]*[a-zA-Z0-9-])?$/;
export const OutfitNameMaxLength = 32;
