import {
  AutoIncrement,
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import { Character } from '@/Data/Models/Character.js';
import { InventoryItem } from '@/Data/Models/InventoryItem.js';

/** What a moderation request is asking to change on an item. */
export type ItemNameRequestKind = 'Name' | 'Description' | 'Deface';

/**
 * Pending player-submitted custom name or description awaiting staff
 * review (decisions 14, 44). One unified table - the `kind`
 * discriminator routes the approval write to either
 * `inventory_items.custom_name` or `metadata_json.Description`.
 *
 * Per-character cap (decision 36) is enforced in the service layer.
 * Per-(item, kind) uniqueness is DB-enforced so a re-submission of
 * the same kind replaces the prior request without a separate delete.
 */
@Table({
  tableName: 'item_name_requests',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class ItemNameRequest extends Model<
  InferAttributes<ItemNameRequest>,
  InferCreationAttributes<ItemNameRequest>
> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @ForeignKey(() => InventoryItem)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'inventory_item_id', allowNull: false })
  declare InventoryItemID: string;

  @BelongsTo(() => InventoryItem)
  declare InventoryItem?: InventoryItem;

  @Column({
    type: DataType.ENUM('Name', 'Description', 'Deface'),
    field: 'kind',
    allowNull: false,
  })
  declare Kind: ItemNameRequestKind;

  @Column({ type: DataType.STRING(512), field: 'requested_text', allowNull: false })
  declare RequestedText: string;

  @ForeignKey(() => Character)
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'requested_by_character_id', allowNull: false })
  declare RequestedByCharacterID: string;

  @BelongsTo(() => Character, 'RequestedByCharacterID')
  declare RequestedBy?: Character;

  @Column({ type: DataType.DATE, field: 'requested_at', allowNull: false })
  declare RequestedAt: Date;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}
