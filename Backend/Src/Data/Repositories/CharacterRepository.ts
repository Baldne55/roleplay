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
  FindByID(ID: string): Promise<Character | null> {
    return Character.findOne({ where: { ID, Status: 'Active' } });
  }

  FindByIDWithDeleted(ID: string): Promise<Character | null> {
    return Character.findByPk(ID);
  }

  ListByAccount(AccountID: string): Promise<Character[]> {
    return Character.findAll({
      where: { AccountID, Status: 'Active' },
      order: [['SlotID', 'ASC']],
    });
  }

  IsNameTaken(FirstName: string, LastName: string): Promise<boolean> {
    return Character.findOne({
      where: { FirstName, LastName },
      attributes: ['ID'],
    }).then((Row) => Row !== null);
  }

  IsMaskIDTaken(MaskID: string): Promise<boolean> {
    return Character.findOne({ where: { MaskID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  IsDnaIDTaken(DnaID: string): Promise<boolean> {
    return Character.findOne({ where: { DnaID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  IsFingerprintIDTaken(FingerprintID: string): Promise<boolean> {
    return Character.findOne({ where: { FingerprintID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

  IsSsnIDTaken(SsnID: string): Promise<boolean> {
    return Character.findOne({ where: { SsnID }, attributes: ['ID'] }).then(
      (Row) => Row !== null,
    );
  }

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

  Create(Fields: Partial<Character>, T?: Transaction): Promise<Character> {
    return Character.create(
      Fields as unknown as Character,
      T !== undefined ? { transaction: T } : undefined,
    );
  }

  /**
   * Persist the runtime state on disconnect (or character switch).
   * One UPDATE per call - position + combat + status + economy +
   * mask flag write together to keep DB traffic at a single row-touch
   * per save.
   *
   * Cash / Bank are passed as strings (DECIMAL(12,2)) to preserve cent
   * precision through mysql2's BIGINT/DECIMAL serialization.
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
      Cash: string;
      Bank: string;
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
        Cash: Fields.Cash,
        Bank: Fields.Bank,
      },
      { where: { ID } },
    );
  }

  SoftDelete(ID: string): Promise<[number]> {
    return Character.update(
      { Status: 'Deleted', DeletedAt: new Date() },
      { where: { ID, Status: 'Active' } },
    );
  }
}
