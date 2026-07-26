import type { Transaction } from 'sequelize';
import { Character } from '@/Data/Models/Character.js';

/**
 * Character data access. SQL-thin wrapper around the Character model;
 * no business rules (those live in services).
 *
 * "Visible" reads filter out soft-deleted rows. Uniqueness checks
 * (name + forensic IDs + bank account) intentionally INCLUDE deleted
 * rows - reservations persist past delete so a recovered character
 * keeps its name and a re-roll cannot pose as a deleted persona.
 */
export class CharacterRepository {
  /** Active character by id. Soft-deleted rows are invisible here. */
  FindByID(ID: string): Promise<Character | null> {
    return Character.findOne({ where: { ID, Status: 'Active' } });
  }

  /**
   * Character by id including soft-deleted rows.
   *
   * For audit paths that must still resolve a name after deletion - an
   * item bound to a deleted character, a mutation-log actor. Never use
   * this to authorise anything: a deleted character must not be playable.
   */
  FindByIDWithDeleted(ID: string): Promise<Character | null> {
    return Character.findByPk(ID);
  }

  /** An account's active characters, ordered by slot - the selector roster. */
  ListByAccount(AccountID: string): Promise<Character[]> {
    return Character.findAll({
      where: { AccountID, Status: 'Active' },
      order: [['SlotID', 'ASC']],
    });
  }

  /*
   * ── Uniqueness reservations ──────────────────────────────────────
   *
   * All six deliberately omit the Status filter, so they see deleted
   * rows too. A deleted character keeps its name and forensic ids
   * reserved forever: releasing them would let someone re-roll a
   * character posing as a deleted persona, and would break the forensic
   * trail that still references those ids.
   */

  /** Whether this exact first+last pair is reserved (deleted rows included). */
  IsNameTaken(FirstName: string, LastName: string): Promise<boolean> {
    return Character.findOne({
      where: { FirstName, LastName },
      attributes: ['ID'],
    }).then((Row) => Row !== null);
  }

