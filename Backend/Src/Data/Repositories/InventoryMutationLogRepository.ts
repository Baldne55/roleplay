import { Op, type Transaction } from 'sequelize';
import type { InventoryMutationAction } from '@Shared/Constants/Inventory.js';
import { InventoryMutationLog } from '@/Data/Models/InventoryMutationLog.js';

/**
 * One row of the item audit trail - the record behind `/aitem history`
 * and `/aitem trace`.
 *
 * `TransactionID` is what ties a composite operation together: a give
 * writes a remove row and an add row sharing one id, which is how the
 * trace command proves an item moved rather than being duplicated. The
 * three actor fields are all nullable because a mutation may originate
 * from a player, an admin account, or the system itself.
 */
export interface AppendMutationFields {
  Action: InventoryMutationAction;
  TransactionID: string;
  ActorSource?: number | null;
  ActorCharacterID?: string | null;
  ActorAccountID?: string | null;
  ItemTypeID: string;
  Quantity?: number | null;
  UniqueSerial?: string | null;
  FromInventoryID?: string | null;
  FromSlotIndex?: number | null;
  ToInventoryID?: string | null;
  ToSlotIndex?: number | null;
  Reason?: string | null;
}

/**
 * Forensic-trail data access. Append-only (no Update method); rows are
 * facts about mutations that happened, never re-stated.
 *
 * Every Append is called **inside the caller's Sequelize transaction**
 * so the audit row commits or rolls back with the mutation itself
 * (decision 34). Reads are off-the-transaction by design - callers are
 * staff inspecting history.
 *
 * `Prune` (called by `/acleaninventorylog`) is the only destructive
 * path. Retention policy is staff-decided.
 */
export class InventoryMutationLogRepository {
  /**
   * Write one audit row.
   *
   * The transaction is REQUIRED, unlike the other repositories' optional
   * one: the log entry must commit with the mutation it describes, or the
   * trail silently diverges from what actually happened.
   */
  async Append(Fields: AppendMutationFields, T: Transaction): Promise<void> {
    await InventoryMutationLog.create(
      {
        Action: Fields.Action,
        TransactionID: Fields.TransactionID,
        ActorSource: Fields.ActorSource ?? null,
        ActorCharacterID: Fields.ActorCharacterID ?? null,
        ActorAccountID: Fields.ActorAccountID ?? null,
        ItemTypeID: Fields.ItemTypeID,
        Quantity: Fields.Quantity ?? null,
        UniqueSerial: Fields.UniqueSerial ?? null,
        FromInventoryID: Fields.FromInventoryID ?? null,
        FromSlotIndex: Fields.FromSlotIndex ?? null,
        ToInventoryID: Fields.ToInventoryID ?? null,
        ToSlotIndex: Fields.ToSlotIndex ?? null,
        Reason: Fields.Reason ?? null,
      },
      { transaction: T },
    );
  }

  /** One item's life story, newest first - backs `/aitem history`. */
  FindByUniqueSerial(Serial: string, Limit: number): Promise<InventoryMutationLog[]> {
    return InventoryMutationLog.findAll({
      where: { UniqueSerial: Serial },
      order: [['CreatedAt', 'ASC']],
      limit: Limit,
    });
  }

  /**
   * Every row of one transaction - backs `/aitem trace`.
   *
   * Unlimited by design: a transaction is bounded (a give is two rows),
   * and truncating it would hide exactly the half that proves an item
   * moved rather than being duplicated.
   */
  FindByTransactionID(TransactionID: string): Promise<InventoryMutationLog[]> {
    return InventoryMutationLog.findAll({
      where: { TransactionID },
      order: [['CreatedAt', 'ASC']],
    });
  }

  /** Everything one character did to items - the per-person audit view. */
  FindByCharacterID(
    CharacterID: string,
    Limit: number,
    Offset: number,
  ): Promise<InventoryMutationLog[]> {
    return InventoryMutationLog.findAll({
      where: { ActorCharacterID: CharacterID },
      order: [['CreatedAt', 'DESC']],
      limit: Limit,
      offset: Offset,
    });
  }

  /**
   * Every mutation touching one item type, across all players - the view
   * for investigating a suspected duplication of a specific item.
   */
  FindByItemTypeID(
    ItemTypeID: string,
    SinceMs: number,
    Limit: number,
  ): Promise<InventoryMutationLog[]> {
    return InventoryMutationLog.findAll({
      where: {
        ItemTypeID,
        CreatedAt: { [Op.gte]: new Date(SinceMs) },
      },
      order: [['CreatedAt', 'DESC']],
      limit: Limit,
    });
  }

  /**
   * Delete every row older than `OlderThan`. Returns the count for
   * staff confirmation. Use carefully - the trail is forensic.
   */
  async Prune(OlderThan: Date): Promise<number> {
    return await InventoryMutationLog.destroy({
      where: { CreatedAt: { [Op.lt]: OlderThan } },
    });
  }
}
