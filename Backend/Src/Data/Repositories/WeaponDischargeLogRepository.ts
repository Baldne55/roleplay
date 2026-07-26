import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { WeaponDischargeLog } from '@/Data/Models/WeaponDischargeLog.js';

/**
 * One ballistics row - the record behind `/aitem traceweapon` and
 * `/aitem lastfired`.
 *
 * Keyed on the weapon's serial rather than its item row, so the trail
 * survives the weapon changing hands, being stored, or being destroyed.
 * A defaced serial (see `/aitem removeserial`) therefore has nothing to
 * query, which is the intended forensic dead end.
 */
export interface AppendDischargeFields {
  TransactionID: string;
  WeaponSerial: string;
  WeaponTypeID: string;
  AmmoTypeID: string | null;
  ShooterCharacterID: string | null;
  VictimCharacterID: string | null;
  Damage: number;
  HitComponent: number | null;
  World: number;
  PositionX: string;
  PositionY: string;
  PositionZ: string;
  OccurredAt: Date;
}

/**
 * Discharge log data access. Append-only; reads are admin-only.
 */
export class WeaponDischargeLogRepository {
  /** Record one discharge. Append-only, like the violations log. */
  async Append(Fields: AppendDischargeFields, T?: Transaction): Promise<void> {
    await WeaponDischargeLog.create(
      {
        TransactionID: Fields.TransactionID,
        WeaponSerial: Fields.WeaponSerial,
        WeaponTypeID: Fields.WeaponTypeID,
        AmmoTypeID: Fields.AmmoTypeID,
        ShooterCharacterID: Fields.ShooterCharacterID,
        VictimCharacterID: Fields.VictimCharacterID,
        Damage: Fields.Damage,
        HitComponent: Fields.HitComponent,
        World: Fields.World,
        PositionX: Fields.PositionX,
        PositionY: Fields.PositionY,
        PositionZ: Fields.PositionZ,
        OccurredAt: Fields.OccurredAt,
      },
      T !== undefined ? { transaction: T } : undefined,
    );
  }

  /** Ballistics for one weapon, newest first - backs `/aitem traceweapon`. */
  FindBySerial(Serial: string, Limit: number): Promise<WeaponDischargeLog[]> {
    return WeaponDischargeLog.findAll({
      where: { WeaponSerial: Serial },
      order: [['OccurredAt', 'DESC']],
      limit: Limit,
    });
  }

  /** Last `Limit` distinct weapon serials a character has shot. */
  async ListSerialsByShooter(
    CharacterID: string,
    Limit: number,
  ): Promise<{ Serial: string; LastShotAt: Date }[]> {
    const Rows = await WeaponDischargeLog.findAll({
      where: { ShooterCharacterID: CharacterID },
      order: [['OccurredAt', 'DESC']],
      limit: 200,
    });
    const Seen = new Map<string, Date>();
    for (const Row of Rows) {
      if (!Seen.has(Row.WeaponSerial)) Seen.set(Row.WeaponSerial, Row.OccurredAt);
      if (Seen.size >= Limit) break;
    }
    return Array.from(Seen.entries()).map(([Serial, LastShotAt]) => ({ Serial, LastShotAt }));
  }

  /** Last `Limit` discharge rows a character fired, newest first. */
  ListByShooter(CharacterID: string, Limit: number): Promise<WeaponDischargeLog[]> {
    return WeaponDischargeLog.findAll({
      where: { ShooterCharacterID: CharacterID },
      order: [['OccurredAt', 'DESC']],
      limit: Limit,
    });
  }

  /**
   * Discharges for one weapon after a cutoff.
   *
   * Time-windowed rather than count-limited because the anti-cheat rate
   * checks care about shots per interval - a fixed count would read
   * differently depending on how busy the weapon has been.
   */
  FindSince(Serial: string, Since: Date): Promise<WeaponDischargeLog[]> {
    return WeaponDischargeLog.findAll({
      where: { WeaponSerial: Serial, OccurredAt: { [Op.gte]: Since } },
      order: [['OccurredAt', 'DESC']],
    });
  }
}
