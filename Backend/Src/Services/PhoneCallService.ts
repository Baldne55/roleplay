import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import {
  CallBillIntervalMs,
  CallCostCentsPerMinute,
  IsValidPhoneNumber,
  RingTimeoutMs,
  type PhoneContact,
} from '@Shared/Constants/Phone.js';
import { Logger } from '@/Util/Logger.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { PhoneActionResult, PhoneService } from '@/Services/PhoneService.js';
import type { PhoneLogRepository } from '@/Data/Repositories/PhoneLogRepository.js';

/** A live call entry. A "phantom" call has no real callee - it exists so an
 * unreachable dial rings out to "No answer" on the same schedule as a real
 * one, hiding whether the target was offline / off / busy / unknown. */
/**
 * One live call. Held in memory only - a call does not survive a restart,
 * unlike the log rows it writes on completion.
 *
 * `CalleeSource` may be a phantom rather than a real Source: dialling an
 * unreachable number still produces a ringing call the caller experiences
 * normally, so an unanswered dial is indistinguishable from one nobody
 * picks up. Billing runs against the caller's number for the call's
 * lifetime, which is why credit exhaustion is one of its end reasons.
 */
interface Call {
  Id: string;
  CallerSource: number;
  /** Real callee Source, or PhantomSource for an unreachable dial. */
  CalleeSource: number;
  CallerNumber: string;
  CalleeNumber: string;
  /** Characters holding each handset, re-validated each tick once connected. */
  CallerCharacter: string;
  CalleeCharacter: string | null;
  Phantom: boolean;
  Answered: boolean;
  /** Ring start, reset to the answer time once connected. */
  StartMs: number;
  LastBillMs: number;
  RingDeadline: number;
}

/** Sentinel callee Source for a phantom (unreachable) dial - never a real netId. */
const PhantomSource = -1;
/** How often the driver tick fires; the billing UNIT is CallBillIntervalMs. */
const DriverTickMs = 10_000;
/** Rows `/phone call log` returns when the player names no count. */
const CallLogDefault = 10;
/** Ceiling on a requested count - each row is its own chat line. */
const CallLogMax = 30;

/**
 * Live two-party text-relay calls. A call requires both parties spawned
 * with a powered active handset. Reachability is uniform in BOTH text and
 * timing: an offline / powered-off / busy / unknown destination rings out
 * to "No answer" after the same RingTimeoutMs as a real unanswered call
 * (via a phantom entry), so a dial is no finer a presence oracle than an
 * SMS. While connected, the caller is billed per minute by a single
 * demand-armed driver interval. In-call speech is ordinary /say, relayed
 * to the peer by RelayIfOnCall (hooked in SpeechCommands) as a phone line
 * attributed to number/contact only.
 */
export class PhoneCallService {
  private readonly Log = Logger.New('PhoneCall');
  private readonly Calls = new Map<string, Call>();
  private readonly BySource = new Map<number, string>();
  private NextId = 1;
  private Tick: ReturnType<typeof setInterval> | null = null;
  private TickInFlight = false;

  constructor(
    private readonly Chat: ChatService,
    private readonly State: PlayerStateService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Inventory: InventoryService,
    private readonly PhoneLog: PhoneLogRepository,
    private readonly Phone: PhoneService,
  ) {}

