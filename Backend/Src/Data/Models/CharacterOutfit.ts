import {
  AutoIncrement,
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { Character } from '@/Data/Models/Character.js';
import type { OutfitData } from '@Shared/Constants/Outfit.js';

/**
 * One saved outfit belonging to a Character.
 *
 *   - `ID` is the global PK; UI never sees it.
 *   - `(CharacterID, IsActive)` is the lookup the spawn / wardrobe path
 *     uses on every connect; exactly one row per character should
 *     carry IsActive=true. Enforced at the service / repository layer
 *     (MariaDB lacks partial unique indexes).
 *   - `OutfitData` is the typed JSON column (see
 *     Shared/Constants/Outfit.OutfitData). NOT NULL - the creator
 *     wizard always sends a full payload; later editor flows update
 *     in place.
 *
 * Column mappings: every column carries an explicit `field:` so
 * PascalCase TS names map to snake_case DB columns without lodash
 * mangling identifiers (`CharacterID` -> `character_id`, not
 * `character_i_d`).
 */
@Table({
  tableName: 'character_outfits',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class CharacterOutfit extends Model<
  InferAttributes<CharacterOutfit>,
  InferCreationAttributes<CharacterOutfit>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'character_id', allowNull: false })
  declare CharacterID: string;

  @BelongsTo(() => Character)
  declare Character?: Character;

  @Column({ type: DataType.STRING(32), field: 'name', allowNull: false })
  declare Name: string;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, field: 'is_active', allowNull: false })
  declare IsActive: CreationOptional<boolean>;

  @Column({ type: DataType.JSON, field: 'outfit_data', allowNull: false })
  declare OutfitData: OutfitData;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
