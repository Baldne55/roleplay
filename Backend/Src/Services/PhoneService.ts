import { ChatColor, ChatFormatter, Sanitize } from '@Shared/Chat/Index.js';
import { FormatCashCents } from '@Shared/Constants/Inventory.js';
import {
  ContactsCap,
  IsValidContactName,
  IsValidPhoneNumber,
  MaxPhoneCreditsCents,
  MessageBodyMax,
  SmsCostCents,
  VoicemailCostCents,
  type PhoneContact,
  type PhoneMetadata,
} from '@Shared/Constants/Phone.js';
import { Logger } from '@/Util/Logger.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { PhoneLogRepository } from '@/Data/Repositories/PhoneLogRepository.js';

/** Outcome of a phone operation, mapped to a CommandResult by the caller. */
export type PhoneActionResult = { Ok: true; Message?: string } | { Ok: false; Reason: string };

/** A resolved active handset plus the full set of numbers the player holds. */
export interface ActivePhone {
  Number: string;
  Meta: PhoneMetadata;
  Held: string[];
}

/** Rows `/phone sms log` returns when the player names no count. */
const SmsLogDefault = 10;
/** Ceiling on a requested count - each row is its own chat line. */
const SmsLogMax = 30;

/**
 * Chat-command text phone. A handset is an inventory item; its number is
 * the item serial, its state (power, credit, contacts) is item metadata,
 * and which carried handset is "active" is a character fact resolved live
 * every call so a traded/dropped phone can never act on the old owner's
 * behalf. SMS and voicemail are delivered by number (offline-tolerant and
 * persisted to phone_log); the live copy carries the recipient's saved
 * contact name for the sender, or the bare number - never a legal name,
 * and never the OOC server-ID prefix that would de-anonymise it.
 *
 * Calls (the live two-party relay) live in PhoneCallService.
 */
export class PhoneService {
  private readonly Log = Logger.New('Phone');

  constructor(
    private readonly Chat: ChatService,
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Inventory: InventoryService,
    private readonly PhoneLog: PhoneLogRepository,
    private readonly Characters: CharacterRepository,
  ) {}

