import {
  BloodTypes,
  FaceFeatureNames,
  Genders,
  MaxAge,
  MaxHeightCm,
  MaxWeightKg,
  MinAge,
  MinHeightCm,
  MinWeightKg,
  NameMaxLength,
  NameMinLength,
  NameRegex,
  OverlayNames,
  type AppearanceData,
  type BloodType,
  type CharacterSpawnPayload,
  type CharacterSummary,
  type Gender,
} from '@Shared/Constants/Character.js';
import { ClothingCategories, DefaultOutfitData, type OutfitData } from '@Shared/Constants/Outfit.js';
import { MinorAgeThreshold } from '@Shared/Constants/Nametag.js';
import type { Sequelize } from 'sequelize-typescript';
import { Logger } from '@/Util/Logger.js';
import type { Character } from '@/Data/Models/Character.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { CharacterOutfitRepository } from '@/Data/Repositories/CharacterOutfitRepository.js';
import type { ForensicIDService } from '@/Services/ForensicIDService.js';
import type { CharacterRuntime } from '@/Services/CharacterRuntimeService.js';

export interface SelectResult {
  Payload: CharacterSpawnPayload;
  Runtime: CharacterRuntime;
}

export interface CreateCharacterInput {
  AccountID: string;
  FirstName: string;
  LastName: string;
  Age: number;
  Gender: Gender;
  BloodType: BloodType;
  HeightCm: number;
  WeightKg: number;
  Appearance: AppearanceData;
  /**
   * Starter outfit captured on the wizard's final pages. Inserted into
   * `character_outfits` (Name="Default", IsActive=true) in the same
   * transaction as the character row.
   */
  Outfit: OutfitData;
  CreationIP: string | null;
}

/**
 * Returned from Create when validation fails or a uniqueness check loses
 * a race. Controllers translate Reason into the player-facing error
 * surfaced through CharacterCreateFailure.
 */
export class CharacterCreateError extends Error {
  constructor(public readonly Reason: string) {
    super(Reason);
    this.name = 'CharacterCreateError';
  }
}

/**
 * Returned from Select when the requested CharacterID isn't owned by the
 * account (forge attack) or otherwise can't be resolved. Controllers map
 * Reason into CharacterSelectFailure - keep the player-facing text
 * generic so the discriminator doesn't leak.
 */
export class CharacterSelectError extends Error {
  constructor(public readonly Reason: string) {
    super(Reason);
    this.name = 'CharacterSelectError';
  }
}

/**
 * Business logic for character creation, listing, and selection.
 *
 *   - Server-side re-validation of every field (no client trust).
 *   - Numeric Age -> synthetic BirthDate (today - age years). Storage
 *     is DATEONLY; we lose day-of-month granularity but that matches
 *     roleplay_ragemp's flow (numeric age, no real birthday picker).
 *   - Forensic IDs (Mask / DNA / Fingerprint / SSN) and BankAccountNumber
 *     generated via ForensicIDService with uniqueness checks against
 *     the repository.
 *   - SlotID assigned as the lowest unused per-account slot.
 *   - Persists with Status=Active, HP=100, AP=0, position columns taking
 *     the DB DEFAULT (Airport - see AuthSkybox.DefaultSpawn).
 */
export class CharacterService {
  private readonly Log = Logger.New('Character');

  constructor(
    private readonly Characters: CharacterRepository,
    private readonly Outfits: CharacterOutfitRepository,
    private readonly Forensic: ForensicIDService,
    private readonly Database: Sequelize,
  ) {}