  /** Place a call to a contact / number from the caller's active handset. */
  async StartCall(Source: number, TargetToken: string): Promise<PhoneActionResult> {
    if (this.BySource.has(Source)) return { Ok: false, Reason: 'You are already on a call.' };
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    if (Runtime.InjuryStatus !== 'Healthy') {
      return { Ok: false, Reason: 'You cannot use your phone while incapacitated.' };
    }
    const Active = await this.Phone.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    if (!Active.Meta.IsOn) {
      return { Ok: false, Reason: 'Your phone is switched off. Turn it on with /phone power on.' };
    }
    const Target = this.ResolveTarget(Active.Meta.Contacts, TargetToken);
    if (Target === null) return { Ok: false, Reason: 'Enter a saved contact name or a 555-number.' };
    if (Active.Held.includes(Target)) return { Ok: false, Reason: 'You cannot call your own phone.' };
    if (Active.Meta.CreditsCents < CallCostCentsPerMinute) {
      return { Ok: false, Reason: 'You do not have enough phone credit to place a call.' };
    }

    // Resolve the callee (all awaits happen here, BEFORE the synchronous
    // reserve tail below) so the busy re-check and the BySource writes share
    // one un-interrupted span - no TOCTOU between two concurrent dials.
    const CalleeCharacter = await this.Inventory.ResolveCharacterForSerial(Target);
    const CalleeMeta = await this.Inventory.GetPhoneMetadata(Target);
    const CalleeSource = CalleeCharacter !== null ? this.FindOnlineSource(CalleeCharacter) : null;

    // ── synchronous reserve tail (no await past this point until set) ──
    if (this.BySource.has(Source)) return { Ok: false, Reason: 'You are already on a call.' };
    const Reachable =
      CalleeCharacter !== null &&
      CalleeSource !== null &&
      CalleeMeta !== null &&
      CalleeMeta.IsOn &&
      !this.BySource.has(CalleeSource);

    const Now = Date.now();
    const Id = String(this.NextId);
    this.NextId += 1;
    const Entry: Call = {
      Id,
      CallerSource: Source,
      CalleeSource: Reachable && CalleeSource !== null ? CalleeSource : PhantomSource,
      CallerNumber: Active.Number,
      CalleeNumber: Target,
      CallerCharacter: Runtime.CharacterID,
      CalleeCharacter: Reachable ? CalleeCharacter : null,
      Phantom: !Reachable,
      Answered: false,
      StartMs: Now,
      LastBillMs: Now,
      RingDeadline: Now + RingTimeoutMs,
    };
    this.Calls.set(Id, Entry);
    this.BySource.set(Source, Id);
    if (Reachable && CalleeSource !== null) this.BySource.set(CalleeSource, Id);
    this.Arm();

    if (Reachable && CalleeSource !== null && CalleeMeta !== null) {
      const CalleeLabel = this.LabelFor(CalleeMeta.Contacts, Active.Number);
      this.Chat.SendTo(
        CalleeSource,
        ChatFormatter.Info(
          `Incoming call from ${CalleeLabel}. Answer with /phone call answer, or hang up with /phone call hangup.`,
        ),
      );
    }
    return {
      Ok: true,
      Message: ChatFormatter.Info(`Calling ${this.LabelFor(Active.Meta.Contacts, Target)}...`),
    };
  }

  /** Accept the incoming call (callee only). Bills the caller the first minute. */
  async Answer(Source: number): Promise<PhoneActionResult> {
    const Entry = this.CallFor(Source);
    if (Entry === null || Entry.CalleeSource !== Source) {
      return { Ok: false, Reason: 'You have no incoming call.' };
    }
    if (Entry.Answered) return { Ok: false, Reason: 'The call is already connected.' };
    // Claim the answer SYNCHRONOUSLY (before the first await) so a second
    // concurrent /phone call answer is rejected at the guard above and cannot
    // bill the caller a second first-minute.
    Entry.Answered = true;
    if (!(await this.Inventory.ChargePhoneCredits(Entry.CallerNumber, CallCostCentsPerMinute))) {
      this.Chat.SendTo(
        Entry.CallerSource,
        ChatFormatter.Info('The call could not be connected (out of credit).'),
      );
      this.Teardown(Entry);
      return { Ok: false, Reason: 'The call could not be connected.' };
    }
    // The caller may have dropped (synchronous playerDropped -> Evict ->
    // Teardown) while the charge was in flight; never connect a call that no
    // longer exists, or the callee would be stranded "connected". The first
    // minute was already debited above, and no call is being had for it -
    // hand it back rather than billing for a connection that never formed.
    if (!this.Calls.has(Entry.Id)) {
      await this.Inventory.RefundPhoneCredits(Entry.CallerNumber, CallCostCentsPerMinute);
      return { Ok: false, Reason: 'The call has already ended.' };
    }
    const Now = Date.now();
    Entry.StartMs = Now;
    Entry.LastBillMs = Now;
    this.Chat.SendTo(
      Entry.CallerSource,
      ChatFormatter.Info('Call connected. Speak with /say; hang up with /phone call hangup.'),
    );
    return {
      Ok: true,
      Message: ChatFormatter.Info('Call connected. Speak with /say; hang up with /phone call hangup.'),
    };
  }

