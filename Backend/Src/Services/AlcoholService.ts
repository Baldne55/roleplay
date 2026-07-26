import {
  BacPercentFromGrams,
  DecayedEthanolGrams,
  MaxStoredEthanolGrams,
} from '@Shared/Constants/Alcohol.js';
import { Logger } from '@/Util/Logger.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { AsyncLock } from '@/Services/AsyncLock.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';

/**
 * Blood-alcohol bookkeeping (the Widmark slice). Two verbs only:
 *
 *   - `Ingest` folds one consumed drink's ethanol grams into the
 *     character row (decay-to-now first, then add, then stamp).
 *   - `ReadBacPercent` projects the stored grams through the lazy
 *     elimination curve into a BAC percentage without writing.
 *
 * The row is the single source of truth - no in-memory cache, so a
 * relog, a character switch, or a server restart all read the same
 * number. Intoxication EFFECTS (movement, camera, screen) stay
 * deferred to the bar slice; this service only keeps the number true
 * so the drinks' ABV values and the breathalyzer have something real
 * to act on.
 */
export class AlcoholService {
  private readonly Log = Logger.New('Alcohol');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Characters: CharacterRepository,
    private readonly Lock: AsyncLock,
  ) {}

  /**
   * Fold one consumed drink into the drinker's stored blood alcohol.
   * Fire-and-forget from the command layer: a failed write loses one
   * drink's worth of BAC, never the consumable itself. The
   * read-modify-write is serialised per character through the shared
   * AsyncLock (the 'Alcohol:' key prefix cannot collide with the
   * inventory-ID keys) so two drinks downed back-to-back cannot read
   * the same base value and overwrite each other's grams.
   */
  async Ingest(Source: number, EthanolGrams: number): Promise<void> {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.CharacterID === null) return;
    if (!Number.isFinite(EthanolGrams) || EthanolGrams <= 0) return;
    const CharacterID = PlayerState.CharacterID;
    try {
      const Release = await this.Lock.Acquire(`Alcohol:${CharacterID}`);
      try {
        const Stored = await this.Characters.FindBloodAlcohol(CharacterID);
        if (Stored === null) return;
        const Now = new Date();
        const Current =
          Stored.At === null
            ? 0
            : DecayedEthanolGrams(Stored.Grams, Now.getTime() - Stored.At.getTime());
        const Next = Math.min(MaxStoredEthanolGrams, Current + EthanolGrams);
        await this.Characters.SaveBloodAlcohol(CharacterID, Next, Now);
      } finally {
        Release();
      }
    } catch (Err: unknown) {
      this.Log.Warn(`Ingest failed source=${Source}`, { Err: String(Err) });
    }
  }

  /**
   * Current BAC percentage for a character, decayed to now. Read-only:
   * the row is not re-stamped, so back-to-back tests cannot drift the
   * stored value through rounding.
   */
  async ReadBacPercent(CharacterID: string): Promise<number> {
    const Stored = await this.Characters.FindBloodAlcohol(CharacterID);
    if (Stored === null || Stored.At === null) return 0;
    const Grams = DecayedEthanolGrams(Stored.Grams, Date.now() - Stored.At.getTime());
    return BacPercentFromGrams(Grams);
  }
}
