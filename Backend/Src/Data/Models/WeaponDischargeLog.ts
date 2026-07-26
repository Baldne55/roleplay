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
import { Character } from '@/Data/Models/Character.js';

/**
 * Bullet-tagged forensic trail. One row per `weaponDamageEvent` the
 * server relays (a client applying weapon damage to a remotely-owned
 * entity; the InventoryController hook is the source). Joins back to
 * the matching `inventory_mutation_log.transaction_id` so
 * investigators can pivot from "this weapon discharged here" to
 * "this character was holding it on this Source at the time".
 *
 * The shooter is always a connected player (the event sender). The
 * victim character ID is null when the hit entity is not a player
 * ped (NPC, vehicle, prop). Self-inflicted damage and hits on
 * entities the shooter's own client owns raise no event and are not
 * logged.
 *
 * Defaced weapons (unique_serial nulled later) still log with their
 * pre-deface serial - the row is a snapshot of the moment.
 */
@Table({
  tableName: 'weapon_discharge_log',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: false,
  underscored: false,
})
export class WeaponDischargeLog extends Model<
  InferAttributes<WeaponDischargeLog>,
  InferCreationAttributes<WeaponDischargeLog>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @Column({ type: DataType.STRING(36), field: 'transaction_id', allowNull: false })
  declare TransactionID: string;

  @Column({ type: DataType.STRING(32), field: 'weapon_serial', allowNull: false })
  declare WeaponSerial: string;

  @Column({ type: DataType.STRING(64), field: 'weapon_type_id', allowNull: false })
  declare WeaponTypeID: string;

  @Column({ type: DataType.STRING(64), field: 'ammo_type_id', allowNull: true })
  declare AmmoTypeID: CreationOptional<string | null>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'shooter_character_id', allowNull: true })
  declare ShooterCharacterID: CreationOptional<string | null>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'victim_character_id', allowNull: true })
  declare VictimCharacterID: CreationOptional<string | null>;

  @Column({ type: DataType.SMALLINT, field: 'damage', allowNull: false })
  declare Damage: number;

  /**
   * Raw ped component id from the event - deliberately untranslated
   * (no bone-name mapping); admins read the numeric distribution.
   * Null when the event carried no usable value or the row predates
   * the column.
   */
  @Column({ type: DataType.SMALLINT, field: 'hit_component', allowNull: true })
  declare HitComponent: CreationOptional<number | null>;

  @Column({ type: DataType.INTEGER, field: 'world', allowNull: false })
  declare World: number;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_x', allowNull: false })
  declare PositionX: string;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_y', allowNull: false })
  declare PositionY: string;

  @Column({ type: DataType.DECIMAL(10, 3), field: 'position_z', allowNull: false })
  declare PositionZ: string;

  @Column({ type: DataType.DATE, field: 'occurred_at', allowNull: false })
  declare OccurredAt: Date;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;
}
