import { AnticheatViolation } from '@/Data/Models/AnticheatViolation.js';

/**
 * One recorded anti-cheat detection.
 *
 * `Action` records what was actually done about it, which matters because
 * enforcement defaults to `observe` - a row saying `observe` means the
 * detection fired and nobody was kicked. Both identity fields are
 * nullable so a detection against a connected-but-unspawned player is
 * still recorded.
 */
export interface AppendViolationFields {
  AccountID: string | null;
  CharacterID: string | null;
  DetectionType: string;
  Tier: number;
  Weight: number;
  SessionScore: number;
  Action: string;
  EvidenceJSON: string;
  World: number | null;
  PositionX: string | null;
  PositionY: string | null;
  PositionZ: string | null;
  OccurredAt: Date;
}

/**
 * Anti-cheat violation data access. Append-only; reads are admin-only
 * (the `/ac` lookup surface).
 */
export class AnticheatViolationRepository {
  /**
   * Record one detection. Append-only - violations are never updated or
   * deleted, so the trail stays intact for later review.
   */
  async Append(Fields: AppendViolationFields): Promise<void> {
    await AnticheatViolation.create({
      AccountID: Fields.AccountID,
      CharacterID: Fields.CharacterID,
      DetectionType: Fields.DetectionType,
      Tier: Fields.Tier,
      Weight: Fields.Weight,
      SessionScore: Fields.SessionScore,
      Action: Fields.Action,
      EvidenceJSON: Fields.EvidenceJSON,
      World: Fields.World,
      PositionX: Fields.PositionX,
      PositionY: Fields.PositionY,
      PositionZ: Fields.PositionZ,
      OccurredAt: Fields.OccurredAt,
    });
  }

  /** Newest violations server-wide, for `/ac recent`. */
  Recent(Limit: number): Promise<AnticheatViolation[]> {
    return AnticheatViolation.findAll({
      order: [['OccurredAt', 'DESC']],
      limit: Limit,
    });
  }

  /**
   * One account's violation history, for `/ac player`.
   *
   * Keyed on account rather than character so the history follows the
   * person across every character they have played.
   */
  FindByAccount(AccountID: string, Limit: number): Promise<AnticheatViolation[]> {
    return AnticheatViolation.findAll({
      where: { AccountID },
      order: [['OccurredAt', 'DESC']],
      limit: Limit,
    });
  }
}