  async Create(Input: CreateCharacterInput): Promise<Character> {
    this.Validate(Input);

    if (await this.Characters.IsNameTaken(Input.FirstName, Input.LastName)) {
      throw new CharacterCreateError(`The name "${Input.FirstName} ${Input.LastName}" is taken.`);
    }

    const [MaskID, DnaID, FingerprintID, SsnID, BankAccountNumber] = await Promise.all([
      this.Forensic.GenerateUnique((C) => this.Characters.IsMaskIDTaken(C)),
      this.Forensic.GenerateUnique((C) => this.Characters.IsDnaIDTaken(C)),
      this.Forensic.GenerateUnique((C) => this.Characters.IsFingerprintIDTaken(C)),
      this.Forensic.GenerateUnique((C) => this.Characters.IsSsnIDTaken(C)),
      this.Forensic.GenerateUnique((C) => this.Characters.IsBankAccountNumberTaken(C)),
    ]);

    const SlotID = await this.Characters.NextSlotID(Input.AccountID);

    // Character row + starter outfit go in atomically. If the outfit
    // insert fails the character insert must roll back too, otherwise
    // the wardrobe lookup on first spawn lands on a row with no active
    // outfit and the player spawns naked.
    const T = await this.Database.transaction();
    let Created: Character;
    try {
      Created = await this.Characters.Create(
        {
          AccountID: Input.AccountID,
          SlotID,
          FirstName: Input.FirstName,
          LastName: Input.LastName,
          BirthDate: DeriveBirthDate(Input.Age),
          Gender: Input.Gender,
          BloodType: Input.BloodType,
          MaskID,
          DnaID,
          FingerprintID,
          SsnID,
          BankAccountNumber,
          HeightCm: Input.HeightCm,
          WeightKg: Input.WeightKg,
          AppearanceData: Input.Appearance,
          CreationIP: Input.CreationIP,
          LastLoginAt: new Date(),
        },
        T,
      );

      await this.Outfits.Create(
        {
          CharacterID: Created.ID,
          Name: 'Default',
          IsActive: true,
          OutfitData: Input.Outfit,
        },
        T,
      );

      await T.commit();
    } catch (Err: unknown) {
      await T.rollback();
      throw Err;
    }

    this.Log.Info(
      `Created character id=${Created.ID} slot=${SlotID} account=${Input.AccountID} ` +
        `name="${Input.FirstName} ${Input.LastName}"`,
    );
    return Created;
  }

  /**
   * Project the account's Active characters into the UI-safe summary
   * shape used by the selector view. Sorted by SlotID ascending so the
   * slot labels render in order.
   */
  async ListByAccount(AccountID: string): Promise<CharacterSummary[]> {
    const Rows = await this.Characters.ListByAccount(AccountID);
    return Rows.map((Row): CharacterSummary => ({
      ID: Row.ID,
      SlotID: Row.SlotID,
      FirstName: Row.FirstName,
      LastName: Row.LastName,
      Gender: Row.Gender,
      LastLoginAt: Row.LastLoginAt !== null ? Row.LastLoginAt.toISOString() : null,
      CreatedAt: Row.CreatedAt.toISOString(),
    }));
  }

  /**
   * Resolve a character pick for spawn-into-world.
   *
   *   - Forge guard: load by ID and assert ownership against the account.
   *     A mismatch (or missing row) throws CharacterSelectError with a
   *     generic reason; controllers must NOT leak the discriminator.
   *   - Active outfit lookup falls back to the DefaultOutfitData()
   *     blueprint if no row carries IsActive=true. Should not happen
   *     post-Create (the starter outfit lands in the same transaction)
   *     but the fallback keeps the ped from spawning naked if the
   *     wardrobe ever loses its active row.
   *   - LastLoginAt is stamped here, not on list-fetch - the field
   *     measures when the character entered the world, not when its
   *     row was read.
   */
  async Select(AccountID: string, CharacterID: string): Promise<SelectResult> {
    const Row = await this.Characters.FindByID(CharacterID);
    // String() coerce both sides: mysql2 can hand BIGINT UNSIGNED back as
    // a number for small IDs, and PlayerState.AccountID is whatever the
    // Account model returned at auth time. Comparing without coercion
    // false-rejects a legitimate owner whose two IDs happen to land on
    // different types.
    if (Row === null || String(Row.AccountID) !== String(AccountID)) {
      throw new CharacterSelectError('Character not found.');
    }

    const ActiveOutfit = await this.Outfits.FindActive(CharacterID);
    const Outfit: OutfitData =
      ActiveOutfit !== null ? ActiveOutfit.OutfitData : DefaultOutfitData();

    Row.LastLoginAt = new Date();
    await Row.save();

    const Payload: CharacterSpawnPayload = {
      CharacterID: Row.ID,
      FirstName: Row.FirstName,
      LastName: Row.LastName,
      Gender: Row.Gender,
      AppearanceData: Row.AppearanceData,
      Outfit,
      Coord: {
        X: Number(Row.PositionX),
        Y: Number(Row.PositionY),
        Z: Number(Row.PositionZ),
      },
      Heading: Number(Row.Heading),
      World: Row.World,
      HP: Row.HP,
      AP: Row.AP,
    };

    // Runtime mirror of the server-tracked fields (the ones the engine
    // can't report back through natives). Stays in memory until
    // playerDropped flushes it via SaveRuntime.
    const Runtime: CharacterRuntime = {
      CharacterID: String(Row.ID),
      FirstName: Row.FirstName,
      LastName: Row.LastName,
      MaskID: Row.MaskID,
      IsMasked: Row.IsMasked,
      BirthDate: Row.BirthDate,
      IsMinor: AgeFromBirthDate(Row.BirthDate) < MinorAgeThreshold,
      Cash: Row.Cash,
      Bank: Row.Bank,
      InjuryStatus: Row.InjuryStatus,
      BleedingStatus: Row.BleedingStatus,
    };

    return { Payload, Runtime };
  }

