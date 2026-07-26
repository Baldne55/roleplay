import {
  AutoIncrement,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { Account } from '@/Data/Models/Account.js';
import { Character } from '@/Data/Models/Character.js';

/**
 * One row per anti-cheat detection report. Append-only - the row is a
 * snapshot of the moment, including the session score AFTER this
 * report's weight was applied and the action the pipeline took.
 *
 * Account / character links are nullable ON DELETE SET NULL so the
 * evidence trail outlives the holders; both can also be null at write
 * time when a detection fires against a connection that never reached
 * the Spawned phase.
 *
 * `evidence_json` is detection-specific (distances, hashes, coords as
 * reported by the detector) and bounded at write time - render it for
 * admins, never parse it for logic.
 */
@Table({
  tableName: 'anticheat_violations',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: false,
  underscored: false,
})
export class AnticheatViolation extends Model<
  InferAttributes<AnticheatViolation>,
  InferCreationAttributes<AnticheatViolation>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @ForeignKey(() => Account)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'account_id', allowNull: true })
  declare AccountID: CreationOptional<string | null>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'character_id', allowNull: true })
  declare CharacterID: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), field: 'detection_type', allowNull: false })
  declare DetectionType: string;

  @Column({ type: DataType.TINYINT, field: 'tier', allowNull: false })
  declare Tier: number;

  @Column({ type: DataType.SMALLINT, field: 'weight', allowNull: false })
  declare Weight: number;

  @Column({ type: DataType.SMALLINT, field: 'session_score', allowNull: false })
  declare SessionScore: number;

  /** Pipeline outcome for this report: None | Alert | Kick | Ban. */
  @Column({ type: DataType.STRING(16), field: 'action', allowNull: false })
  declare Action: string;

  @Column({ type: DataType.TEXT, field: 'evidence_json', allowNull: false })
  declare EvidenceJSON: string;

  @Column({ type: DataType.INTEGER, field: 'world', allowNull: true })
  declare World: CreationOptional<number | null>;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_x', allowNull: true })
  declare PositionX: CreationOptional<string | null>;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_y', allowNull: true })
  declare PositionY: CreationOptional<string | null>;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_z', allowNull: true })
  declare PositionZ: CreationOptional<string | null>;

  @Column({ type: DataType.DATE, field: 'occurred_at', allowNull: false })
  declare OccurredAt: Date;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;
}
