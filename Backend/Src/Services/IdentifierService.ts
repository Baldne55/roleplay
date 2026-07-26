import { randomInt } from 'node:crypto';
import { Logger } from '@/Util/Logger.js';
import type { InventoryRepository } from '@/Data/Repositories/InventoryRepository.js';
import type { GroundDropRepository } from '@/Data/Repositories/GroundDropRepository.js';

/** Namespace an identifier belongs to; each has its own format and uniqueness scope. */
export type IdentifierDomain = 'Weapon' | 'Phone' | 'License' | 'Document' | 'Radio';

/**
 * Per-domain identifier minter. Each domain has its own format + scope:
 *
 *   - Weapon    -> 8-char Crockford base32 serial (e.g. `K7A2F9X1`).
 *   - Phone     -> 7 digits with `555-` prefix    (e.g. `555-4429183`).
 *   - License   -> 2-letter prefix + 4 alphanumeric + `-` + 2 digits
 *                  (e.g. `DR-A4D9-22`); prefix per sub-domain.
 *   - Document  -> 10-char Crockford base32       (e.g. `D9KX2A7BCM`).
 *   - Radio     -> 6 digits                       (e.g. `883124`).
 *
 * Uniqueness scope: `inventory_items.unique_serial` is unique-indexed
 * across all rows; ground_drops will join that uniqueness check in
 * Phase 2. The mint loop retries up to 16 attempts; the per-domain
 * collision space is far too large for that to fail in practice.
 *
 * Identifiers are NEVER reused. A defaced weapon's null replaces the
 * serial on the row; future mints of the same character set may yield
 * the same string by chance and that's fine - they're new identities.
 * The forensic log keeps the pre-deface value for trace queries.
 */
export class IdentifierService {
  private readonly Log = Logger.New('Identifier');

  /** Crockford base32 - excludes I, L, O, U to keep hand-written / spoken IDs unambiguous. */
  private static readonly Base32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  private static readonly Digits = '0123456789';

  constructor(
    private readonly Inventory: InventoryRepository,
    private readonly Ground: GroundDropRepository,
  ) {}

  /**
   * 8-character Crockford base32 weapon serial - the identity every
   * ballistics query keys on, and the thing `/aitem removeserial`
   * destroys.
   */
  MintWeaponSerial(): Promise<string> {
    return this.MintUnique(() => this.RandomString(8, IdentifierService.Base32));
  }

  /**
   * A `555-` phone number. The number IS the handset's serial, which is
   * why phone history follows the physical device rather than a character.
   * Digits only - a phone number has to be dialable.
   */
  MintPhoneNumber(): Promise<string> {
    return this.MintUnique(() => `555-${this.RandomString(7, IdentifierService.Digits)}`);
  }

  /**
   * A licence number prefixed from its sub-domain (`Driver` -> `DR`), so
   * the document type is readable from the number alone.
   */
  MintLicenseNumber(SubDomain: string): Promise<string> {
    // 2-letter prefix from the sub-domain, e.g. 'Driver' -> 'DR',
    // 'Weapon' -> 'WP'. Falls back to 'LC' (License) if the sub-domain
    // is shorter than 2 letters.
    const PrefixRaw = SubDomain.slice(0, 2).toUpperCase();
    const Prefix = PrefixRaw.length === 2 ? PrefixRaw : 'LC';
    return this.MintUnique(() => {
      const Body = this.RandomString(4, IdentifierService.Base32);
      const Tail = this.RandomString(2, IdentifierService.Digits);
      return `${Prefix}-${Body}-${Tail}`;
    });
  }

  /** 10-character document number - longer than a weapon serial, since
   * documents are the identity surface players read aloud most often. */
  MintDocumentSerial(): Promise<string> {
    return this.MintUnique(() => this.RandomString(10, IdentifierService.Base32));
  }

  /**
   * A 6-digit radio frequency. Digits only so it can be spoken and typed
   * as a number, and minted unique so two radios never share a channel by
   * accident.
   */
  MintRadioFrequency(): Promise<string> {
    return this.MintUnique(() => this.RandomString(6, IdentifierService.Digits));
  }

  /**
   * Generic mint loop. Calls `Generator` until the candidate is not
   * already in use (collision check against `inventory_items.unique_serial`,
   * and once Phase 2 lands, also `ground_drops.unique_serial`). Throws
   * after 16 attempts so a misbehaving generator does not spin forever.
   */
  private async MintUnique(Generator: () => string): Promise<string> {
    for (let Attempt = 0; Attempt < 16; Attempt += 1) {
      const Candidate = Generator();
      // Cross-table uniqueness: an item's serial is one identity, and
      // the row can live in either `inventory_items` or `ground_drops`
      // depending on whether it is currently held. Check both before
      // accepting the candidate.
      const InInventory = await this.Inventory.FindByUniqueSerial(Candidate);
      if (InInventory !== null) {
        this.Log.Warn(`Identifier collision on '${Candidate}' (inventory, attempt ${Attempt + 1})`);
        continue;
      }
      const InGround = await this.Ground.FindByUniqueSerial(Candidate);
      if (InGround !== null) {
        this.Log.Warn(`Identifier collision on '${Candidate}' (ground, attempt ${Attempt + 1})`);
        continue;
      }
      return Candidate;
    }
    throw new Error('IdentifierService.MintUnique exhausted attempts');
  }

  /**
   * Random string from a charset using `randomInt` - crypto-grade, not
   * `Math.random`. Serials gate forensic identity, so a predictable
   * generator would let a player guess another's weapon serial or phone
   * number.
   */
  private RandomString(Length: number, Charset: string): string {
    let Out = '';
    for (let I = 0; I < Length; I += 1) {
      Out += Charset[randomInt(0, Charset.length)];
    }
    return Out;
  }
}