  /** Hang up the current call from either side. */
  async Hangup(Source: number): Promise<PhoneActionResult> {
    const Entry = this.CallFor(Source);
    if (Entry === null) return { Ok: false, Reason: 'You are not on a call.' };
    await this.EndCall(Entry, Source, 'hangup');
    return { Ok: true, Message: ChatFormatter.Info('Call ended.') };
  }

  /** Recent call history for the active handset. */
  async ListLog(Source: number, Count: number): Promise<PhoneActionResult> {
    const Active = await this.Phone.ResolveActivePhone(Source);
    if ('Error' in Active) return { Ok: false, Reason: Active.Error };
    const Limit = Count > 0 ? Math.min(Math.floor(Count), CallLogMax) : CallLogDefault;
    const Rows = await this.PhoneLog.ListByOwner(Active.Number, 'Call', Limit);
    if (Rows.length === 0) {
      return { Ok: true, Message: ChatFormatter.Info('You have no calls.') };
    }
    const Lines: string[] = [ChatFormatter.Header('Calls', ChatColor.Phone)];
    for (const Row of Rows) {
      const Label = this.LabelFor(Active.Meta.Contacts, Row.PeerNumber);
      const Verb = Row.Direction === 'Out' ? 'Called' : Row.Direction === 'Missed' ? 'Missed' : 'From';
      const Duration =
        Row.Direction === 'Missed' ? '' : ` (${FormatDuration(Row.DurationSec ?? 0)})`;
      Lines.push(`${Verb} ${Label}${Duration}`);
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Phone));
    return { Ok: true, Message: Lines.join('\n') };
  }

  /**
   * Relay an ordinary spoken line to the peer on a connected call. Called
   * from the /say handler (and only /say). No-op when the speaker is not
   * on a connected call. The peer-facing line is attributed to the
   * speaker's number, resolved through the peer's own contacts - never the
   * legal name, never an OOC server-ID prefix.
   */
  RelayIfOnCall(Source: number, Body: string): void {
    const Entry = this.CallFor(Source);
    if (Entry === null || !Entry.Answered) return;
    const PeerSource = Source === Entry.CallerSource ? Entry.CalleeSource : Entry.CallerSource;
    if (PeerSource === PhantomSource) return;
    const SpeakerNumber = Source === Entry.CallerSource ? Entry.CallerNumber : Entry.CalleeNumber;
    const PeerNumber = Source === Entry.CallerSource ? Entry.CalleeNumber : Entry.CallerNumber;
    void this.DeliverRelay(PeerSource, PeerNumber, SpeakerNumber, Body).catch((Err: unknown) => {
      this.Log.Error(`Call relay rejected to peer=${PeerSource}`, { Err: String(Err) });
    });
  }

  /** Tear down any call this Source is in (disconnect / character switch). Idempotent. */
  Evict(Source: number): void {
    const Entry = this.CallFor(Source);
    if (Entry === null) {
      this.BySource.delete(Source);
      return;
    }
    // Teardown of the in-memory maps happens synchronously inside
    // EndCall; only the billing reconcile + log write are awaited, so a
    // rejection here loses the final bill, never the eviction.
    void this.EndCall(Entry, Source, 'disconnect').catch((Err: unknown) => {
      this.Log.Error(`Call teardown rejected for source=${Source}`, { Err: String(Err) });
    });
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Relay one utterance to the other party.
   *
   * The speaker is labelled using the *listener's* contact list, so each
   * side sees their own saved name for the other - and never the legal
   * name, which the remote party's character has no way to know.
   */
  private async DeliverRelay(
    PeerSource: number,
    PeerNumber: string,
    SpeakerNumber: string,
    Body: string,
  ): Promise<void> {
    const PeerMeta = await this.Inventory.GetPhoneMetadata(PeerNumber);
    const Label = this.LabelFor(PeerMeta?.Contacts ?? [], SpeakerNumber);
    this.Chat.SendTo(PeerSource, ChatFormatter.PhoneCallSpeech(Label, Body));
  }

  /**
   * The billing and liveness driver, running only while calls exist.
   *
   * Per tick it expires unanswered rings, verifies both parties still
   * hold their handsets (a dropped or traded phone ends the call), and
   * debits the caller once per billing interval.
   *
   * Two guards protect against re-entrancy and double-billing:
   * `TickInFlight` stops overlapping runs, and the map is re-checked
   * after every await because a hangup during those awaits removes the
   * entry synchronously - without the re-check a torn-down call could be
   * billed one extra minute.
   */
  private async OnTick(): Promise<void> {
    if (this.TickInFlight) return;
    this.TickInFlight = true;
    try {
      const Now = Date.now();
      for (const Entry of Array.from(this.Calls.values())) {
        if (!this.Calls.has(Entry.Id)) continue;
        if (!Entry.Answered) {
          if (Now >= Entry.RingDeadline) await this.EndRinging(Entry);
          continue;
        }
        if (Now - Entry.LastBillMs < CallBillIntervalMs) continue;
        // Either party losing the handset (dropped / traded) ends the call.
        const CallerHolder = await this.Inventory.ResolveCharacterForSerial(Entry.CallerNumber);
        if (CallerHolder !== Entry.CallerCharacter) {
          await this.EndCall(Entry, null, 'phone-gone');
          continue;
        }
        const CalleeHolder = await this.Inventory.ResolveCharacterForSerial(Entry.CalleeNumber);
        if (CalleeHolder !== Entry.CalleeCharacter) {
          await this.EndCall(Entry, null, 'phone-gone');
          continue;
        }
        // A hangup / disconnect / phone-drop may have torn the call down (and
        // already reconciled its billing) during the awaits above. Teardown
        // removes the entry synchronously, so this re-check stops a second,
        // post-teardown minute from being debited for a call that has ended.
        if (!this.Calls.has(Entry.Id)) continue;
        if (!(await this.Inventory.ChargePhoneCredits(Entry.CallerNumber, CallCostCentsPerMinute))) {
          await this.EndCall(Entry, null, 'credits');
          continue;
        }
        Entry.LastBillMs += CallBillIntervalMs;
      }
    } finally {
      this.TickInFlight = false;
      if (this.Calls.size === 0) this.Disarm();
    }
  }

  /** A ringing call that nobody answered: notify, log a real miss, tear down. */
  private async EndRinging(Entry: Call): Promise<void> {
    if (!this.Calls.has(Entry.Id)) return;
    this.Teardown(Entry);
    this.Chat.SendTo(
      Entry.CallerSource,
      ChatFormatter.Info(
        `No answer. Leave a voicemail with /phone vm send ${Entry.CalleeNumber} <message>.`,
      ),
    );
    if (Entry.Phantom) return; // unreachable target: nobody to miss the call
    await this.PhoneLog.AppendCall(Entry.CallerNumber, Entry.CalleeNumber, 0, false);
    this.Chat.SendTo(Entry.CalleeSource, ChatFormatter.Info('Missed call.'));
  }

  /**
   * End a connected (or mid-ring hang-up) call: reconcile billing, log it,
   * notify the party that did not initiate the end, and tear down both
   * sides. `EndedBy` is the Source that hung up / dropped (gets the command
   * reply instead of a push), or null for a system-driven end.
   */
  private async EndCall(Entry: Call, EndedBy: number | null, Reason: EndReason): Promise<void> {
    if (!this.Calls.has(Entry.Id)) return;
    this.Teardown(Entry);
    if (Entry.Answered) {
      const Now = Date.now();
      // Prepay model: [LastBillMs, LastBillMs + interval) is already paid.
      // Only bill genuine overage past it (covers a missed/late tick); the
      // in-progress paid minute is never re-charged.
      const PaidThrough = Entry.LastBillMs + CallBillIntervalMs;
      if (Now > PaidThrough) {
        const Owed = Math.ceil((Now - PaidThrough) / CallBillIntervalMs);
        if (Owed > 0) {
          await this.Inventory.ChargePhoneCredits(Entry.CallerNumber, Owed * CallCostCentsPerMinute);
        }
      }
      const DurationSec = Math.max(0, Math.round((Now - Entry.StartMs) / 1000));
      await this.PhoneLog.AppendCall(Entry.CallerNumber, Entry.CalleeNumber, DurationSec, true);
    } else if (!Entry.Phantom) {
      await this.PhoneLog.AppendCall(Entry.CallerNumber, Entry.CalleeNumber, 0, false);
    }
    const Note = ChatFormatter.Info(EndNote(Reason));
    for (const Side of [Entry.CallerSource, Entry.CalleeSource]) {
      if (Side === EndedBy || Side === PhantomSource) continue;
      this.Chat.SendTo(Side, Note);
    }
  }

  /**
   * Remove a call and its per-Source bindings, disarming the driver once
   * none remain. Synchronous by design - see OnTick's re-check.
   */
  private Teardown(Entry: Call): void {
    this.Calls.delete(Entry.Id);
    // Identity-guarded: only drop a BySource binding that still points at
    // THIS call, so tearing one call down never unbinds another.
    if (this.BySource.get(Entry.CallerSource) === Entry.Id) this.BySource.delete(Entry.CallerSource);
    if (this.BySource.get(Entry.CalleeSource) === Entry.Id) this.BySource.delete(Entry.CalleeSource);
    if (this.Calls.size === 0) this.Disarm();
  }

  /** The call a Source is currently on, via the BySource index, or null. */
  private CallFor(Source: number): Call | null {
    const Id = this.BySource.get(Source);
    if (Id === undefined) return null;
    return this.Calls.get(Id) ?? null;
  }

  /**
   * Start the billing interval, idempotently. Armed on the first call
   * rather than at boot so an idle server runs no timer at all.
   */
  private Arm(): void {
    if (this.Tick !== null) return;
    this.Tick = setInterval(() => {
      void this.OnTick().catch((Err: unknown) => {
        this.Log.Error('Call billing tick rejected', { Err: String(Err) });
      });
    }, DriverTickMs);
    this.Log.Debug('Call billing driver armed');
  }

  /** Stop the billing interval once the last call ends. */
  private Disarm(): void {
    if (this.Tick === null) return;
    clearInterval(this.Tick);
    this.Tick = null;
    this.Log.Debug('Call billing driver disarmed');
  }

  /**
   * Resolve a dialled token to a number: a saved contact name
   * (case-insensitive) if one matches, otherwise the token itself when it
   * is a valid number. Null when it is neither.
   */
  private ResolveTarget(Contacts: PhoneContact[], Token: string): string | null {
    const Trimmed = Token.trim();
    const Contact = Contacts.find((C) => C.Name.toLowerCase() === Trimmed.toLowerCase());
    if (Contact !== undefined) return Contact.Number;
    return IsValidPhoneNumber(Trimmed) ? Trimmed : null;
  }

  /**
   * How a number should be displayed to one party: their saved contact
   * name, else the bare number. Never a legal name.
   */
  private LabelFor(Contacts: PhoneContact[], Number: string): string {
    const Contact = Contacts.find((C) => C.Number === Number);
    return Contact !== undefined ? Contact.Name : Number;
  }

  /**
   * Live Source for a character id, or null if not spawned. Linear scan
   * over spawned players - only reached on call setup, never per tick.
   */
  private FindOnlineSource(CharacterID: string): number | null {
    for (const Source of this.State.GetSpawnedSources()) {
      if (this.State.Get(Source)?.CharacterID === CharacterID) return Source;
    }
    return null;
  }
}

/**
 * Why a call terminated. Internal to this service - the wire and the
 * phone log carry the rendered text from EndReasonText below, not this
 * token, so renaming a member here does not break stored history.
 *
 * 'phone-gone' covers the handset leaving the character's possession
 * mid-call (dropped, stolen, powered off), which is distinct from
 * 'disconnect' (the player left) even though both end the call the same
 * way for the peer.
 */
type EndReason = 'hangup' | 'credits' | 'phone-gone' | 'disconnect';

/**
 * Player-facing explanation for why a call ended.
 *
 * Several reasons deliberately share wording - a caller should not be
 * able to distinguish "they hung up" from "their phone was taken", since
 * that would leak information the character could not have.
 */
function EndNote(Reason: EndReason): string {
  switch (Reason) {
    case 'credits':
      return 'The call ended because the caller ran out of credit.';
    case 'hangup':
    case 'phone-gone':
    case 'disconnect':
    default:
      return 'The call has ended.';
  }
}

/** Call length as `Nm Ns` for the end-of-call summary and the call log. */
function FormatDuration(Seconds: number): string {
  const Mins = Math.floor(Seconds / 60);
  const Secs = Seconds % 60;
  return `${Mins}m ${Secs}s`;
}
