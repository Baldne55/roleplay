import { AutoIncrement, Column, DataType, Default, Model, PrimaryKey, Table } from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

/** What a log row records. */
export type PhoneLogKind = 'Sms' | 'Voicemail' | 'Call';
/** Direction of the row relative to its owning number. */
export type PhoneLogDirection = 'In' | 'Out' | 'Missed';

/**
 * One phone-log row: an SMS, a voicemail, or a call, recorded against the
 * `owner_number` (a phone NUMBER = item serial). An SMS / voicemail writes
 * two rows - sender `Out` (read) and recipient `In` (unread). History is
 * keyed by the number, NOT by character, so it deliberately follows the
 * handset through trades/drops (a found phone exposes its history - the
 * passcode lock is a later slice). `owner_number`/`peer_number` are
 * therefore plain strings, never FKs to characters.
 */
@Table({
  tableName: 'phone_log',
  timestamps: false,
  underscored: false,
})
export class PhoneLog extends Model<InferAttributes<PhoneLog>, InferCreationAttributes<PhoneLog>> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @Column({ type: DataType.STRING(32), field: 'owner_number', allowNull: false })
  declare OwnerNumber: string;

  @Column({ type: DataType.STRING(16), field: 'kind', allowNull: false })
  declare Kind: PhoneLogKind;

  @Column({ type: DataType.STRING(8), field: 'direction', allowNull: false })
  declare Direction: PhoneLogDirection;

  @Column({ type: DataType.STRING(32), field: 'peer_number', allowNull: false })
  declare PeerNumber: string;

  @Column({ type: DataType.TEXT, field: 'body', allowNull: true })
  declare Body: CreationOptional<string | null>;

  @Column({ type: DataType.INTEGER.UNSIGNED, field: 'duration_sec', allowNull: true })
  declare DurationSec: CreationOptional<number | null>;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, field: 'is_read', allowNull: false })
  declare IsRead: CreationOptional<boolean>;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;
}
