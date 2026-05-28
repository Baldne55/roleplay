/**
 * Character constants. Single source of truth for validation rules and
 * the creation-wizard structure, shared between server (controllers /
 * services) and UI (form hints + client-side pre-validation). The DB
 * enforces the same set via ENUM columns + UNIQUE indexes; whenever
 * this file changes, double-check the matching migration.
 *
 * Wizard structure ports the layout of `roleplay_ragemp`'s
 * CharacterCreator.ts verbatim: ten Heritage sliders (three Shape
 * parents + three Skin parents + Model/Skin/Override mixes + Eye
 * Color), four facial-morph pages, and a five-overlay Appearances
 * page. Slider IDs are PascalCase per project naming policy.
 */

import {
  ChestHairValues,
  EyebrowValues,
  FacialHairValues,
  HairDecalNamesByGender,
  HairListByGender,
  MaxHairColor,
} from './Barbershop.js';
import {
  ClothingCategories,
  DefaultOutfitData,
  type ComponentSlot,
  type OutfitData,
} from './Outfit.js';

export type Gender = 'Male' | 'Female';
export const Genders: readonly Gender[] = ['Male', 'Female'];

export type BloodType = 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
export const BloodTypes: readonly BloodType[] = [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
];

export type CharacterStatus = 'Active' | 'Deleted';

export type InjuryStatus = 'Healthy' | 'Unconscious' | 'BadlyWounded' | 'Dead';

export type BleedingStatus =
  | 'NotBleeding'
  | 'LightBleeding'
  | 'MediumBleeding'
  | 'HeavyBleeding';

/**
 * GTA freemode facial-feature overlay slots. Each slot stores
 * `{ Index, Opacity, Color }` on the AppearanceData JSON blob. The
 * creation wizard only exposes five of these (Blemishes / Ageing /
 * Complexion / SunDamage / MolesFreckles) - the rest belong to a
 * future barbershop scene.
 */
export type OverlayName =
  | 'Blemishes'
  | 'FacialHair'
  | 'Eyebrows'
  | 'Ageing'
  | 'Makeup'
  | 'Blush'
  | 'Complexion'
  | 'SunDamage'
  | 'Lipstick'
  | 'MolesFreckles'
  | 'ChestHair'
  | 'BodyBlemishes'
  | 'AddBodyBlemishes';

export const OverlayNames: readonly OverlayName[] = [
  'Blemishes',
  'FacialHair',
  'Eyebrows',
  'Ageing',
  'Makeup',
  'Blush',
  'Complexion',
  'SunDamage',
  'Lipstick',
  'MolesFreckles',
  'ChestHair',
  'BodyBlemishes',
  'AddBodyBlemishes',
];

/**
 * Map an OverlayName to its GTA native overlay-id. Used by the Frontend
 * preview service when calling SetPedHeadOverlay. Order matches GTA's
 * own enum so the mapping is one-to-one with the native id.
 */
export const OverlayNativeID: Record<OverlayName, number> = {
  Blemishes: 0,
  FacialHair: 1,
  Eyebrows: 2,
  Ageing: 3,
  Makeup: 4,
  Blush: 5,
  Complexion: 6,
  SunDamage: 7,
  Lipstick: 8,
  MolesFreckles: 9,
  ChestHair: 10,
  BodyBlemishes: 11,
  AddBodyBlemishes: 12,
};

/**
 * GTA SetPedFaceFeature slots (0..19). Each value is a float clamped
 * to -1.0..1.0 representing the morph intensity. The named union here
 * keeps storage + UI from hard-coding magic numbers.
 */
export type FaceFeatureName =
  | 'NoseWidth'
  | 'NosePeakHeight'
  | 'NosePeakLength'
  | 'NoseBoneHeight'
  | 'NosePeakLowering'
  | 'NoseBoneTwist'
  | 'BrowHeight'
  | 'BrowDepth'
  | 'CheekboneHeight'
  | 'CheekboneWidth'
  | 'CheeksWidth'
  | 'EyesOpening'
  | 'LipsThickness'
  | 'JawBoneWidth'
  | 'JawBoneDepth'
  | 'ChinBoneLowering'
  | 'ChinBoneLength'
  | 'ChinBoneWidth'
  | 'ChinHole'
  | 'NeckThickness';

export const FaceFeatureNames: readonly FaceFeatureName[] = [
  'NoseWidth',
  'NosePeakHeight',
  'NosePeakLength',
  'NoseBoneHeight',
  'NosePeakLowering',
  'NoseBoneTwist',
  'BrowHeight',
  'BrowDepth',
  'CheekboneHeight',
  'CheekboneWidth',
  'CheeksWidth',
  'EyesOpening',
  'LipsThickness',
  'JawBoneWidth',
  'JawBoneDepth',
  'ChinBoneLowering',
  'ChinBoneLength',
  'ChinBoneWidth',
  'ChinHole',
  'NeckThickness',
];

/** GTA native index for a face-feature slot. Index matches the order above. */
export function FaceFeatureNativeID(Name: FaceFeatureName): number {
  return FaceFeatureNames.indexOf(Name);
}

/**
 * Strict-formal name policy: English letters only, leading capital, no
 * apostrophes / hyphens / spaces / digits. Enforced per part (FirstName
 * and LastName independently). Rejects "O'Brien", "Mary-Anne",
 * "McDonald" - flag if/when we want to relax.
 */
export const NameRegex = /^[A-Z][a-z]+$/;
export const NameMinLength = 2;
export const NameMaxLength = 32;