  /** Power the active handset on or off. */
  async SetPower(Source: number, On: boolean): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (Active.Meta.IsOn === On) {
      return { Ok: true, Message: ChatFormatter.Info(`Your phone is already ${On ? 'on' : 'off'}.`) };
    }
    await this.Inventory.UpdatePhoneMetadata(Active.Number, (Meta) => {
      Meta.IsOn = On;
    });
    return { Ok: true, Message: ChatFormatter.Info(`Phone switched ${On ? 'on' : 'off'}.`) };
  }

  /** Choose which carried handset is active for /phone commands. */
  async SetMainPhone(Source: number, NumberArg: string): Promise<PhoneActionResult> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    if (!IsValidPhoneNumber(NumberArg)) {
      return { Ok: false, Reason: 'That is not a valid phone number.' };
    }
    const Held = await this.Inventory.ListHeldPhoneNumbers(Runtime.CharacterID);
    if (!Held.includes(NumberArg)) {
      return { Ok: false, Reason: 'You are not carrying a phone with that number.' };
    }
    this.Runtimes.SetActivePhoneSerial(Source, NumberArg);
    await this.Characters.SaveActivePhone(Runtime.CharacterID, NumberArg);
    return { Ok: true, Message: ChatFormatter.Info(`Active phone set to ${NumberArg}.`) };
  }

  /** Status card for the active handset (or guidance when there is none). */
  async Describe(Source: number): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: true, Message: ChatFormatter.Info(Active.Error) };
    const Lines: string[] = [
      ChatFormatter.Header('Phone', ChatColor.Header),
      ChatFormatter.Label('Number', Active.Number),
      ChatFormatter.Label('Power', Active.Meta.IsOn ? 'On' : 'Off'),
      ChatFormatter.Label('Credit', FormatCashCents(Active.Meta.CreditsCents)),
      ChatFormatter.Label('Contacts', String(Active.Meta.Contacts.length)),
    ];
    const UnreadSms = await this.PhoneLog.CountUnread(Active.Number, 'Sms');
    const UnreadVoicemail = await this.PhoneLog.CountUnread(Active.Number, 'Voicemail');
    if (UnreadSms > 0) Lines.push(ChatFormatter.Label('Unread texts', String(UnreadSms)));
    if (UnreadVoicemail > 0) Lines.push(ChatFormatter.Label('New voicemail', String(UnreadVoicemail)));
    if (Active.Held.length > 1) {
      Lines.push(ChatFormatter.Label('Carried', Active.Held.join(', ')));
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Header));
    return { Ok: true, Message: Lines.join('\n') };
  }

  // ── Contacts ────────────────────────────────────────────────────────

  /**
   * Save a number under a contact name on the caller's active phone.
   *
   * Contacts live in the handset's metadata, not against the character -
   * so they travel with the physical phone, and someone who takes it gets
   * the phonebook too.
   */
  async AddContact(Source: number, NumberArg: string, NameArg: string): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (!IsValidPhoneNumber(NumberArg)) {
      return { Ok: false, Reason: 'That is not a valid phone number.' };
    }
    const Name = NameArg.trim();
    if (!IsValidContactName(Name)) {
      return { Ok: false, Reason: `That contact name is not valid (1-24 characters, no line breaks).` };
    }
    let Result: PhoneActionResult = {
      Ok: true,
      Message: ChatFormatter.Info(`Saved ${Name} (${NumberArg}).`),
    };
    await this.Inventory.UpdatePhoneMetadata(Active.Number, (Meta) => {
      if (Meta.Contacts.some((C) => C.Number === NumberArg)) {
        Result = { Ok: false, Reason: 'A contact with that number already exists.' };
        return;
      }
      if (Meta.Contacts.some((C) => C.Name.toLowerCase() === Name.toLowerCase())) {
        Result = { Ok: false, Reason: 'A contact with that name already exists.' };
        return;
      }
      if (Meta.Contacts.length >= ContactsCap) {
        Result = { Ok: false, Reason: 'Your contact list is full.' };
        return;
      }
      Meta.Contacts.push({ Name, Number: NumberArg });
    });
    return Result;
  }

  /** Delete a contact, addressed by either its saved name or its number. */
  async RemoveContact(Source: number, Token: string): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    const Needle = Token.trim().toLowerCase();
    let Result: PhoneActionResult = { Ok: false, Reason: 'No such contact.' };
    await this.Inventory.UpdatePhoneMetadata(Active.Number, (Meta) => {
      const Index = Meta.Contacts.findIndex(
        (C) => C.Name.toLowerCase() === Needle || C.Number === Token.trim(),
      );
      if (Index === -1) return;
      const [Removed] = Meta.Contacts.splice(Index, 1);
      Result = {
        Ok: true,
        Message: ChatFormatter.Info(`Removed ${Removed?.Name ?? 'contact'}.`),
      };
    });
    return Result;
  }

  /** Render the active phone's saved contacts as a chat block. */
  async ListContacts(Source: number): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (Active.Meta.Contacts.length === 0) {
      return { Ok: true, Message: ChatFormatter.Info('You have no saved contacts.') };
    }
    const Lines: string[] = [ChatFormatter.Header('Contacts', ChatColor.Header)];
    for (const Contact of Active.Meta.Contacts) {
      Lines.push(ChatFormatter.Label(Contact.Name, Contact.Number));
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Header));
    return { Ok: true, Message: Lines.join('\n') };
  }

  // ── SMS ─────────────────────────────────────────────────────────────

  /**
   * Send a text from the caller's active phone.
   *
   * Gate order matters: incapacitation, then phone present, then powered
   * on, then a resolvable target, then body length - and only then is
   * credit charged. Charging before validation would bill a player for a
   * message that never went.
   *
   * The success reply is deliberately neutral. The sender learns only
   * that the message was sent, never whether the recipient is online,
   * switched off or unreachable - all of which would be metagame
   * information about another player's state.
   */
  async SendSms(Source: number, TargetToken: string, Body: string): Promise<PhoneActionResult> {
    if (this.IsIncapacitated(Source)) {
      return { Ok: false, Reason: 'You cannot use your phone while incapacitated.' };
    }
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (!Active.Meta.IsOn) {
      return { Ok: false, Reason: 'Your phone is switched off. Turn it on with /phone power on.' };
    }
    const Target = this.ResolveTarget(Active.Meta.Contacts, TargetToken);
    if (Target === null) {
      return { Ok: false, Reason: 'Enter a saved contact name or a 555-number.' };
    }
    if (Active.Held.includes(Target)) {
      return { Ok: false, Reason: 'You cannot text your own phone.' };
    }
    const Trimmed = Body.trim();
    if (Trimmed.length === 0) return { Ok: false, Reason: 'Your message is empty.' };
    if (Trimmed.length > MessageBodyMax) {
      return { Ok: false, Reason: `Your message is too long (maximum ${MessageBodyMax} characters).` };
    }
    if (!(await this.Inventory.ChargePhoneCredits(Active.Number, SmsCostCents))) {
      return { Ok: false, Reason: 'You do not have enough phone credit.' };
    }
    await this.PhoneLog.AppendSms(Active.Number, Target, Trimmed);
    await this.DeliverLive(Active.Number, Target, (Label) => ChatFormatter.PhoneSms(Label, Trimmed));
    // Neutral acknowledgement: the sender never learns whether the
    // recipient is online, switched off, or unreachable.
    return { Ok: true, Message: ChatFormatter.Info('Message sent.') };
  }

  /**
   * Recent texts for the active number.
   *
   * History is keyed by number, not character, so a found phone exposes
   * its previous owner's messages - deliberate, and the reason a passcode
   * lock is a planned feature rather than an oversight.
   */
  async ListSmsLog(Source: number, Count: number): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    const Limit = ClampCount(Count);
    const Rows = await this.PhoneLog.ListByOwner(Active.Number, 'Sms', Limit);
    if (Rows.length === 0) {
      return { Ok: true, Message: ChatFormatter.Info('You have no text messages.') };
    }
    const Lines: string[] = [ChatFormatter.Header('Text messages', ChatColor.Header)];
    for (const Row of Rows) {
      const Arrow = Row.Direction === 'Out' ? 'To' : 'From';
      const Label = this.LabelFor(Active.Meta.Contacts, Row.PeerNumber);
      // Bodies are stored verbatim; sanitise on replay so a stored chat-token
      // (e.g. a colour code) cannot forge a styled line when the log is read.
      Lines.push(`${Arrow} ${Label}: ${Sanitize(Row.Body ?? '')}`);
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Header));
    // Mark read ONLY the inbound rows actually shown, not every unread row
    // for the number (a capped window must not silently read past it).
    const Shown = Rows.filter((Row) => Row.Direction === 'In' && !Row.IsRead).map((Row) => Row.ID);
    await this.PhoneLog.MarkReadMany(Shown);
    return { Ok: true, Message: Lines.join('\n') };
  }

  // ── Voicemail ───────────────────────────────────────────────────────

  /**
   * Leave a voicemail. Same gate order and same neutral acknowledgement
   * as SendSms - it differs only in the log kind and that it is stored
   * unread until the recipient plays it back.
   */
  async SendVoicemail(Source: number, TargetToken: string, Body: string): Promise<PhoneActionResult> {
    if (this.IsIncapacitated(Source)) {
      return { Ok: false, Reason: 'You cannot use your phone while incapacitated.' };
    }
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (!Active.Meta.IsOn) {
      return { Ok: false, Reason: 'Your phone is switched off. Turn it on with /phone power on.' };
    }
    const Target = this.ResolveTarget(Active.Meta.Contacts, TargetToken);
    if (Target === null) {
      return { Ok: false, Reason: 'Enter a saved contact name or a 555-number.' };
    }
    if (Active.Held.includes(Target)) {
      return { Ok: false, Reason: 'You cannot leave a voicemail on your own phone.' };
    }
    const Trimmed = Body.trim();
    if (Trimmed.length === 0) return { Ok: false, Reason: 'Your message is empty.' };
    if (Trimmed.length > MessageBodyMax) {
      return { Ok: false, Reason: `Your message is too long (maximum ${MessageBodyMax} characters).` };
    }
    if (!(await this.Inventory.ChargePhoneCredits(Active.Number, VoicemailCostCents))) {
      return { Ok: false, Reason: 'You do not have enough phone credit.' };
    }
    await this.PhoneLog.AppendVoicemail(Active.Number, Target, Trimmed);
    return { Ok: true, Message: ChatFormatter.Info('Voicemail left.') };
  }

  /** List waiting voicemails with the ids `/phone vm read` takes. */
  async ListVoicemailInbox(Source: number): Promise<PhoneActionResult> {
    const Active = await this.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    const Rows = await this.PhoneLog.ListInbound(Active.Number, 'Voicemail', SmsLogMax);
    if (Rows.length === 0) {
      return { Ok: true, Message: ChatFormatter.Info('You have no voicemails.') };
    }
    const Lines: string[] = [ChatFormatter.Header('Voicemail', ChatColor.Header)];
    for (const Row of Rows) {
      const Label = this.LabelFor(Active.Meta.Contacts, Row.PeerNumber);
      const Flag = Row.IsRead ? '' : ' (new)';
      Lines.push(`#${Row.ID} from ${Label}${Flag} - read with /phone vm read ${Row.ID}`);
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Header));
    return { Ok: true, Message: Lines.join('\n') };
  }

  /**
   * Play back one voicemail and mark it read.
   *
   * Ownership is checked against the active number, not the character, so
   * a player cannot read a message addressed to a phone they are not
   * currently holding.
   */
  async ReadVoicemail(Source: number, IdArg: string): Promise<PhoneActionResult> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const Held = await this.Inventory.ListHeldPhoneNumbers(Runtime.CharacterID);
    const Row = await this.PhoneLog.FindById(IdArg);
    // Authorize: the voicemail must belong to a phone the caller holds.
    // A neutral not-found avoids leaking whether the id exists at all.
    if (Row === null || Row.Kind !== 'Voicemail' || !Held.includes(Row.OwnerNumber)) {
      return { Ok: false, Reason: 'No such voicemail.' };
    }
    const OwnerMeta = await this.Inventory.GetPhoneMetadata(Row.OwnerNumber);
    const Label = this.LabelFor(OwnerMeta?.Contacts ?? [], Row.PeerNumber);
    await this.PhoneLog.MarkRead(Row.ID);
    return { Ok: true, Message: ChatFormatter.PhoneVoicemail(Label, Row.Body ?? '') };
  }

  // ── Admin surface ───────────────────────────────────────────────────

  /** The active handset number for a (possibly other) source, or null. */
  async ResolveActiveNumber(Source: number): Promise<string | null> {
    const Active = await this.ResolveActivePhone(Source);
    return 'Error' in Active ? null : Active.Number;
  }

  /** Add credit to a handset by number (admin top-up). Returns the new
   * balance in cents, or null when the number is unknown. */
  async GrantCredits(Number: string, Cents: number): Promise<number | null> {
    const Updated = await this.Inventory.UpdatePhoneMetadata(Number, (Meta) => {
      // Clamp to the ceiling so repeated top-ups cannot overflow the balance
      // into an imprecise JSON-number value.
      Meta.CreditsCents = Math.min(Meta.CreditsCents + Cents, MaxPhoneCreditsCents);
    });
    return Updated === null ? null : Updated.CreditsCents;
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Resolve the player's active handset (live), or an error message. A
   * stale active pointer (set to a phone no longer held) is treated as
   * "no main" and falls through to the single-phone / pick-one rules - it
   * never errors citing the old number, which would leak a former phone.
   */
  async ResolveActivePhone(Source: number): Promise<ActivePhone | { Error: string }> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Error: 'You are not in the world.' };
    const Held = await this.Inventory.ListHeldPhoneNumbers(Runtime.CharacterID);
    if (Held.length === 0) return { Error: 'You are not carrying a phone.' };
    let Active: string | null = null;
    const Pref = Runtime.ActivePhoneSerial;
    if (Pref !== null && Held.includes(Pref)) Active = Pref;
    else if (Held.length === 1) Active = Held[0] ?? null;
    if (Active === null) {
      return {
        Error: `You are carrying several phones (${Held.join(', ')}). Choose one with /phone main <number>.`,
      };
    }
    const Meta = await this.Inventory.GetPhoneMetadata(Active);
    if (Meta === null) return { Error: 'You are not carrying a phone.' };
    return { Number: Active, Meta, Held };
  }

  /** Resolve a target token to a number: a saved contact name, else a literal number. */
  private ResolveTarget(Contacts: PhoneContact[], Token: string): string | null {
    const Trimmed = Token.trim();
    const Contact = Contacts.find((C) => C.Name.toLowerCase() === Trimmed.toLowerCase());
    if (Contact !== undefined) return Contact.Number;
    if (IsValidPhoneNumber(Trimmed)) return Trimmed;
    return null;
  }

  /** A number's display label from the viewer's contacts: name if saved, else the number. */
  private LabelFor(Contacts: PhoneContact[], Number: string): string {
    const Contact = Contacts.find((C) => C.Number === Number);
    return Contact !== undefined ? Contact.Name : Number;
  }

  /**
   * Best-effort live delivery to the holder of `Target`: only if they are
   * online with the handset powered on. The sender's identity is rendered
   * from the recipient's own contacts (name if saved, else the number) -
   * the legal name is never used. Offline / off / unreachable is a silent
   * no-op; persistence already happened, and the sender got a neutral ack.
   */
  private async DeliverLive(
    From: string,
    Target: string,
    Build: (Label: string) => string,
  ): Promise<void> {
    const HolderCharacter = await this.Inventory.ResolveCharacterForSerial(Target);
    if (HolderCharacter === null) return;
    const HolderSource = this.FindOnlineSource(HolderCharacter);
    if (HolderSource === null) return;
    const HolderMeta = await this.Inventory.GetPhoneMetadata(Target);
    if (HolderMeta === null || !HolderMeta.IsOn) return;
    this.Chat.SendTo(HolderSource, Build(this.LabelFor(HolderMeta.Contacts, From)));
  }

  /**
   * True when the source's character is incapacitated (any non-Healthy
   * InjuryStatus). Outbound phone actions (texting, leaving voicemail) are
   * gated on this to match the in-character speech gate; reading the phone
   * (status, contacts, logs) stays available.
   */
  private IsIncapacitated(Source: number): boolean {
    const Runtime = this.Runtimes.Get(Source);
    return Runtime !== null && Runtime.InjuryStatus !== 'Healthy';
  }

  /** The spawned Source playing `CharacterID`, or null when offline. */
  private FindOnlineSource(CharacterID: string): number | null {
    for (const Source of this.State.GetSpawnedSources()) {
      if (this.State.Get(Source)?.CharacterID === CharacterID) return Source;
    }
    return null;
  }
}

/** Clamp a requested log count into the supported window. */
function ClampCount(Count: number): number {
  if (!Number.isFinite(Count) || Count <= 0) return SmsLogDefault;
  return Math.min(Math.floor(Count), SmsLogMax);
}
