import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import {
  IsValidFrequency,
  IsValidSlot,
  RadioFrequencyMax,
  RadioFrequencyMin,
  RadioPossessionSweepIntervalMs,
  RadioSlotCount,
  type RadioSlot,
} from '@Shared/Constants/Radio.js';
import { DebugEnabled, Logger } from '@/Util/Logger.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { InventoryService } from '@/Services/InventoryService.js';

/** Outcome of a radio operation, mapped to a CommandResult by the caller. */
export type RadioActionResult = { Ok: true; Message?: string } | { Ok: false; Reason: string };

/** The catalog item that gates powering a radio on. */
const RadioItemTypeID = 'radio';

/**
 * Handheld text-radio comms. Frequencies live on the character runtime
 * (RadioState: a set of numbered slots, one of which is flagged as the
 * main slot a bare `/r` transmits on); a powered `radio` item is the
 * possession gate, checked at power-on so the per-transmission path
 * never touches the database, and re-checked by a periodic sweep so a
 * radio that leaves the inventory takes its power state with it. A
 * transmission fans out to every spawned player tuned to the sender's
 * frequency on a non-muted slot - range is global on the frequency. No
 * voice, no client surface: this is pure server-built chat.
 *
 * Mask awareness and the chat-ID toggle are inherited from
 * ProximityBroadcaster, so radio reads exactly like the rest of chat:
 * a masked sender transmits as `Stranger <MaskID>`, and each receiver's
 * copy carries the server-ID prefix only when their nametag-ID toggle
 * is on.
 */
export class RadioService {
  private readonly Log = Logger.New('Radio');
  private SweepInterval: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy latch - a slow DB read must not pile sweeps on itself. */
  private SweepInFlight = false;

  constructor(
    private readonly Chat: ChatService,
    private readonly State: PlayerStateService,
    private readonly Broadcaster: ProximityBroadcaster,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Inventory: InventoryService,
  ) {}

  /**
   * Arm the possession sweep. Powering on gates on holding a `radio`,
   * but PowerOn then lives on the character runtime - so without this a
   * player could power on, drop or hand the radio over, and keep both
   * transmitting and listening on their tuned frequencies forever.
   */
  Start(): void {
    if (this.SweepInterval !== null) return;
    this.SweepInterval = setInterval((): void => {
      void this.SweepPossession().catch((Err: unknown) => {
        this.Log.Error('Possession sweep rejected', { Err: String(Err) });
      });
    }, RadioPossessionSweepIntervalMs);
    this.Log.Info(`Radio possession sweep armed (every ${RadioPossessionSweepIntervalMs}ms)`);
  }

  /** Halt the possession sweep. Pairs with Start; idempotent. */
  Stop(): void {
    if (this.SweepInterval === null) return;
    clearInterval(this.SweepInterval);
    this.SweepInterval = null;
  }

  /**
   * Power down any radio whose owner no longer carries one. Uses the
   * SAME possession predicate as SetPower (InventoryService.HasItemType,
   * main inventory only), so "can switch on" and "stays on" never
   * disagree - stowing a radio deep in a backpack reads as not carrying
   * it on both paths.
   *
   * Only powered-on players cost a query, so a server with no radios in
   * use does no database work at all.
   */
  private async SweepPossession(): Promise<void> {
    if (this.SweepInFlight) return;
    this.SweepInFlight = true;
    try {
      for (const Source of this.State.GetSpawnedSources()) {
        const Runtime = this.Runtimes.Get(Source);
        if (Runtime === null || !Runtime.RadioState.PowerOn) continue;
        let Has = true;
        try {
          Has = await this.Inventory.HasItemType(Runtime.CharacterID, RadioItemTypeID);
        } catch (Err: unknown) {
          // A failed read must never confiscate a legitimate radio.
          this.Log.Warn(`Possession check failed source=${Source}`, { Err: String(Err) });
          continue;
        }
        if (Has) continue;
        // Re-read: the await above is a suspension point, and the player
        // may have switched characters or logged out across it.
        const Fresh = this.Runtimes.Get(Source);
        if (Fresh === null || !Fresh.RadioState.PowerOn) continue;
        const NextState = Fresh.RadioState;
        NextState.PowerOn = false;
        this.Runtimes.SetRadioState(Source, NextState);
        this.Chat.SendTo(
          Source,
          ChatFormatter.Info('Your radio switched off - you are no longer carrying one.'),
        );
        this.Log.Debug(`Radio powered off (no handset) source=${Source}`);
      }
    } catch (Err: unknown) {
      this.Log.Warn('Possession sweep failed', { Err: String(Err) });
    } finally {
      this.SweepInFlight = false;
    }
  }

