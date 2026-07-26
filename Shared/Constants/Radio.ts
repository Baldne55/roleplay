/**
 * Radio comms constants and the per-character tuning state.
 *
 * Frequencies live on the CHARACTER, not on the radio item: a player
 * tunes a handful of numbered slots to frequencies and hears every
 * transmission on any slot they have tuned (and not muted). One slot is
 * the MAIN slot - the one a bare `/r` transmits on - and the player
 * picks which slot that is. A powered `radio` item in the inventory is
 * the possession gate: without one the radio cannot be switched on, and
 * a sweep powers it back down when the handset leaves. Text only, no
 * voice; range is global on a frequency.
 */

/** Tunable memory slots, addressed 1..N by the /r1../rN commands. */
export const RadioSlotCount = 3;

/** Inclusive frequency bounds a player may tune. */
export const RadioFrequencyMin = 1;
export const RadioFrequencyMax = 999_999;

/**
 * How often the server re-checks that a powered-on radio is still in its
 * owner's inventory.
 *
 * Possession is gated at power-on so the transmit path never touches the
 * database - but PowerOn lives on the character runtime, not on the
 * item, so without this sweep a player could power on, hand the radio
 * away, and keep transmitting AND receiving on every tuned frequency
 * indefinitely. The listening half is the damaging one: give your radio
 * to someone and you would still hear everything they hear, map-wide.
 *
 * Sized for a periodic check rather than a hot-path one. Only players
 * with PowerOn true cost a query, so an idle server does no work at all,
 * and the worst case is a handful of seconds of eavesdropping after the
 * handset changes hands - not an open-ended session.
 */
export const RadioPossessionSweepIntervalMs = 15_000;

/**
 * One preset channel on a handheld. Frequency and mute are independent:
 * muting keeps the tuning so the slot can be un-muted without re-entering
 * the frequency.
 */
export interface RadioSlot {
  /** Tuned frequency, or null when the slot is empty. */
  Frequency: number | null;
  /** Inbound on this slot is suppressed while true. */
  Muted: boolean;
}

/**
 * A character's whole radio configuration, persisted as one JSON column
 * on the character row rather than as its own table - it is small, always
 * read as a unit, and never queried across characters.
 */
export interface RadioState {
  /** A powered-down radio neither transmits nor receives. */
  PowerOn: boolean;
  /** Which slot (1..N) a bare `/r` transmits on. */
  MainSlot: number;
  /** The tuned slots; Slots[N - 1] is the slot addressed as N. */
  Slots: RadioSlot[];
}

/** Off, every slot empty, main pointed at slot 1 - a fresh character. */
export function DefaultRadioState(): RadioState {
  const Slots: RadioSlot[] = [];
  for (let I = 0; I < RadioSlotCount; I += 1) {
    Slots.push({ Frequency: null, Muted: false });
  }
  return { PowerOn: false, MainSlot: 1, Slots };
}

/** True when `Value` is an integer inside the tunable band. */
export function IsValidFrequency(Value: number): boolean {
  return Number.isInteger(Value) && Value >= RadioFrequencyMin && Value <= RadioFrequencyMax;
}

/** True when `Value` is a 1-based slot number the radio actually has. */
export function IsValidSlot(Value: number): boolean {
  return Number.isInteger(Value) && Value >= 1 && Value <= RadioSlotCount;
}

/**
 * Coerce a persisted / untyped blob back into a well-formed RadioState.
 * Guards the spawn-hydrate path against null columns, malformed JSON, and
 * slot-count drift (pad short, truncate long) so the runtime always holds
 * exactly RadioSlotCount slots with valid values and a main pointer that
 * lands on a real slot. Tolerates the pre-restructure `Channels` shape so
 * a stale column hydrates rather than throwing.
 */
export function NormalizeRadioState(Raw: unknown): RadioState {
  if (Raw === null || typeof Raw !== 'object') return DefaultRadioState();
  const Source = Raw as { PowerOn?: unknown; MainSlot?: unknown; Slots?: unknown; Channels?: unknown };
  const PowerOn = Source.PowerOn === true;
  const Base = Array.isArray(Source.Slots)
    ? Source.Slots
    : Array.isArray(Source.Channels)
      ? Source.Channels
      : [];
  const Slots: RadioSlot[] = [];
  for (let I = 0; I < RadioSlotCount; I += 1) {
    const Entry = Base[I] as Partial<RadioSlot> | undefined;
    const Frequency =
      typeof Entry?.Frequency === 'number' && IsValidFrequency(Entry.Frequency)
        ? Entry.Frequency
        : null;
    Slots.push({ Frequency, Muted: Entry?.Muted === true });
  }
  const MainSlot =
    typeof Source.MainSlot === 'number' && IsValidSlot(Source.MainSlot) ? Source.MainSlot : 1;
  return { PowerOn, MainSlot, Slots };
}