  /** Whether a forensic mask id is reserved (deleted rows included). */
  IsMaskIDTaken(MaskID: string): Promise<boolean> {
    return Character.findOne({ where: { MaskID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  /** Whether a DNA id is reserved (deleted rows included). */
  IsDnaIDTaken(DnaID: string): Promise<boolean> {
    return Character.findOne({ where: { DnaID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  /** Whether a fingerprint id is reserved (deleted rows included). */
  IsFingerprintIDTaken(FingerprintID: string): Promise<boolean> {
    return Character.findOne({ where: { FingerprintID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  /** Whether an SSN is reserved (deleted rows included). */
  IsSsnIDTaken(SsnID: string): Promise<boolean> {
    return Character.findOne({ where: { SsnID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  /** Whether a bank account number is reserved (deleted rows included). */
  IsBankAccountNumberTaken(BankAccountNumber: string): Promise<boolean> {
    return Character.findOne({
      where: { BankAccountNumber },
      attributes: ['ID'],
    }).then((Row) => Row !== null);
  }

  /**
   * Lowest unused per-account slot id (1-based). Skips deleted rows'
   * slots so a freshly created character takes the first visibly empty
   * label.
   */
  async NextSlotID(AccountID: string): Promise<number> {
    const Rows = await Character.findAll({
      where: { AccountID, Status: 'Active' },
      attributes: ['SlotID'],
    });
    const Taken = new Set(Rows.map((R) => R.SlotID));
    let N = 1;
    while (Taken.has(N)) N += 1;
    return N;
  }

  /**
   * Insert a character row. Takes an optional transaction so creation can
   * share one with the starter-outfit insert - a character must never
   * exist without its default outfit.
   */
  Create(Fields: Partial<Character>, T?: Transaction): Promise<Character> {
    return Character.create(
      Fields as unknown as Character,
      T !== undefined ? { transaction: T } : undefined,
    );
  }

  /**
   * Persist the runtime state on disconnect (or character switch).
   * One UPDATE per call - position + combat + status + bank + mask
   * flag write together to keep DB traffic at a single row-touch per
   * save.
   *
   * Cash left this method in 0.5.0 - paper currency is now an
   * inventory item and the inventory layer self-persists on every
   * mutation. Bank stays as a DECIMAL(12,2) string column until the
   * bank slice rewrites it.
   */
  async SaveRuntime(
    ID: string,
    Fields: {
      World: number;
      PositionX: number;
      PositionY: number;
      PositionZ: number;
      Heading: number;
      HP: number;
      AP: number;
      InjuryStatus: Character['InjuryStatus'];
      BleedingStatus: Character['BleedingStatus'];
      IsMasked: boolean;
      Bank: string;
      RadioState: Character['RadioState'];
      ActivePhoneSerial: Character['ActivePhoneSerial'];
    },
  ): Promise<void> {
    await Character.update(
      {
        World: Fields.World,
        PositionX: Fields.PositionX.toFixed(3),
        PositionY: Fields.PositionY.toFixed(3),
        PositionZ: Fields.PositionZ.toFixed(3),
        Heading: Fields.Heading.toFixed(3),
        HP: Fields.HP,
        AP: Fields.AP,
        InjuryStatus: Fields.InjuryStatus,
        BleedingStatus: Fields.BleedingStatus,
        IsMasked: Fields.IsMasked,
        Bank: Fields.Bank,
        RadioState: Fields.RadioState,
        ActivePhoneSerial: Fields.ActivePhoneSerial,
      },
      { where: { ID } },
    );
  }

  /**
   * Persist just the radio tuning. Used by the disconnect path when no
   * trustworthy position is available, so the position-bearing
   * SaveRuntime is skipped but the player's configured channels (which
   * have no safe default to fall back to) are not lost.
   */
  async SaveRadioState(ID: string, RadioState: Character['RadioState']): Promise<void> {
    await Character.update({ RadioState }, { where: { ID } });
  }

  /**
   * Persist just the active-phone pointer, written eagerly when the player
   * runs /phone main. Eager persistence (rather than relying on the
   * disconnect flush) means the choice survives even the no-position
   * disconnect branch, which skips SaveRuntime entirely.
   */
  async SaveActivePhone(ID: string, Serial: string | null): Promise<void> {
    await Character.update({ ActivePhoneSerial: Serial }, { where: { ID } });
  }

  /**
   * Persist an injury-state transition immediately. Separate from
   * SaveRuntime so the injury layer can flush each Healthy ->
   * Unconscious -> BadlyWounded -> Dead step the moment it lands,
   * rather than waiting for `playerDropped`. A server crash 30 s after
   * a player enters BadlyWounded would otherwise roll them back to
   * Healthy on restart.
   *
   * Position is optional: lethal-damage transitions snapshot the death
   * site so the body stays where it fell (ragemp pattern); `/arevive`
   * passes the issuer-resolved position; `/acceptdeath` passes the
   * nearest hospital. When Position is omitted the existing columns
   * stay put.
   */
  async SaveInjury(
    ID: string,
    Fields: {
      InjuryStatus: Character['InjuryStatus'];
      BleedingStatus: Character['BleedingStatus'];
      HP: number;
      Position?: { X: number; Y: number; Z: number; Heading?: number; World?: number };
    },
  ): Promise<void> {
    const Update: Record<string, unknown> = {
      InjuryStatus: Fields.InjuryStatus,
      BleedingStatus: Fields.BleedingStatus,
      HP: Fields.HP,
    };
    if (Fields.Position !== undefined) {
      Update.PositionX = Fields.Position.X.toFixed(3);
      Update.PositionY = Fields.Position.Y.toFixed(3);
      Update.PositionZ = Fields.Position.Z.toFixed(3);
      if (Fields.Position.Heading !== undefined) {
        Update.Heading = Fields.Position.Heading.toFixed(3);
      }
      if (Fields.Position.World !== undefined) {
        Update.World = Fields.Position.World;
      }
    }
    await Character.update(Update, { where: { ID } });
  }

  /**
   * Persist a bleeding-tier transition immediately. Same crash-safety
   * rationale as SaveInjury - the bleeding layer flushes each tier
   * change (escalation, bandage relief, admin override) the moment it
   * lands, so a server crash mid-session cannot roll a treated wound
   * back open or resurrect a cleared one. Touches the bleeding_status
   * column only; HP and position stay with their own save paths.
   */
  async SaveBleeding(
    CharacterID: string,
    BleedingStatus: Character['BleedingStatus'],
  ): Promise<void> {
    await Character.update({ BleedingStatus }, { where: { ID: CharacterID } });
  }

  /**
   * Read the stored ethanol grams + the stamp of the last write for
   * the lazy-decay blood-alcohol model. Null when the character row
   * does not exist.
   */
  async FindBloodAlcohol(
    CharacterID: string,
  ): Promise<{ Grams: number; At: Date | null } | null> {
    const Row = await Character.findByPk(CharacterID, {
      attributes: ['ID', 'BloodAlcoholGrams', 'BloodAlcoholAt'],
    });
    if (Row === null) return null;
    const Grams = Number.parseFloat(Row.BloodAlcoholGrams);
    return { Grams: Number.isFinite(Grams) ? Grams : 0, At: Row.BloodAlcoholAt ?? null };
  }

  /** Persist the decayed-then-adjusted ethanol grams with a fresh stamp. */
  async SaveBloodAlcohol(CharacterID: string, Grams: number, At: Date): Promise<void> {
    await Character.update(
      { BloodAlcoholGrams: Grams.toFixed(2), BloodAlcoholAt: At },
      { where: { ID: CharacterID } },
    );
  }

  /**
   * Mark a character deleted, stamping the time.
   *
   * Soft, never hard: the row must survive so its name and forensic ids
   * stay reserved and so items and log rows that reference it can still
   * resolve. The `Status: 'Active'` predicate makes it idempotent - a
   * second delete matches nothing and returns 0 rather than re-stamping.
   */
  SoftDelete(ID: string): Promise<[number]> {
    return Character.update(
      { Status: 'Deleted', DeletedAt: new Date() },
      { where: { ID, Status: 'Active' } },
    );
  }
}
