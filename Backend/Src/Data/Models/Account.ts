import {
  AutoIncrement,
  Column,
  DataType,
  Default,
  Model,
  PrimaryKey,
  Table,
  Unique,
} from 'sequelize-typescript';
import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';
import type { AccountSettings } from '@Shared/Constants/AccountSettings.js';

/** Account lifecycle. `Pending` predates first successful sign-in; `Banned` blocks connection. */
export type AccountStatus = 'Pending' | 'Active' | 'Banned';
/**
 * Staff tier, ascending. Compared through StaffLevelRanking.StaffMeets - a
 * tier satisfies every gate at or below it. Distinct from admin duty,
 * which is whether that authority is currently switched on.
 */
export type StaffLevel = 'None' | 'Helper' | 'Moderator' | 'Administrator' | 'Founder';
/** Donator tier. Cosmetic today; reserved for future perk gating. */
export type PremiumTier = 'None' | 'Bronze' | 'Silver' | 'Gold' | 'Platinum';

/**
 * Persistent account record. One per FXServer license; bound to a Discord
 * identity on first OAuth. Characters belong to an Account (FK landed when
 * the Character model ships).
 *
 *   - `License`     primary lookup key on every connect.
 *   - `DiscordID`   Discord snowflake; null until first OAuth completes.
 *                   Stored as BIGINT UNSIGNED in DB, surfaced as `string`
 *                   in TS (snowflakes overflow JS Number, mysql2 returns
 *                   BIGINT as string by default).
 *   - `Status`      Pending until OAuth completes, then Active. Banned is
 *                   terminal until lifted manually.
 *   - `PremiumTier` + `PremiumExpiresAt`:
 *       tier='None'                     -> no premium (expires_at MUST be null,
 *                                           DB-enforced via CHECK constraint)
 *       tier!='None', expires_at=null   -> permanent / lifetime
 *       tier!='None', expires_at=Date   -> timed; check vs now
 *     The rule lives in HasActivePremium() so call sites never reimplement it.
 *
 * Every column carries an explicit `field` mapping because the Sequelize
 * `underscored: true` flag converts PascalCase via lodash snakeCase, which
 * mangles all-caps acronyms (`DiscordID` -> `discord_i_d`). Explicit mapping
 * keeps the TS surface PascalCase + acronym-correct while the DB stays
 * snake_case.
 */
@Table({
  tableName: 'accounts',
  timestamps: true,
  createdAt: 'CreatedAt',
  updatedAt: 'UpdatedAt',
  underscored: false,
})
export class Account extends Model<InferAttributes<Account>, InferCreationAttributes<Account>> {
  @PrimaryKey
  @AutoIncrement
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'id' })
  declare ID: CreationOptional<string>;

  @Unique
  @Column({ type: DataType.STRING(64), field: 'license', allowNull: false })
  declare License: string;

  @Unique
  @Column({ type: DataType.BIGINT.UNSIGNED, field: 'discord_id', allowNull: true })
  declare DiscordID: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(48), field: 'discord_username', allowNull: true })
  declare DiscordUsername: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(48), field: 'discord_display_name', allowNull: true })
  declare DiscordDisplayName: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), field: 'discord_avatar', allowNull: true })
  declare DiscordAvatar: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(254), field: 'discord_email', allowNull: true })
  declare DiscordEmail: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(64), field: 'last_social_club_name', allowNull: true })
  declare LastSocialClubName: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(45), field: 'last_ip', allowNull: true })
  declare LastIP: CreationOptional<string | null>;

  @Column({ type: DataType.STRING(45), field: 'registration_ip', allowNull: true })
  declare RegistrationIP: CreationOptional<string | null>;

  @Default('Pending')
  @Column({
    type: DataType.ENUM('Pending', 'Active', 'Banned'),
    field: 'status',
    allowNull: false,
  })
  declare Status: CreationOptional<AccountStatus>;

  @Default('None')
  @Column({
    type: DataType.ENUM('None', 'Helper', 'Moderator', 'Administrator', 'Founder'),
    field: 'staff_level',
    allowNull: false,
  })
  declare StaffLevel: CreationOptional<StaffLevel>;

  @Default('None')
  @Column({
    type: DataType.ENUM('None', 'Bronze', 'Silver', 'Gold', 'Platinum'),
    field: 'premium_tier',
    allowNull: false,
  })
  declare PremiumTier: CreationOptional<PremiumTier>;

  @Column({ type: DataType.DATE, field: 'premium_expires_at', allowNull: true })
  declare PremiumExpiresAt: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, field: 'last_oauth_at', allowNull: true })
  declare LastOAuthAt: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, field: 'first_login_at', allowNull: true })
  declare FirstLoginAt: CreationOptional<Date | null>;

  @Column({ type: DataType.DATE, field: 'last_login_at', allowNull: true })
  declare LastLoginAt: CreationOptional<Date | null>;

  @Default(false)
  @Column({ type: DataType.BOOLEAN, field: 'is_deleted', allowNull: false })
  declare IsDeleted: CreationOptional<boolean>;

  /**
   * Free-form per-account preferences (theme, chat font, etc.). NULL on
   * fresh accounts; the resolver in Shared/Constants/AccountSettings
   * lazy-merges against DefaultAccountSettings so unset keys inherit the
   * canonical default until the user explicitly opts out.
   */
  @Column({ type: DataType.JSON, field: 'settings', allowNull: true })
  declare Settings: CreationOptional<AccountSettings | null>;

  @Column({ type: DataType.DATE, field: 'created_at', allowNull: false })
  declare CreatedAt: CreationOptional<Date>;

  @Column({ type: DataType.DATE, field: 'updated_at', allowNull: false })
  declare UpdatedAt: CreationOptional<Date>;
}

/**
 * Resolves whether an Account currently has active premium. Single source
 * of truth for the (tier, expiry) semantics:
 *
 *   tier='None'                     -> false
 *   tier!='None', expires_at=null   -> true  (permanent)
 *   tier!='None', expires_at=Date   -> expires_at > now()
 */
export function HasActivePremium(Account: Account): boolean {
  if (Account.PremiumTier === 'None') return false;
  if (Account.PremiumExpiresAt === null) return true;
  return Account.PremiumExpiresAt.getTime() > Date.now();
}
