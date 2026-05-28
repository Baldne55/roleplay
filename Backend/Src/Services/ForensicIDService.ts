import { randomInt } from 'node:crypto';
import { ForensicIDCharset, ForensicIDLength } from '@Shared/Constants/Character.js';
import { Logger } from '@/Util/Logger.js';

/**
 * Generator for forensic / financial identifiers used on Character rows:
 * MaskID, DnaID, FingerprintID, SsnID, and BankAccountNumber.
 *
 * Format: ten Crockford base32 chars (see ForensicIDCharset).
 * Generation: crypto-random; collision check delegated to the caller via
 * an `IsTaken` predicate so the same generator works for any column.
 *
 *   const ID = await Forensic.GenerateUnique(async (Candidate) =>
 *     await Characters.IsMaskIDTaken(Candidate),
 *   );
 *
 * Display format ("XXXXX-XXXXX") is a UI concern - storage is the raw
 * 10-char string, lookups compare raw.
 */
export class ForensicIDService {
  private readonly Log = Logger.New('Forensic');

  /** Single 10-char Crockford base32 identifier. Pure - no DB access. */
  Generate(): string {
    let Out = '';
    for (let I = 0; I < ForensicIDLength; I += 1) {
      Out += ForensicIDCharset[randomInt(0, ForensicIDCharset.length)];
    }
    return Out;
  }

  /**
   * Generate and retry until `IsTaken` returns false. Collisions in a
   * 32^10 namespace are effectively impossible, but the retry loop is
   * still bounded so a misbehaving caller (or a runaway test seeder)
   * cannot spin forever.
   */
  async GenerateUnique(
    IsTaken: (Candidate: string) => Promise<boolean>,
    Attempts = 8,
  ): Promise<string> {
    for (let Try = 0; Try < Attempts; Try += 1) {
      const Candidate = this.Generate();
      if (!(await IsTaken(Candidate))) return Candidate;
      this.Log.Warn(`Collision on forensic ID candidate ${Candidate} (attempt ${Try + 1})`);
    }
    throw new Error(`Could not generate a unique forensic ID after ${Attempts} attempts`);
  }
}
