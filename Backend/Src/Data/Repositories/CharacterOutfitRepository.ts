import type { Transaction } from 'sequelize';
import { CharacterOutfit } from '@/Data/Models/CharacterOutfit.js';
import type { OutfitData } from '@Shared/Constants/Outfit.js';

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

  ListByCharacter(CharacterID: string): Promise<CharacterOutfit[]> {
    return CharacterOutfit.findAll({
      where: { CharacterID },
      order: [['CreatedAt', 'ASC']],
    });
  }

  FindActive(CharacterID: string): Promise<CharacterOutfit | null> {
    return CharacterOutfit.findOne({
      where: { CharacterID, IsActive: true },
    });
  }
}