  /**
   * Transmit `Body` on a slot. `SlotArg` is a 1-based slot number, or
   * null to follow the character's main-slot pointer (the bare `/r`).
   */
  Transmit(Source: number, SlotArg: number | null, Body: string): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const State = Runtime.RadioState;
    if (!State.PowerOn) {
      return { Ok: false, Reason: 'Your radio is switched off. Turn it on with /setradio on.' };
    }
    const Slot = SlotArg ?? State.MainSlot;
    const Entry = this.SlotAt(State, Slot);
    if (Entry === undefined) return { Ok: false, Reason: 'That radio slot does not exist.' };
    if (Entry.Frequency === null) {
      return {
        Ok: false,
        Reason:
          SlotArg === null
            ? `Your main slot (slot ${Slot}) is not tuned. Tune it with /setfrequency, or point the main slot elsewhere with /setmainradioslot.`
            : `Slot ${Slot} is not tuned. Tune a slot with /setfrequency.`,
      };
    }
    const Frequency = Entry.Frequency;
    const SenderName = this.Broadcaster.DisplayName(Source) ?? 'Someone';
    const Line = ChatFormatter.RadioTransmission(Frequency, SenderName, Body);
    // The sender always hears their own transmission, even if they muted
    // that slot's inbound - seeing your own outbound is not receiving.
    this.SendViewerLine(Source, Source, Line);
    let Reached = 1;
    for (const Receiver of this.State.GetSpawnedSources()) {
      if (Receiver === Source) continue;
      const RxRuntime = this.Runtimes.Get(Receiver);
      if (RxRuntime === null) continue;
      const Rx = RxRuntime.RadioState;
      if (!Rx.PowerOn) continue;
      const Hears = Rx.Slots.some((S) => S.Frequency === Frequency && !S.Muted);
      if (!Hears) continue;
      this.SendViewerLine(Receiver, Source, Line);
      Reached += 1;
    }
    if (DebugEnabled()) {
      this.Log.Debug(`/r source=${Source} slot=${Slot} freq=${Frequency} reached=${Reached}`);
    }
    return { Ok: true };
  }

  /** Point the main-slot pointer at `Slot` (which a bare `/r` then uses). */
  SetMainSlot(Source: number, Slot: number): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    if (!IsValidSlot(Slot)) return { Ok: false, Reason: this.SlotRangeHint() };
    const State = Runtime.RadioState;
    State.MainSlot = Slot;
    this.Runtimes.SetRadioState(Source, State);
    const Entry = this.SlotAt(State, Slot);
    const Detail =
      Entry !== undefined && Entry.Frequency !== null
        ? `, tuned to ${Entry.Frequency}.`
        : ' (currently clear; tune it with /setfrequency).';
    return { Ok: true, Message: ChatFormatter.Info(`Main radio slot is now slot ${Slot}${Detail}`) };
  }

  /** Tune the first free slot to `Frequency`. */
  TuneIn(Source: number, Frequency: number): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    if (!IsValidFrequency(Frequency)) return { Ok: false, Reason: this.FrequencyRangeHint() };
    const State = Runtime.RadioState;
    const Existing = State.Slots.findIndex((S) => S.Frequency === Frequency);
    if (Existing !== -1) {
      return {
        Ok: false,
        Reason: `You are already tuned to ${Frequency} on ${this.SlotLabel(Existing + 1)}.`,
      };
    }
    const Free = State.Slots.findIndex((S) => S.Frequency === null);
    if (Free === -1) {
      return { Ok: false, Reason: 'All radio slots are in use. Free one with /partradio <slot>.' };
    }
    State.Slots[Free] = { Frequency, Muted: false };
    this.Runtimes.SetRadioState(Source, State);
    const SlotNo = Free + 1;
    return {
      Ok: true,
      Message: ChatFormatter.Info(`Tuned slot ${SlotNo} to ${Frequency}. Transmit with /r${SlotNo}.`),
    };
  }

  /** Clear a slot (1-based). */
  TuneOut(Source: number, Slot: number): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const State = Runtime.RadioState;
    const Entry = this.SlotAt(State, Slot);
    if (Entry === undefined) return { Ok: false, Reason: 'That radio slot does not exist.' };
    if (Entry.Frequency === null) return { Ok: false, Reason: 'That slot is already clear.' };
    State.Slots[Slot - 1] = { Frequency: null, Muted: false };
    this.Runtimes.SetRadioState(Source, State);
    return { Ok: true, Message: ChatFormatter.Info(`Cleared ${this.SlotLabel(Slot)}.`) };
  }

  /** Toggle inbound mute on a slot (1-based). */
  ToggleMute(Source: number, Slot: number): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const State = Runtime.RadioState;
    const Entry = this.SlotAt(State, Slot);
    if (Entry === undefined) return { Ok: false, Reason: 'That radio slot does not exist.' };
    if (Entry.Frequency === null) return { Ok: false, Reason: 'That slot is not tuned.' };
    const Muted = !Entry.Muted;
    State.Slots[Slot - 1] = { Frequency: Entry.Frequency, Muted };
    this.Runtimes.SetRadioState(Source, State);
    return {
      Ok: true,
      Message: ChatFormatter.Info(`${Muted ? 'Muted' : 'Unmuted'} ${this.SlotLabel(Slot)}.`),
    };
  }

  /**
   * Power the radio on or off. Powering ON requires a radio item in the
   * inventory (the one DB read on the whole radio path); powering off is
   * always allowed so a player can never be stuck transmitting.
   */
  async SetPower(Source: number, On: boolean): Promise<RadioActionResult> {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const State = Runtime.RadioState;
    if (On && !State.PowerOn) {
      const Has = await this.Inventory.HasItemType(Runtime.CharacterID, RadioItemTypeID);
      if (!Has) return { Ok: false, Reason: 'You need a handheld radio to do that.' };
    }
    if (State.PowerOn === On) {
      return { Ok: true, Message: ChatFormatter.Info(`Your radio is already ${On ? 'on' : 'off'}.`) };
    }
    State.PowerOn = On;
    this.Runtimes.SetRadioState(Source, State);
    return { Ok: true, Message: ChatFormatter.Info(`Radio switched ${On ? 'on' : 'off'}.`) };
  }

  /** Build the radio status card (power, the main slot, and every slot). */
  Describe(Source: number): RadioActionResult {
    const Runtime = this.Runtimes.Get(Source);
    if (Runtime === null) return { Ok: false, Reason: 'You are not in the world.' };
    const State = Runtime.RadioState;
    const Lines: string[] = [
      ChatFormatter.Header('Radio', ChatColor.Header),
      ChatFormatter.Label('Power', State.PowerOn ? 'On' : 'Off'),
      ChatFormatter.Label('Main slot', String(State.MainSlot)),
    ];
    for (let Slot = 1; Slot <= RadioSlotCount; Slot += 1) {
      const Entry = this.SlotAt(State, Slot);
      const Value =
        Entry === undefined || Entry.Frequency === null
          ? '<clear>'
          : `${Entry.Frequency}${Entry.Muted ? ' (muted)' : ''}`;
      Lines.push(ChatFormatter.Label(`Slot ${Slot}`, Value));
    }
    Lines.push(ChatFormatter.Footer(ChatColor.Header));
    return { Ok: true, Message: Lines.join('\n') };
  }

  /**
   * Deliver a transmission to one listener, prefixing the sender's server
   * id only if that viewer has the nametag-ID toggle on - so radio reads
   * the same as proximity speech for each individual viewer.
   */
  private SendViewerLine(Receiver: number, Sender: number, Line: string): void {
    const ViewerLine = this.Broadcaster.WantsServerIds(Receiver)
      ? ChatFormatter.ServerIdPrefix(Sender) + Line
      : Line;
    this.Chat.SendTo(Receiver, ViewerLine);
  }

  /** Resolve a 1-based slot number to its entry (undefined when out of range). */
  private SlotAt(State: { Slots: RadioSlot[] }, Slot: number): RadioSlot | undefined {
    if (!Number.isInteger(Slot) || Slot < 1) return undefined;
    return State.Slots[Slot - 1];
  }

  /** Usage hint naming the valid frequency range, built from the constants. */
  private FrequencyRangeHint(): string {
    return `Frequency must be a whole number between ${RadioFrequencyMin} and ${RadioFrequencyMax}.`;
  }

  /** Usage hint naming the valid slot range, built from RadioSlotCount. */
  private SlotRangeHint(): string {
    return `Choose a radio slot between 1 and ${RadioSlotCount}.`;
  }

  /** Display label for a slot in status output. */
  private SlotLabel(Slot: number): string {
    return `slot ${Slot}`;
  }
}
