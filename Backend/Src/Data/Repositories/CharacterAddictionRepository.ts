import type { DrugClass } from '@Shared/Constants/Drugs.js';
import { CharacterAddiction } from '@/Data/Models/CharacterAddiction.js';

/**
 * Addiction-ledger access. Reads return the raw stored level + stamp;
 * the lazy abstinence decay belongs to the caller
 * (Shared/Constants/Drugs.ts DecayedAddictionLevel) so the row never
 * needs a maintenance write.
 */
export class CharacterAddictionRepository {
  /** Every addiction track for a character - one row per drug class held. */
  FindByCharacter(CharacterID: string): Promise<CharacterAddiction[]> {
    return CharacterAddiction.findAll({ where: { CharacterID } });
  }

  /** Batched ledger read for the withdrawal sweep - one query per sweep, not per player. */
  FindByCharacters(CharacterIDs: readonly string[]): Promise<CharacterAddiction[]> {
    if (CharacterIDs.length === 0) return Promise.resolve([]);
    return CharacterAddiction.findAll({ where: { CharacterID: CharacterIDs as string[] } });
  }

  /**
   * One character's track for one drug class. Hits the unique index on
   * `(character_id, drug_class)`, so at most one row can exist - a player
   * cannot dodge withdrawal by rotating between items of the same class.
   */
  FindOne(CharacterID: string, Class: DrugClass): Promise<CharacterAddiction | null> {
    return CharacterAddiction.findOne({ where: { CharacterID, DrugClass: Class } });
  }

  /** Write the decayed-then-adjusted level with a fresh dose stamp. */
  async SaveDose(
    CharacterID: string,
    Class: DrugClass,
    Level: number,
    LastDoseAt: Date,
  ): Promise<void> {
    const Existing = await CharacterAddiction.findOne({
      where: { CharacterID, DrugClass: Class },
    });
    if (Existing === null) {
      await CharacterAddiction.create({
        CharacterID,
        DrugClass: Class,
        Level: Level.toFixed(2),
        LastDoseAt,
      });
      return;
    }
    await Existing.update({ Level: Level.toFixed(2), LastDoseAt });
  }
}