/** Inclusive bounds for character age in years. Derived from BirthDate. */
export const MinAge = 18;
export const MaxAge = 100;

/** Required at creation; bounds picked so the slider feels human. */
export const MinHeightCm = 140;
export const MaxHeightCm = 220;
export const MinWeightKg = 40;
export const MaxWeightKg = 200;

/**
 * Crockford base32 charset for forensic IDs (Mask / DNA / Fingerprint /
 * SSN) and bank account numbers. Excludes I, L, O, U so handwritten and
 * spoken IDs stay unambiguous (no 0/O, no 1/I/L confusion).
 */
export const ForensicIDCharset = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ForensicIDLength = 10;

/**
 * Typed shape of `Character.AppearanceData` (stored as JSON in DB).
 * Heritage carries three parents per channel (shape + skin) plus three
 * blend ratios so the full SetPedHeadBlendData native is reachable.
 * Clothing + props live on a future Wardrobe / Outfit table, not here.
 */
export interface AppearanceData {
  Heritage: {
    /** Three shape-parent face indices (0..45). The wizard exposes all three. */
    ShapeParents: [number, number, number];
    /** Three skin-parent face indices (0..45). The wizard exposes all three. */
    SkinParents: [number, number, number];
    /** Shape blend between ShapeParents[0] and ShapeParents[1] (0..1). */
    ShapeMix: number;
    /** Skin blend between SkinParents[0] and SkinParents[1] (0..1). */
    SkinMix: number;
    /** Third-parent override blend (0..1). 0 = ignore parent #3. */
    OverrideMix: number;
  };
  Hair: {
    Style: number;
    Color: number;
    Highlight: number;
    /**
     * Optional hair-decal overlay. `Index` = decal slot; 255 means "no
     * decal". `Opacity` = 0..1. The native side resolves the decal
     * collection/overlay strings on apply.
     */
    Decal: { Index: number; Opacity: number };
  };
  EyeColor: number;
  FaceFeatures: Record<FaceFeatureName, number>;
  /**
   * Per-overlay slot. `Index` = variant choice (or 255 = none).
   * `Opacity` = 0..1. `Color` = 0..63 palette index; meaning depends on
   * the overlay type (hair palette for FacialHair / Eyebrows / ChestHair,
   * makeup palette for Lipstick / Blush / Makeup). The Frontend picks
   * the right ColorType when calling SetPedHeadOverlayColor.
   */
  Overlays: Record<OverlayName, { Index: number; Opacity: number; Color: number }>;
  Tattoos: { Collection: string; Overlay: string }[];
}

/**
 * Wire shape for the camera-control panel on the creator wizard. UI
 * debounces slider drags and POSTs this to the Frontend's
 * CharacterPreviewCamera NUI callback, which re-frames the scripted
 * camera relative to the ped.
 */