  private Validate(Input: CreateCharacterInput): void {
    AssertName('FirstName', Input.FirstName);
    AssertName('LastName', Input.LastName);

    if (!Number.isInteger(Input.Age) || Input.Age < MinAge || Input.Age > MaxAge) {
      throw new CharacterCreateError(`Age must be a whole number between ${MinAge} and ${MaxAge}.`);
    }
    if (!Genders.includes(Input.Gender)) {
      throw new CharacterCreateError('Gender must be Male or Female.');
    }
    if (!BloodTypes.includes(Input.BloodType)) {
      throw new CharacterCreateError('Blood type is not recognised.');
    }
    if (
      !Number.isInteger(Input.HeightCm) ||
      Input.HeightCm < MinHeightCm ||
      Input.HeightCm > MaxHeightCm
    ) {
      throw new CharacterCreateError(`Height must be between ${MinHeightCm} and ${MaxHeightCm} cm.`);
    }
    if (
      !Number.isInteger(Input.WeightKg) ||
      Input.WeightKg < MinWeightKg ||
      Input.WeightKg > MaxWeightKg
    ) {
      throw new CharacterCreateError(`Weight must be between ${MinWeightKg} and ${MaxWeightKg} kg.`);
    }

    AssertAppearance(Input.Appearance);
    AssertOutfit(Input.Outfit);
  }
}

function AssertName(Field: 'FirstName' | 'LastName', Value: unknown): void {
  if (typeof Value !== 'string') {
    throw new CharacterCreateError(`${Field} is missing.`);
  }
  if (Value.length < NameMinLength || Value.length > NameMaxLength) {
    throw new CharacterCreateError(
      `${Field} must be between ${NameMinLength} and ${NameMaxLength} characters.`,
    );
  }
  if (!NameRegex.test(Value)) {
    throw new CharacterCreateError(
      `${Field} must start with a capital letter and contain English letters only.`,
    );
  }
}

function AssertAppearance(Appearance: unknown): void {
  if (typeof Appearance !== 'object' || Appearance === null) {
    throw new CharacterCreateError('Appearance data is missing.');
  }
  const A = Appearance as Partial<AppearanceData>;
  if (
    typeof A.Heritage !== 'object' ||
    A.Heritage === null ||
    typeof A.Hair !== 'object' ||
    A.Hair === null ||
    typeof A.EyeColor !== 'number' ||
    typeof A.FaceFeatures !== 'object' ||
    A.FaceFeatures === null ||
    typeof A.Overlays !== 'object' ||
    A.Overlays === null ||
    !Array.isArray(A.Tattoos)
  ) {
    throw new CharacterCreateError('Appearance data is malformed.');
  }
  const H = A.Hair as { Style?: unknown; Color?: unknown; Highlight?: unknown; Decal?: unknown };
  if (
    typeof H.Style !== 'number' ||
    typeof H.Color !== 'number' ||
    typeof H.Highlight !== 'number' ||
    typeof H.Decal !== 'object' ||
    H.Decal === null
  ) {
    throw new CharacterCreateError('Hair data is malformed.');
  }
  const D = H.Decal as { Index?: unknown; Opacity?: unknown };
  if (typeof D.Index !== 'number' || typeof D.Opacity !== 'number') {
    throw new CharacterCreateError('Hair decal is malformed.');
  }
  for (const Name of FaceFeatureNames) {
    const V = (A.FaceFeatures as Record<string, unknown>)[Name];
    if (typeof V !== 'number' || V < -1 || V > 1) {
      throw new CharacterCreateError(`Face feature "${Name}" is out of range.`);
    }
  }
  for (const Name of OverlayNames) {
    const Slot = (A.Overlays as Record<string, unknown>)[Name];
    if (typeof Slot !== 'object' || Slot === null) {
      throw new CharacterCreateError(`Overlay "${Name}" is missing.`);
    }
    const S = Slot as { Index?: unknown; Opacity?: unknown; Color?: unknown };
    if (
      typeof S.Index !== 'number' ||
      typeof S.Opacity !== 'number' ||
      typeof S.Color !== 'number'
    ) {
      throw new CharacterCreateError(`Overlay "${Name}" is malformed.`);
    }
  }
}

