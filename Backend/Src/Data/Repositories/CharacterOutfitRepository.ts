import type { Transaction } from 'sequelize';
import { CharacterOutfit } from '@/Data/Models/CharacterOutfit.js';
import type { OutfitData } from '@Shared/Constants/Outfit.js';

/**
 * A saved outfit. `IsActive` marks the one currently worn - the creation
 * flow inserts the starter outfit as Name="Default" with IsActive true,
 * in the same transaction as the character row.
 */
export interface CreateOutfitInput {
  CharacterID: string;
  Name: string;
  IsActive: boolean;
  OutfitData: OutfitData;
}

/**
 * Outfit data access. SQL-thin wrapper around the CharacterOutfit model;
 * the "one IsActive per character" rule lives in the service layer, not
 * here.
 *
 * Create accepts an optional Sequelize transaction so the service can
 * insert the starter outfit in the same atomic unit as the character row.
 */
export class CharacterOutfitRepository {
  /**
   * Insert an outfit. Takes an optional transaction so the starter outfit
   * can be written in the same unit as the character row - a character
   * must never exist with nothing to wear.
   */
  async Create(Input: CreateOutfitInput, T?: Transaction): Promise<{ ID: string }> {
    const Row = await CharacterOutfit.create(
      {
        CharacterID: Input.CharacterID,
        Name: Input.Name,
        IsActive: Input.IsActive,
        OutfitData: Input.OutfitData,
      },
      T !== undefined ? { transaction: T } : undefined,
    );
    return { ID: Row.ID };
  }

  /** All saved outfits for a character, worn or not. */
  ListByCharacter(CharacterID: string): Promise<CharacterOutfit[]> {
    return CharacterOutfit.findAll({
      where: { CharacterID },
      order: [['CreatedAt', 'ASC']],
    });
  }

  /**
   * The outfit currently worn. Read on spawn to dress the ped; null only
   * if the IsActive flag was lost, which leaves the ped in model default.
   */
  FindActive(CharacterID: string): Promise<CharacterOutfit | null> {
    return CharacterOutfit.findOne({
      where: { CharacterID, IsActive: true },
    });
  }
}
