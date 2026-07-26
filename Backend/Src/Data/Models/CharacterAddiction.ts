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
import type { DrugClass } from '@Shared/Constants/Drugs.js';
import { Character } from '@/Data/Models/Character.js';

/**
 * One (character, drug class) addiction ledger row. `Level` is the
 * addiction as of `LastDoseAt`; the abstinence decay is computed
 * lazily from that stamp on every read (Shared/Constants/Drugs.ts),
 * mirroring the blood-alcohol columns - dosing is the only writer,
 * no recurring job touches the table. A unique index on
 * (character_id, drug_class) keeps the ledger one-row-per-class.
 */
@Table({
  tableName: 'character_addictions',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class CharacterAddiction extends Model<
  InferAttributes<CharacterAddiction>,
  InferCreationAttributes<CharacterAddiction>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'character_id', allowNull: false })
  declare CharacterID: string;

  @Column({ type: DataType.STRING(16), field: 'drug_class', allowNull: false })
  declare DrugClass: DrugClass;

  @Column({ type: DataType.DECIMAL(5, 2), field: 'level', allowNull: false })
  declare Level: string;

  @Column({ type: DataType.DATE, field: 'last_dose_at', allowNull: true })
  declare LastDoseAt: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