function AssertOutfit(Outfit: unknown): void {
  if (typeof Outfit !== 'object' || Outfit === null) {
    throw new CharacterCreateError('Outfit data is missing.');
  }
  const O = Outfit as Partial<OutfitData>;
  if (
    typeof O.Components !== 'object' ||
    O.Components === null ||
    typeof O.Props !== 'object' ||
    O.Props === null
  ) {
    throw new CharacterCreateError('Outfit data is malformed.');
  }
  const Components = O.Components as Record<string, unknown>;
  const Props = O.Props as Record<string, unknown>;
  const ExpectedComponentKeys = new Set<string>();
  const ExpectedPropKeys = new Set<string>();
  for (const Category of ClothingCategories) {
    if (Category.Type === 'Component') ExpectedComponentKeys.add(Category.Id);
    else ExpectedPropKeys.add(Category.Id);
  }

  // Reject extra keys - the wizard sends exactly the 14 categories,
  // and a malicious client could otherwise smuggle drawable slots
  // outside the catalog onto the persisted blob.
  for (const Key of Object.keys(Components)) {
    if (!ExpectedComponentKeys.has(Key)) {
      throw new CharacterCreateError(`Outfit component "${Key}" is unknown.`);
    }
  }
  for (const Key of Object.keys(Props)) {
    if (!ExpectedPropKeys.has(Key)) {
      throw new CharacterCreateError(`Outfit prop "${Key}" is unknown.`);
    }
  }

  for (const Category of ClothingCategories) {
    const Bucket = Category.Type === 'Component' ? Components : Props;
    const Slot = Bucket[Category.Id];
    if (typeof Slot !== 'object' || Slot === null) {
      throw new CharacterCreateError(`Outfit "${Category.Id}" is missing.`);
    }
    const S = Slot as { Drawable?: unknown; Texture?: unknown };
    if (
      typeof S.Drawable !== 'number' ||
      !Number.isInteger(S.Drawable) ||
      typeof S.Texture !== 'number' ||
      !Number.isInteger(S.Texture)
    ) {
      throw new CharacterCreateError(`Outfit "${Category.Id}" is malformed.`);
    }
    // Texture must be a non-negative byte; Drawable upper bound is the
    // GTA byte ceiling. Components disallow the -1 prop sentinel.
    const MinDrawable = Category.Type === 'Prop' ? -1 : 0;
    if (S.Drawable < MinDrawable || S.Drawable > 255) {
      throw new CharacterCreateError(`Outfit "${Category.Id}" drawable is out of range.`);
    }
    if (S.Texture < 0 || S.Texture > 255) {
      throw new CharacterCreateError(`Outfit "${Category.Id}" texture is out of range.`);
    }
  }
}

/**
 * Inverse of DeriveBirthDate. Reads a stored ISO YYYY-MM-DD date and
 * returns the integer age in whole years, accounting for whether
 * today is before or after the birthday this year. Used at runtime
 * attach to derive IsMinor (< 18) once per session.
 */
function AgeFromBirthDate(BirthDate: string): number {
  const Today = new Date();
  const Parts = BirthDate.split('-');
  const Y = Number(Parts[0]);
  const M = Number(Parts[1]);
  const D = Number(Parts[2]);
  if (!Number.isFinite(Y) || !Number.isFinite(M) || !Number.isFinite(D)) {
    // Malformed row - treat as adult (the safer default for legal /
    // mature-content gates) so a corrupt date can't accidentally flag
    // an adult character as minor.
    return MinorAgeThreshold;
  }
  let Age = Today.getUTCFullYear() - Y;
  const MonthDiff = Today.getUTCMonth() + 1 - M;
  if (MonthDiff < 0 || (MonthDiff === 0 && Today.getUTCDate() < D)) {
    Age -= 1;
  }
  return Age;
}

/**
 * Numeric age -> ISO date (YYYY-MM-DD), set to today minus N years.
 * Lossy by design (player gave us an age, not a birthday). Stored as
 * DATEONLY so MariaDB returns it as YYYY-MM-DD.
 */
function DeriveBirthDate(Age: number): string {
  const Today = new Date();
  const Year = Today.getUTCFullYear() - Age;
  const Month = String(Today.getUTCMonth() + 1).padStart(2, '0');
  const Day = String(Today.getUTCDate()).padStart(2, '0');
  return `${Year}-${Month}-${Day}`;
}
