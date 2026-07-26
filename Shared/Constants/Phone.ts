/**
 * Phone constants and the per-handset state carried in item metadata.
 *
 * A phone is an inventory item; its phone NUMBER is the item's minted
 * UniqueSerial (`555-DDDDDDD`), so the number travels with the handset
 * through trades, drops and pickups. Per-handset state (power, credit
 * balance, saved contacts) lives in the item's `metadata_json` under a
 * single `Phone` key; message / call history lives in the `phone_log`
 * table keyed by number, not here. Which of several carried phones is
 * "active" is a CHARACTER fact (characters.active_phone_serial), not a
 * handset fact, so two handsets can never both claim to be the main one.
 *
 * Text only, no voice. SMS and voicemail are delivered by phone number
 * (offline-tolerant); calls are a live relay between two online holders.
 */

/** Saved contact: a player-chosen label for a phone number. */
export interface PhoneContact {
  Name: string;
  Number: string;
}

/** Per-handset state stored under the `Phone` key of an item's metadata. */
export interface PhoneMetadata {
  /** A powered-down phone neither sends nor receives. */
  IsOn: boolean;
  /** Pre-paid balance in whole cents; every billable action gates on it. */
  CreditsCents: number;
  /** Saved name<->number contacts (capped at ContactsCap). */
  Contacts: PhoneContact[];
}

/** The metadata key the handset state nests under, inside metadata_json. */
export const PhoneMetadataKey = 'Phone';

/**
 * Flat scalar seeded into a fresh phone's DefaultMetadata. DefaultMetadata
 * only accepts flat string/number values, so the credit float cannot be
 * nested; NormalizePhoneMetadata reads it as the starting balance until
 * the first real write replaces it with the structured `Phone` blob.
 */
export const PhoneSeedCreditsKey = 'PhoneCreditsCents';

/** Inclusive shape of a phone number: the minted `555-DDDDDDD` serial. */
export const PhoneNumberPattern = /^555-\d{7}$/;

/** Most saved contacts a single handset may hold. */
export const ContactsCap = 50;
/** Longest a saved contact label may be. */
export const ContactNameMax = 24;
/** Longest a single SMS / voicemail body may be. */
export const MessageBodyMax = 160;

/** Per-action charges, in whole cents. */
export const SmsCostCents = 10;
export const VoicemailCostCents = 10;
export const CallCostCentsPerMinute = 50;

/** A fresh handset is sold with this balance (seeded via DefaultMetadata). */
export const StartingCreditsCents = 2_500;

/**
 * Hard ceiling on a handset balance. Admin top-ups clamp to this so a
 * fat-fingered or repeated grant cannot push the balance past the safe
 * integer range and corrupt it through the JSON-number round-trip.
 */
export const MaxPhoneCreditsCents = 100_000_000;

/** A ringing call gives up after this long with no answer. */
export const RingTimeoutMs = 30_000;
/** A billed minute, in milliseconds (the call billing unit). */
export const CallBillIntervalMs = 60_000;

/** True when `Value` is a well-formed phone number. */
export function IsValidPhoneNumber(Value: string): boolean {
  return PhoneNumberPattern.test(Value);
}

/**
 * True when `Value` is an acceptable saved-contact label: non-empty,
 * within the length cap, and free of control characters / newlines (which
 * could otherwise forge a second chat line when the name is rendered).
 */
export function IsValidContactName(Value: string): boolean {
  const Trimmed = Value.trim();
  if (Trimmed.length === 0 || Trimmed.length > ContactNameMax) return false;
  for (let Index = 0; Index < Trimmed.length; Index += 1) {
    const Code = Trimmed.charCodeAt(Index);
    if (Code < 0x20 || Code === 0x7f) return false;
  }
  return true;
}

/** Off, zero balance, no contacts - the state a normalize falls back to. */
export function DefaultPhoneMetadata(): PhoneMetadata {
  return { IsOn: false, CreditsCents: 0, Contacts: [] };
}

/**
 * Coerce a raw item-metadata blob into a well-formed PhoneMetadata.
 * Reads the structured `Phone` sub-object when present; otherwise
 * synthesises the starting state from the flat `PhoneCreditsCents` seed
 * (a freshly created handset) or the zero default (a legacy handset that
 * predates the phone system). Clamps credits to a non-negative integer
 * and drops malformed / over-cap contacts so the runtime always holds a
 * valid blob.
 */
export function NormalizePhoneMetadata(
  Meta: Record<string, unknown> | null | undefined,
): PhoneMetadata {
  const Raw = Meta ?? {};
  const Nested = (Raw as { [PhoneMetadataKey]?: unknown })[PhoneMetadataKey];
  if (Nested !== null && typeof Nested === 'object') {
    const Source = Nested as Partial<PhoneMetadata>;
    return {
      IsOn: Source.IsOn === true,
      CreditsCents: SanitizeCents(Source.CreditsCents),
      Contacts: SanitizeContacts(Source.Contacts),
    };
  }
  const Seed = (Raw as { [PhoneSeedCreditsKey]?: unknown })[PhoneSeedCreditsKey];
  return { IsOn: false, CreditsCents: SanitizeCents(Seed), Contacts: [] };
}

/**
 * Coerce a stored credit balance to a non-negative whole number of cents.
 *
 * Metadata is persisted JSON that admin `/aitem create` payloads and old
 * migrations can both write, so a negative or fractional balance is
 * possible on disk; clamping here keeps it from reaching the billing
 * arithmetic.
 */
function SanitizeCents(Value: unknown): number {
  if (typeof Value !== 'number' || !Number.isFinite(Value)) return 0;
  return Math.max(0, Math.floor(Value));
}

/**
 * Rebuild the contact list from stored metadata, dropping any entry that
 * is not a well-formed `{Name, Number}` pair.
 *
 * Skips malformed entries rather than rejecting the list, so one bad row
 * cannot wipe a player's whole phonebook.
 */
function SanitizeContacts(Value: unknown): PhoneContact[] {
  if (!Array.isArray(Value)) return [];
  const Out: PhoneContact[] = [];
  for (const Entry of Value) {
    if (Entry === null || typeof Entry !== 'object') continue;
    const Name = (Entry as Partial<PhoneContact>).Name;
    const Number = (Entry as Partial<PhoneContact>).Number;
    if (typeof Name !== 'string' || typeof Number !== 'string') continue;
    if (!IsValidContactName(Name) || !IsValidPhoneNumber(Number)) continue;
    Out.push({ Name: Name.trim(), Number });
    if (Out.length >= ContactsCap) break;
  }
  return Out;
}
