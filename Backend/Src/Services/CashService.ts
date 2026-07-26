import { CanonicalCurrencyTypeID, CashCentsPerDollar } from '@Shared/Constants/Inventory.js';
import type {
  InventoryAddResult,
  InventoryRemoveResult,
  InventoryService,
} from '@/Services/InventoryService.js';
import type { InventoryRepository } from '@/Data/Repositories/InventoryRepository.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/**
 * Cash facade. Currency is the first `inventory_items` row Round 4
 * ever materialises; this thin wrapper hides the "cash is an item"
 * truth from callers that just want to know "how much money does
 * this character have" or "credit them N cents".
 *
 * Storage unit is integer **cents**. The dollar wrapper is provided
 * for chat / log output only; do not round-trip dollars through the
 * service - precision loss accumulates fast.
 *
 * Phase 1 reads: GetTotalCents / GetTotal (dollars).
 * Phase 1 writes: Add / Remove (system + admin paths).
 * Future Transfer between two characters lands with `/item give` in
 * Phase 2.
 */
export class CashService {
  constructor(
    private readonly Inventory: InventoryService,
    private readonly Repo: InventoryRepository,
    private readonly State: PlayerStateService,
  ) {}

  /** Sum of every currency row for the character, valued in cents. */
  GetTotalCents(CharacterID: string): Promise<number> {
    return this.Repo.CountCurrencyCentsForCharacter(CharacterID);
  }

  /** Dollar projection - convenience for chat / log; loses precision. */
  async GetTotal(CharacterID: string): Promise<number> {
    return (await this.GetTotalCents(CharacterID)) / CashCentsPerDollar;
  }

  /**
   * Credit the character's inventory by `Cents`. Caller-attributable
   * (Source / Account) so the audit log captures who minted the cash;
   * defaults to system attribution for starter-grant / payroll paths
   * where there is no caller.
   */
  async Add(
    CharacterID: string,
    Cents: number,
    Options: { ActorSource?: number; ActorAccountID?: string; Reason?: string } = {},
  ): Promise<InventoryAddResult> {
    if (!Number.isFinite(Cents) || !Number.isInteger(Cents) || Cents <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    const Inv = await this.Inventory.GetInventoryForCharacter(CharacterID);
    return await this.Inventory.AddItem(Inv.ID, CanonicalCurrencyTypeID, Cents, {
      ActorSource: Options.ActorSource ?? null,
      ActorCharacterID: CharacterID,
      ActorAccountID: Options.ActorAccountID ?? null,
      Reason: Options.Reason ?? null,
      Action: Options.ActorAccountID !== undefined ? 'AdminGive' : 'Add',
    });
  }

  /**
   * Debit the character by `Cents`. The whole walk - planning the
   * largest-denomination-first takes, the NotEnoughQuantity gate, and
   * every row decrement - runs inside InventoryService.RemoveCurrency
   * as ONE locked transaction, so a failed debit never costs the
   * player anything and `Ok` always means fully debited. This facade
   * only validates input and supplies attribution.
   */
  async Remove(
    CharacterID: string,
    Cents: number,
    Options: { ActorSource?: number; ActorAccountID?: string; Reason?: string } = {},
  ): Promise<InventoryRemoveResult> {
    if (!Number.isFinite(Cents) || !Number.isInteger(Cents) || Cents <= 0) {
      return { Outcome: 'InvalidQuantity' };
    }
    const Inv = await this.Inventory.GetInventoryForCharacter(CharacterID);
    return await this.Inventory.RemoveCurrency(Inv.ID, Cents, {
      ActorSource: Options.ActorSource ?? null,
      ActorCharacterID: CharacterID,
      ActorAccountID: Options.ActorAccountID ?? null,
      Reason: Options.Reason ?? null,
      Action: Options.ActorAccountID !== undefined ? 'AdminRemove' : 'Remove',
    });
  }

  /**
   * Resolve `Source` -> character cash total in cents. Returns 0
   * when the Source has no spawned character (no inventory yet).
   */
  async GetTotalCentsForSource(Source: number): Promise<number> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.CharacterID === null) return 0;
    return await this.GetTotalCents(PlayerState.CharacterID);
  }
}