export interface PreviewCamera {
  /** Yaw around the ped, degrees, -180..180. */
  Rotation: number;
  /** -1.0..0.2 - negative pulls camera away, positive pushes in. */
  Zoom: number;
  /** -1.65..0.15 - vertical offset relative to ped chest. */
  Height: number;
  /** -0.3..0.3 - lateral offset across the ped (face vs body framing). */
  Slide: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Slider catalog (ported from roleplay_ragemp/CharacterCreator.ts)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Face-name presets - 46 entries used across all six Heritage face
 * sliders. Mirrors GTA's freemode preset face list 1:1.
 */
export const HeritageFaceLabels: readonly string[] = [
  'Benjamin', 'Daniel', 'Joshua', 'Noah', 'Andrew', 'Juan', 'Alex', 'Isaac', 'Evan', 'Ethan',
  'Vincent', 'Angel', 'Diego', 'Adrian', 'Gabriel', 'Michael', 'Santiago', 'Kevin', 'Louis',
  'Samuel', 'Anthony',
  'Hannah', 'Aubrey', 'Jasmine', 'Gisele', 'Amelia', 'Isabella', 'Zoe', 'Ava', 'Camila',
  'Violet', 'Sophia', 'Evelyn', 'Nicole', 'Ashley', 'Grace', 'Brianna', 'Natalie', 'Olivia',
  'Elizabeth', 'Charlotte', 'Emma',
  'Claude', 'Niko', 'John', 'Misty',
];

/**
 * Eye-colour names - 32 entries available, but the legacy UI capped the
 * slider at index 6 to match the legacy in-game behaviour.
 */
export const EyeColorLabels: readonly string[] = [
  'Green', 'Emerald', 'Light Blue', 'Ocean Blue', 'Light Brown', 'Dark Brown', 'Hazel',
  'Dark Gray', 'Light Gray', 'Pink', 'Yellow', 'Purple', 'Blackout', 'Shades of Gray',
  'Tequila Sunrise', 'Atomic', 'Warp', 'ECola', 'Space Ranger', 'Ying Yang', 'Bullseye',
  'Lizard', 'Dragon', 'Extra Terrestrial', 'Goat', 'Smiley', 'Possessed', 'Demon', 'Infected',
  'Alien', 'Undead', 'Zombie',
];

/** Wizard caps the eye-colour slider at this index (legacy parity). */
export const MaxEyeColorSlider = 6;

/**
 * Variant labels per overlay slot. Index in each array maps 1:1 to the
 * GTA native overlay variant index. The wizard exposes the five creator
 * overlays on the Appearances page plus the three barber overlays
 * (FacialHair / Eyebrows / ChestHair) as their own pages.
 */
export const OverlayValueLabels: Partial<Record<OverlayName, readonly string[]>> = {
  Blemishes: [
    'None', 'Measles', 'Pimples', 'Spots', 'Break Out', 'Blackheads', 'Build Up', 'Pustules',
    'Zits', 'Full Acne', 'Acne', 'Cheek Rash', 'Face Rash', 'Picker', 'Puberty', 'Eyesore',
    'Chin Rash', 'Two Face', 'T Zone', 'Greasy', 'Marked', 'Acne Scarring',
    'Full Acne Scarring', 'Cold Sores', 'Impetigo',
  ],
  Ageing: [
    'None', "Crow's Feet", 'First Signs', 'Middle Aged', 'Worry Lines', 'Depression',
    'Distinguished', 'Aged', 'Weathered', 'Wrinkled', 'Sagging', 'Tough Life', 'Vintage',
    'Retired', 'Junkie', 'Geriatric',
  ],
  Complexion: [
    'None', 'Rosy Cheeks', 'Stubble Rash', 'Hot Flush', 'Sunburn', 'Bruised', 'Alcoholic',
    'Patchy', 'Totem', 'Blood Vessels', 'Damaged', 'Pale', 'Ghostly',
  ],
  SunDamage: [
    'None', 'Uneven', 'Sandpaper', 'Patchy', 'Rough', 'Leathery', 'Textured', 'Coarse',
    'Rugged', 'Creased', 'Cracked', 'Gritty',
  ],
  MolesFreckles: [
    'None', 'Cherub', 'All Over', 'Irregular', 'Dot Dash', 'Over the Bridge', 'Baby Doll',
    'Pixie', 'Sun Kissed', 'Beauty Marks', 'Line Up', 'Modelesque', 'Occasional', 'Speckled',
    'Rain Drops', 'Double Dip', 'One Sided', 'Pairs', 'Growth',
  ],
  FacialHair: FacialHairValues,
  Eyebrows: EyebrowValues,
  ChestHair: ChestHairValues,
};

/** The five overlays the character creator exposes (in display order). */
export const CreatorOverlayNames: readonly OverlayName[] = [
  'Blemishes',
  'Ageing',
  'Complexion',
  'SunDamage',
  'MolesFreckles',
];

/**
 * The three barber-style overlays exposed as their own wizard pages
 * (Facial Hair, Eyebrows, Chest Hair). Facial Hair / Chest Hair are
 * gender-gated at page-build time; this list still includes them so the
 * slider-to-AppearanceData converter handles every barber overlay
 * uniformly.
 */
export const BarberOverlayNames: readonly OverlayName[] = [
  'FacialHair',
  'Eyebrows',
  'ChestHair',
];

/**
 * A wizard slider definition. `Id` is the stable identifier for
 * active-slider tracking; the UI is otherwise data-driven from the
 * catalog below.
 */
export interface SliderDef {
  Id: string;
  Label: string;
  Min: number;
  Max: number;
  Step: number;
  /** When set, the slider shows the indexed label instead of the raw number. */
  ValueLabels?: readonly string[];
  /** Appearance overlays expose an opacity sub-slider via popover. */
  HasOpacity?: boolean;
  /** Default value when not randomized and no saved data exists. */
  DefaultValue?: number;
  /** When randomize=true, pick a random integer in [RandomMin, RandomMax] (inclusive). */
  RandomMin?: number;
  RandomMax?: number;
}

export interface PageDef {
  PageId: string;
  Name: string;
  Sliders: SliderDef[];
  /** Heritage page shows Randomize instead of Back. */
  IsFirst?: boolean;
  /** Final page shows Finish instead of Next. */
  IsFinal?: boolean;
}

const ParentMax = HeritageFaceLabels.length - 1;

function FaceSlider(Id: string, Label: string): SliderDef {
  return {
    Id,
    Label,
    Min: 0,
    Max: ParentMax,
    Step: 1,
    ValueLabels: HeritageFaceLabels,
    RandomMin: 0,
    RandomMax: ParentMax,
  };
}

function MorphSlider(Id: string, Label: string): SliderDef {
  return { Id, Label, Min: -100, Max: 100, Step: 1, RandomMin: -100, RandomMax: 100 };
}

const HeritagePage: PageDef = {
  PageId: 'Heritage',
  Name: 'Heritage',
  IsFirst: true,
  Sliders: [
    FaceSlider('ShapeOne', 'Parent One – Shape'),
    FaceSlider('ShapeTwo', 'Parent Two – Shape'),
    FaceSlider('ShapeThree', 'Ancestry – Shape'),
    FaceSlider('SkinOne', 'Parent One – Skin'),
    FaceSlider('SkinTwo', 'Parent Two – Skin'),
    FaceSlider('SkinThree', 'Ancestry – Skin'),
    { Id: 'ShapeMix', Label: 'Model Mix', Min: 0, Max: 100, Step: 1, DefaultValue: 50 },
    { Id: 'SkinMix', Label: 'Skin Color', Min: 0, Max: 100, Step: 1, DefaultValue: 50 },
    { Id: 'OverrideMix', Label: 'Override Mix', Min: 0, Max: 100, Step: 1, DefaultValue: 50 },
    {
      Id: 'EyeColor',
      Label: 'Eye Color',
      Min: 0,
      Max: MaxEyeColorSlider,
      Step: 1,
      ValueLabels: EyeColorLabels,
      RandomMin: 0,
      RandomMax: MaxEyeColorSlider,
    },
  ],
};

const FacialFeaturePages: PageDef[] = [
  {
    PageId: 'UpperFace',
    Name: 'Upper Face',
    Sliders: [
      MorphSlider('BrowHeight', 'Brow Height'),
      MorphSlider('BrowDepth', 'Brow Depth'),
      MorphSlider('EyesOpening', 'Eye Size'),
      MorphSlider('CheekboneHeight', 'Cheekbone Height'),
      MorphSlider('CheekboneWidth', 'Cheekbone Width'),
    ],
  },
  {
    PageId: 'Nose',
    Name: 'Nose',
    Sliders: [
      MorphSlider('NoseWidth', 'Nose Width'),
      MorphSlider('NosePeakHeight', 'Nose Bottom Height'),
      MorphSlider('NosePeakLength', 'Nose Tip Length'),
      MorphSlider('NoseBoneHeight', 'Nose Bridge Depth'),
      MorphSlider('NosePeakLowering', 'Nose Tip Height'),
      MorphSlider('NoseBoneTwist', 'Nose Broken'),
    ],
  },
  {
    PageId: 'LowerFace',
    Name: 'Lower Face',
    Sliders: [
      MorphSlider('LipsThickness', 'Lip Thickness'),
      MorphSlider('CheeksWidth', 'Cheek Depth'),
      MorphSlider('JawBoneWidth', 'Jaw Width'),
      MorphSlider('JawBoneDepth', 'Jaw Shape'),
    ],
  },
  {
    PageId: 'Chin',
    Name: 'Chin',
    Sliders: [
      MorphSlider('ChinBoneLowering', 'Chin Height'),
      MorphSlider('ChinBoneLength', 'Chin Depth'),
      MorphSlider('ChinBoneWidth', 'Chin Width'),
      MorphSlider('ChinHole', 'Chin Indent'),
      MorphSlider('NeckThickness', 'Neck Width'),
    ],
  },
];

const AppearancesPage: PageDef = {
  PageId: 'Appearances',
  Name: 'Appearances',
  Sliders: CreatorOverlayNames.map<SliderDef>((Name) => {
    const Labels = OverlayValueLabels[Name];
    return {
      Id: Name,
      Label: Name === 'SunDamage'
        ? 'Sun Damage'
        : Name === 'MolesFreckles'
          ? 'Moles & Freckles'
          : Name,
      Min: 0,
      Max: (Labels?.length ?? 1) - 1,
      Step: 1,
      HasOpacity: true,
      ...(Labels !== undefined ? { ValueLabels: Labels } : {}),
    };
  }),
};

/**
 * Camera + character rotation. Always visible in the right-hand panel;
 * never randomized.
 */
export const CameraSliders: readonly SliderDef[] = [
  { Id: 'CameraRotation', Label: 'Character Rotation', Min: -180, Max: 180, Step: 10 },
  { Id: 'CameraZoom', Label: 'Camera Zoom', Min: -1.0, Max: 0.2, Step: 0.025 },
  { Id: 'CameraHeight', Label: 'Camera Height', Min: -1.65, Max: 0.15, Step: 0.05 },
  { Id: 'CameraSlide', Label: 'Camera Slide', Min: -0.3, Max: 0.3, Step: 0.025 },
];

const BarberOverlayPageLabels: Record<OverlayName, string> = {
  Blemishes: 'Blemishes',
  FacialHair: 'Facial Hair',
  Eyebrows: 'Eyebrows',
  Ageing: 'Ageing',
  Makeup: 'Makeup',
  Blush: 'Blush',
  Complexion: 'Complexion',
  SunDamage: 'Sun Damage',
  Lipstick: 'Lipstick',
  MolesFreckles: 'Moles & Freckles',
  ChestHair: 'Chest Hair',
  BodyBlemishes: 'Body Blemishes',
  AddBodyBlemishes: 'Additional Body Blemishes',
};

/**
 * Build a barber-style overlay slider (FacialHair / Eyebrows /
 * ChestHair). `RandomMin` controls whether the randomize button can
 * roll the slider to 0 ("None"):
 *   - 0 = allow None (clean-shaven beard / bare chest is normal).
 *   - 1 = require a real variant (a face without eyebrows looks alien).
 */
function BarberOverlaySlider(Name: OverlayName, RandomMin: number): SliderDef {
  const Labels = OverlayValueLabels[Name];
  const Max = (Labels?.length ?? 1) - 1;
  return {
    Id: Name,
    Label: BarberOverlayPageLabels[Name],
    Min: 0,
    Max,
    Step: 1,
    HasOpacity: true,
    RandomMin,
    RandomMax: Max,
    ...(Labels !== undefined ? { ValueLabels: Labels } : {}),
  };
}

function BuildHairPage(Gender: Gender): PageDef {
  const HairList = HairListByGender(Gender);
  const HairLabels = HairList.map((H) => H.Name);
  return {
    PageId: 'Hair',
    Name: 'Hair',
    Sliders: [
      {
        Id: 'HairStyle',
        Label: 'Hair Style',
        Min: 0,
        Max: HairList.length - 1,
        Step: 1,
        ValueLabels: HairLabels,
        RandomMin: 0,
        RandomMax: HairList.length - 1,
      },
      {
        Id: 'HairColor',
        Label: 'Hair Colour',
        Min: 0,
        Max: MaxHairColor,
        Step: 1,
        RandomMin: 0,
        RandomMax: MaxHairColor,
      },
      {
        Id: 'HairHighlight',
        Label: 'Hair Highlight',
        Min: 0,
        Max: MaxHairColor,
        Step: 1,
        RandomMin: 0,
        RandomMax: MaxHairColor,
      },
    ],
  };
}

function BuildHairDecalsPage(Gender: Gender): PageDef {
  const DecalLabels = HairDecalNamesByGender(Gender);
  return {
    PageId: 'HairDecals',
    Name: 'Hair Decals',
    Sliders: [
      {
        Id: 'HairDecal',
        Label: 'Hair Decal',
        Min: 0,
        Max: DecalLabels.length - 1,
        Step: 1,
        ValueLabels: DecalLabels,
        HasOpacity: true,
      },
    ],
  };
}

const FacialHairPage: PageDef = {
  PageId: 'FacialHair',
  Name: 'Facial Hair',
  // RandomMin=0: "None" (clean-shaven) is a normal outcome.
  Sliders: [BarberOverlaySlider('FacialHair', 0)],
};

const EyebrowsPage: PageDef = {
  PageId: 'Eyebrows',
  Name: 'Eyebrows',
  Sliders: [
    // RandomMin=1: never roll "None" - a face without eyebrows is alien.
    BarberOverlaySlider('Eyebrows', 1),
    {
      Id: 'EyebrowsColor',
      Label: 'Eyebrow Colour',
      Min: 0,
      Max: MaxHairColor,
      Step: 1,
      RandomMin: 0,
      RandomMax: MaxHairColor,
    },
  ],
};

const ChestHairPage: PageDef = {
  PageId: 'ChestHair',
  Name: 'Chest Hair',
  // RandomMin=0: "None" (bare chest) is a normal outcome.
  Sliders: [BarberOverlaySlider('ChestHair', 0)],
};

/**
 * Outfit slider page generator. Each ClothingCategory becomes one wizard
 * page with two sliders (Drawable + Texture). Slider Max values are
 * placeholders here - the Frontend pushes the real per-gender drawable
 * count and per-drawable texture count to the UI via a NUI message after
 * the freemode model loads, and the UI reads those bounds at render time.
 *
 * Sliders default to the OutfitData defaults: components start at
 * drawable 0, texture 0; props start at drawable -1 (no prop equipped).
 */
function BuildOutfitPage(Category: (typeof ClothingCategories)[number]): PageDef {
  const IsProp = Category.Type === 'Prop';
  return {
    PageId: `Outfit_${Category.Id}`,
    Name: Category.Label,
    Sliders: [
      {
        Id: `${Category.Id}_Drawable`,
        Label: 'Drawable',
        Min: IsProp ? -1 : 0,
        Max: 0,
        Step: 1,
        DefaultValue: IsProp ? -1 : 0,
      },
      {
        Id: `${Category.Id}_Texture`,
        Label: 'Texture',
        Min: 0,
        Max: 0,
        Step: 1,
        DefaultValue: 0,
      },
    ],
  };
}

/**
 * Build the wizard pages in order. The barber-style pages (Hair, Hair
 * Decals, Facial Hair, Eyebrows, Chest Hair) join the creator flow as
 * additional steps so the player completes one wizard. Facial Hair and
 * Chest Hair only appear for Male peds; the female freemode ped has no
 * native slot for either.
 *
 * The wizard tail is a per-category outfit page (Shirts, Undershirt,
 * Pants, ..., Armour). The very last outfit page carries `IsFinal` so a
 * single Finish button submits the full Appearance + Outfit payload.
 */
export function BuildCreatorPages(Gender: Gender): PageDef[] {
  const Male = Gender === 'Male';
  const Pages: PageDef[] = [
    HeritagePage,
    ...FacialFeaturePages,
    AppearancesPage,
    BuildHairPage(Gender),
    BuildHairDecalsPage(Gender),
    ...(Male ? [FacialHairPage] : []),
    EyebrowsPage,
    ...(Male ? [ChestHairPage] : []),
    ...ClothingCategories.map(BuildOutfitPage),
  ];

  const LastIndex = Pages.length - 1;
  const Last = Pages[LastIndex];
  if (Last !== undefined) Pages[LastIndex] = { ...Last, IsFinal: true };
  return Pages;
}

// ─────────────────────────────────────────────────────────────────────────
// Slider-value <-> AppearanceData conversion
// ─────────────────────────────────────────────────────────────────────────

/**
 * The wizard tracks slider values as a flat `Record<string, number>`
 * keyed by `SliderDef.Id` (and `appearance-{Name}Opacity` for the
 * opacity sub-sliders). These helpers convert to/from the typed
 * `AppearanceData` the server stores.
 */
export type SliderValues = Record<string, number>;

/** Compose AppearanceData from the wizard's flat slider record. */
export function SliderValuesToAppearance(
  Values: SliderValues,
  Base?: AppearanceData,
): AppearanceData {
  const Result: AppearanceData = Base !== undefined
    ? StructuredCloneAppearance(Base)
    : DefaultAppearanceData();

  Result.Heritage.ShapeParents = [
    GetInt(Values, 'ShapeOne', Result.Heritage.ShapeParents[0]),
    GetInt(Values, 'ShapeTwo', Result.Heritage.ShapeParents[1]),
    GetInt(Values, 'ShapeThree', Result.Heritage.ShapeParents[2]),
  ];
  Result.Heritage.SkinParents = [
    GetInt(Values, 'SkinOne', Result.Heritage.SkinParents[0]),
    GetInt(Values, 'SkinTwo', Result.Heritage.SkinParents[1]),
    GetInt(Values, 'SkinThree', Result.Heritage.SkinParents[2]),
  ];
  Result.Heritage.ShapeMix = GetPercent(Values, 'ShapeMix', Result.Heritage.ShapeMix);
  Result.Heritage.SkinMix = GetPercent(Values, 'SkinMix', Result.Heritage.SkinMix);
  Result.Heritage.OverrideMix = GetPercent(Values, 'OverrideMix', Result.Heritage.OverrideMix);
  Result.EyeColor = GetInt(Values, 'EyeColor', Result.EyeColor);

  for (const Name of FaceFeatureNames) {
    Result.FaceFeatures[Name] = GetMorph(Values, Name, Result.FaceFeatures[Name]);
  }

  // Slider position 0 means "None" -> native overlay index 255 (no
  // overlay). Slider position N (1..) means variant N-1. Without this
  // off-by-one the default slider value (0) applies the first variant
  // of every overlay - the player ends up with default pimples /
  // freckles / etc. before they touch anything.
  for (const Name of [...CreatorOverlayNames, ...BarberOverlayNames]) {
    const Slot = Result.Overlays[Name];
    const SliderValue = GetInt(Values, Name, 0);
    const NativeIndex = SliderValue === 0 ? 255 : SliderValue - 1;
    const ColorKey = `${Name}Color`;
    const Color = ColorKey in Values ? GetInt(Values, ColorKey, Slot.Color) : Slot.Color;
    Result.Overlays[Name] = {
      Index: NativeIndex,
      Opacity: GetPercent(Values, `${Name}Opacity`, Slot.Opacity),
      Color,
    };
  }

  Result.Hair = {
    Style: GetInt(Values, 'HairStyle', Result.Hair.Style),
    Color: GetInt(Values, 'HairColor', Result.Hair.Color),
    Highlight: GetInt(Values, 'HairHighlight', Result.Hair.Highlight),
    Decal: {
      // Same 0 => 255 ("no decal") rule as the overlay sliders.
      Index: (() => {
        const SliderValue = GetInt(Values, 'HairDecal', 0);
        return SliderValue === 0 ? 255 : SliderValue - 1;
      })(),
      Opacity: GetPercent(Values, 'HairDecalOpacity', Result.Hair.Decal.Opacity),
    },
  };

  return Result;
}

/** Seed the wizard's flat slider record from an AppearanceData blob. */
export function AppearanceToSliderValues(Data: AppearanceData): SliderValues {
  const Values: SliderValues = {};

  Values.ShapeOne = Data.Heritage.ShapeParents[0];
  Values.ShapeTwo = Data.Heritage.ShapeParents[1];
  Values.ShapeThree = Data.Heritage.ShapeParents[2];
  Values.SkinOne = Data.Heritage.SkinParents[0];
  Values.SkinTwo = Data.Heritage.SkinParents[1];
  Values.SkinThree = Data.Heritage.SkinParents[2];
  Values.ShapeMix = Math.round(Data.Heritage.ShapeMix * 100);
  Values.SkinMix = Math.round(Data.Heritage.SkinMix * 100);
  Values.OverrideMix = Math.round(Data.Heritage.OverrideMix * 100);
  Values.EyeColor = Data.EyeColor;

  for (const Name of FaceFeatureNames) {
    Values[Name] = Math.round(Data.FaceFeatures[Name] * 100);
  }

  // Native 255 (no overlay) -> slider 0 ("None"). Native variant N ->
  // slider N+1. Mirrors the slider-to-native shift in
  // `SliderValuesToAppearance`.
  for (const Name of [...CreatorOverlayNames, ...BarberOverlayNames]) {
    const NativeIndex = Data.Overlays[Name].Index;
    Values[Name] = NativeIndex === 255 ? 0 : NativeIndex + 1;
    Values[`${Name}Opacity`] = Math.round(Data.Overlays[Name].Opacity * 100);
    Values[`${Name}Color`] = Data.Overlays[Name].Color;
  }
  // Eyebrows expose a dedicated colour slider on the Eyebrows page; the
  // page reads this aliased key rather than `EyebrowsColor` falling out
  // of the overlay loop above. Both write to the same Overlay slot.
  Values.EyebrowsColor = Data.Overlays.Eyebrows.Color;

  Values.HairStyle = Data.Hair.Style;
  Values.HairColor = Data.Hair.Color;
  Values.HairHighlight = Data.Hair.Highlight;
  Values.HairDecal = Data.Hair.Decal.Index === 255 ? 0 : Data.Hair.Decal.Index + 1;
  Values.HairDecalOpacity = Math.round(Data.Hair.Decal.Opacity * 100);

  // Seed camera sliders so the reactive record has the keys from
  // first paint - avoids any first-drag jitter where the Slider would
  // briefly read `undefined` before the user's first emit lands.
  for (const Slider of CameraSliders) {
    Values[Slider.Id] = Slider.DefaultValue ?? 0;
  }

  return Values;
}

function GetInt(Values: SliderValues, Key: string, Fallback: number): number {
  const Raw = Values[Key];
  return typeof Raw === 'number' && Number.isFinite(Raw) ? Math.round(Raw) : Fallback;
}

/** Slider stores 0..100 ints; AppearanceData stores 0..1 floats. */
function GetPercent(Values: SliderValues, Key: string, Fallback: number): number {
  const Raw = Values[Key];
  return typeof Raw === 'number' && Number.isFinite(Raw) ? Raw / 100 : Fallback;
}

/** Slider stores -100..100 ints; AppearanceData stores -1..1 floats. */
function GetMorph(Values: SliderValues, Key: string, Fallback: number): number {
  const Raw = Values[Key];
  return typeof Raw === 'number' && Number.isFinite(Raw) ? Raw / 100 : Fallback;
}

function StructuredCloneAppearance(Data: AppearanceData): AppearanceData {
  return {
    Heritage: {
      ShapeParents: [
        Data.Heritage.ShapeParents[0],
        Data.Heritage.ShapeParents[1],
        Data.Heritage.ShapeParents[2],
      ],
      SkinParents: [
        Data.Heritage.SkinParents[0],
        Data.Heritage.SkinParents[1],
        Data.Heritage.SkinParents[2],
      ],
      ShapeMix: Data.Heritage.ShapeMix,
      SkinMix: Data.Heritage.SkinMix,
      OverrideMix: Data.Heritage.OverrideMix,
    },
    Hair: {
      Style: Data.Hair.Style,
      Color: Data.Hair.Color,
      Highlight: Data.Hair.Highlight,
      Decal: { ...Data.Hair.Decal },
    },
    EyeColor: Data.EyeColor,
    FaceFeatures: { ...Data.FaceFeatures },
    Overlays: Object.fromEntries(
      OverlayNames.map((N) => [N, { ...Data.Overlays[N] }]),
    ) as Record<OverlayName, { Index: number; Opacity: number; Color: number }>,
    Tattoos: Data.Tattoos.map((T) => ({ ...T })),
  };
}

/** Default value for a freshly-created character before the player edits. */
export function DefaultAppearanceData(): AppearanceData {
  const FaceFeatures = Object.fromEntries(FaceFeatureNames.map((N) => [N, 0])) as Record<
    FaceFeatureName,
    number
  >;
  // Opacity defaults to 1.0 for every overlay the wizard exposes:
  // CreatorOverlayNames (Blemishes/Ageing/Complexion/SunDamage/
  // MolesFreckles on the Appearances page) AND BarberOverlayNames
  // (FacialHair/Eyebrows/ChestHair on their own pages). Without this
  // the user picks a beard / eyebrow variant and sees nothing - the
  // ped renders the variant at 0% opacity and they think the slider
  // is broken. Overlays the wizard does NOT expose
  // (Makeup/Blush/Lipstick/BodyBlemishes/AddBodyBlemishes) stay at 0
  // so a future surface can opt them in deliberately. Matches ragemp's
  // `applyInitialize` opacity=100.
  const WizardVisible = new Set<OverlayName>([...CreatorOverlayNames, ...BarberOverlayNames]);
  const Overlays = Object.fromEntries(
    OverlayNames.map((N) => [
      N,
      { Index: 255, Opacity: WizardVisible.has(N) ? 1 : 0, Color: 0 },
    ]),
  ) as Record<OverlayName, { Index: number; Opacity: number; Color: number }>;
  return {
    Heritage: {
      ShapeParents: [0, 0, 0],
      SkinParents: [0, 0, 0],
      ShapeMix: 0.5,
      SkinMix: 0.5,
      // OverrideMix defaults to 0 - the third parent has no influence
      // until the user explicitly increases this. With OverrideMix=0.5
      // the first/second parent blend gets diluted 50% back to the third
      // parent (Benjamin by default), making ShapeOne/SkinOne changes
      // look much weaker than the user expects.
      OverrideMix: 0,
    },
    Hair: {
      Style: 0,
      Color: 0,
      Highlight: 0,
      // Decal.Index 255 = "no decal"; matches the slider-0 mapping in
      // SliderValuesToAppearance. Opacity defaults to 1 so the Hair
      // Decals page popover shows "100" rather than "0" - consistent
      // with the wizard's other HasOpacity sliders. The decal native
      // (AddPedDecorationFromHashes) ignores opacity, so this is a UX
      // alignment only; switching it to 0 would mislead the player
      // into thinking opacity is the reason a decal isn't drawing.
      Decal: { Index: 255, Opacity: 1 },
    },
    EyeColor: 0,
    FaceFeatures,
    Overlays,
    Tattoos: [],
  };
}

/**
 * Ped + camera coordinates used by the character creator. Inherited
 * verbatim from roleplay_ragemp's `Coords.cs` - an interior shell
 * (Franklin's old aunt's apartment) below the world that is isolated
 * from world traffic and lit cleanly.
 */
export const CreatorPedCoord = {
  X: 402.8349,
  Y: -996.5052,
  Z: -99.00023,
  Heading: 178.0954,
} as const;

/**
 * Per-gender base camera offsets relative to the ped. Mirrors the
 * ragemp client's GetOffsetFromEntityInWorldCoords usage. Female peds
 * are shorter on the bust frame so the camera sits a fraction higher.
 *
 *   Offset = lateral X
 *   Depth  = forward Y (the Camera Zoom slider modulates this)
 *   Height = vertical Z (the Camera Height slider modulates this)
 */
export interface CreatorCameraBase {
  Offset: number;
  Depth: number;
  Height: number;
}
export const CreatorCameraBaseByGender: Record<Gender, CreatorCameraBase> = {
  Male: { Offset: 0, Depth: 0.4, Height: 0.6875 },
  Female: { Offset: 0, Depth: 0.4, Height: 0.775 },
};
export const CreatorCameraFov = 60;

/** Inclusive integer in [Min, Max]. */
export function RandomInt(Min: number, Max: number): number {
  return Math.floor(Math.random() * (Max - Min + 1)) + Min;
}

/** Float in [Min, Max]. */
export function RandomFloat(Min: number, Max: number): number {
  return Math.random() * (Max - Min) + Min;
}

/**
 * Random slider values for the entire wizard. Face-feature morphs are
 * bounded to -30..30 (instead of full -100..100) so the randomised ped
 * stays human-shaped. Gender drives page composition (the Male-only
 * pages add Hair Decal slots that don't exist for the Female ped).
 */
export function RandomSliderValues(Gender: Gender): SliderValues {
  const Values: SliderValues = {};
  for (const Page of BuildCreatorPages(Gender)) {
    for (const Slider of Page.Sliders) {
      if (Slider.RandomMin === undefined || Slider.RandomMax === undefined) {
        if (Slider.DefaultValue !== undefined) Values[Slider.Id] = Slider.DefaultValue;
        continue;
      }
      const Min = Slider.Id in FacialMorphIds ? -30 : Slider.RandomMin;
      const Max = Slider.Id in FacialMorphIds ? 30 : Slider.RandomMax;
      Values[Slider.Id] = RandomInt(Min, Max);
    }
  }
  // Seed full opacity for every wizard-exposed overlay (Creator skin
  // overlays + Barber barber-style overlays). The opacity slider lives
  // in a popover and is not iterated by the page walk above, so without
  // this the store ends up with no `<Name>Opacity` key after a random,
  // which forces the popover + the appearance computation to fall back
  // to their defaults. Setting it explicitly keeps the store coherent.
  for (const Name of [...CreatorOverlayNames, ...BarberOverlayNames]) {
    Values[`${Name}Opacity`] = 100;
  }
  return Values;
}

/** Indices of slider IDs that drive SetPedFaceFeature morphs (clamped on randomize). */
const FacialMorphIds: Record<string, true> = Object.fromEntries(
  FaceFeatureNames.map((N) => [N, true as const]),
);

// ─────────────────────────────────────────────────────────────────────────
// Slider-value <-> OutfitData conversion
// ─────────────────────────────────────────────────────────────────────────

/**
 * Compose OutfitData from the wizard's flat slider record. Mirrors the
 * Appearance converter shape but keeps the data buckets separate so the
 * Frontend can iterate without re-checking each category's Type.
 *
 * Reads `${Category.Id}_Drawable` / `${Category.Id}_Texture` slider keys.
 * Missing slider entries fall back to the DefaultOutfitData baseline
 * (drawable 0 / texture 0 for components, drawable -1 / texture 0 for
 * props) so a partial slider record still produces a valid blob.
 */
export function SliderValuesToOutfit(Values: SliderValues): OutfitData {
  const Defaults = DefaultOutfitData();
  const Components: Record<string, ComponentSlot> = {};
  const Props: Record<string, ComponentSlot> = {};

  for (const Category of ClothingCategories) {
    const DrawableKey = `${Category.Id}_Drawable`;
    const TextureKey = `${Category.Id}_Texture`;
    if (Category.Type === 'Component') {
      const Fallback = Defaults.Components[Category.Id] ?? { Drawable: 0, Texture: 0 };
      Components[Category.Id] = {
        Drawable: GetInt(Values, DrawableKey, Fallback.Drawable),
        Texture: GetInt(Values, TextureKey, Fallback.Texture),
      };
    } else {
      const Fallback = Defaults.Props[Category.Id] ?? { Drawable: -1, Texture: 0 };
      Props[Category.Id] = {
        Drawable: GetInt(Values, DrawableKey, Fallback.Drawable),
        Texture: GetInt(Values, TextureKey, Fallback.Texture),
      };
    }
  }

  return { Components, Props };
}

/**
 * Seed the wizard's flat slider record from an OutfitData blob. Inverse
 * of SliderValuesToOutfit; preserves the prop "no equip" sentinel
 * (drawable -1) verbatim.
 */
export function OutfitToSliderValues(Data: OutfitData): SliderValues {
  const Values: SliderValues = {};
  for (const Category of ClothingCategories) {
    const Slot =
      Category.Type === 'Component'
        ? Data.Components[Category.Id]
        : Data.Props[Category.Id];
    if (Slot === undefined) continue;
    Values[`${Category.Id}_Drawable`] = Slot.Drawable;
    Values[`${Category.Id}_Texture`] = Slot.Texture;
  }
  return Values;
}

/**
 * UI-safe projection of one character. Carried in CharacterListResponse
 * + CharacterListLoaded for the selector view. Excludes forensic IDs,
 * appearance, outfit, world position - the selector only needs label
 * fields plus a sort hint (LastLoginAt is the natural "most recently
 * played" order). LastLoginAt is ISO-8601 (string-over-the-wire) so
 * the Vue side can construct a Date locally for formatting.
 */
export interface CharacterSummary {
  ID: string;
  SlotID: number;
  FirstName: string;
  LastName: string;
  Gender: Gender;
  /** ISO-8601 timestamp. Null on a character that has never been spawned. */
  LastLoginAt: string | null;
  /** ISO-8601 timestamp. */
  CreatedAt: string;
}

/**
 * Spawn-into-world payload carried in CharacterSpawned (also reused
 * post-Create). Has everything the Frontend needs to dress the freemode
 * ped and place it in the world; no forensic IDs (those live server-side
 * for the duration of the session).
 */
export interface CharacterSpawnPayload {
  CharacterID: string;
  FirstName: string;
  LastName: string;
  Gender: Gender;
  AppearanceData: AppearanceData;
  Outfit: OutfitData;
  Coord: { X: number; Y: number; Z: number };
  Heading: number;
  World: number;
  HP: number;
  AP: number;
}
