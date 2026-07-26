import { ItemNameRequest, type ItemNameRequestKind } from '@/Data/Models/ItemNameRequest.js';

/**
 * Unified name + description request queue (decision 44). The `kind`
 * discriminator selects the approval write target - approved Name
 * lands on `inventory_items.custom_name`; approved Description lands
 * on `metadata_json.Description`.
 */
export class ItemNameRequestRepository {
  /**
   * Insert-or-replace a request. A second submission of the same
   * (inventory_item_id, kind) replaces the prior pending row.
   */
  async Upsert(
    InventoryItemID: string,
    Kind: ItemNameRequestKind,
    RequestedText: string,
    RequestedByCharacterID: string,
  ): Promise<ItemNameRequest> {
    const Existing = await ItemNameRequest.findOne({
      where: { InventoryItemID, Kind },
    });
    if (Existing !== null) {
      Existing.RequestedText = RequestedText;
      Existing.RequestedByCharacterID = RequestedByCharacterID;
      Existing.RequestedAt = new Date();
      await Existing.save();
      return Existing;
    }
    return await ItemNameRequest.create({
      InventoryItemID,
      Kind,
      RequestedText,
      RequestedByCharacterID,
      RequestedAt: new Date(),
    });
  }

  /** One pending request by id - the argument `/aitem approve|deny` takes. */
  FindByID(ID: string): Promise<ItemNameRequest | null> {
    return ItemNameRequest.findByPk(ID);
  }

  /** A page of the moderation queue, backing `/aitem requests [page]`. */
  ListPending(Limit: number, Offset: number): Promise<ItemNameRequest[]> {
    return ItemNameRequest.findAll({
      order: [['RequestedAt', 'ASC']],
      limit: Limit,
      offset: Offset,
    });
  }

  /**
   * Remove a request from the queue.
   *
   * Both approve and deny end here - the queue holds only *pending* work,
   * so a resolved request is deleted rather than marked. The approved
   * text lives on the item; a denial leaves no trace.
   */
  async Delete(ID: string): Promise<void> {
    await ItemNameRequest.destroy({ where: { ID } });
  }

  /**
   * Count pending submissions of a given kind for a character. Used
   * to enforce the per-character cap (decision 36).
   */
  async CountByCharacterAndKind(
    CharacterID: string,
    Kind: ItemNameRequestKind,
  ): Promise<number> {
    return await ItemNameRequest.count({
      where: { RequestedByCharacterID: CharacterID, Kind },
    });
  }

  /** Total pending requests across all kinds + characters. */
  async CountPending(): Promise<number> {
    return await ItemNameRequest.count();
  }
}
