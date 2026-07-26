/**
 * Drug-class constants shared between Backend and Frontend.
 *
 * Design boundary (decided 2026-06-12): narcotics and alcohol get NO
 * cosmetic effects - no timecycle shaders, no movement clipsets, no
 * camera shake. This is a text-roleplay server; the high and the
 * sickness both land through the two channels every other system
 * already uses: stats (temporary HP/AP movement) and involuntary
 * `/me` narration. What ships instead of visuals:
 *
 *   - On use, a temporary stat boost scaled by the batch's hidden
 *     potency (Purity for powders, ThcPercent for cannabis;
 *     pharmaceutical pills are factory-standard). Stimulant-family
 *     drugs grant armour that drains back out when the window
 *     closes; everything else heals over a window via the regen
 *     ticker.
 *   - Every dose feeds a per-class addiction level on the character.
 *     The level decays over days; above the threshold, a character
 *     who misses their window enters withdrawal - periodic
 *     involuntary narration plus a slow HP drain to a floor - until
 *     they dose again (deepening the addiction) or sweat out the
 *     days back below the threshold.
 */

/**
 * Addiction bucket a substance belongs to. Addiction is tracked per
 * CLASS, not per item, so switching between two stimulants does not reset
 * or split the level - tolerance follows the pharmacology, not the
 * catalog entry.
 */
export type DrugClass =
  | 'Stimulant'
  | 'Opioid'
  | 'Cannabis'
  | 'Psychedelic'
  | 'Sedative'
  | 'Alcohol';

/**
 * Per-drug-class addiction curve: how fast tolerance builds from doses
 * and how fast it decays without them.
 *
 * Split by class rather than by item so that every product of the same
 * class shares one dependency track - a player cannot dodge withdrawal by
 * rotating between two items that are pharmacologically the same thing.
 */
export interface AddictionClassTuning {
  /** Addiction points one standard dose adds (scaled by DoseScale, clamped below). */
  readonly GainPerDose: number;
  /** Points shed per hour of wall-clock abstinence (lazy, like BAC). */
  readonly DecayPerHour: number;
  /** Hours after the last dose before withdrawal symptoms begin. */
  readonly WithdrawalOnsetHours: number;
  /**
   * Involuntary `/me` bodies, rotated per symptom. Strict-formal,
   * single sentence, no contractions - the injury-narration voice.
   */
  readonly Narrations: readonly string[];
}

/**
 * Per-class addiction curves. Opioids hook fastest and turn sour
 * soonest; cannabis is slow on both ends; psychedelics barely
 * register (the gain is token - a character would need a heroic
 * schedule to cross the threshold). Alcohol rides the same machinery
 * as the narcotics, fed per drink from the BAC ingestion path.
 */
export const AddictionTuning: Record<DrugClass, AddictionClassTuning> = {
  Stimulant: {
    GainPerDose: 8,
    DecayPerHour: 0.5,
    WithdrawalOnsetHours: 3,
    Narrations: [
      'grinds their teeth.',
      'scratches restlessly at their forearm.',
      'sweeps a hollow-eyed glance across their surroundings.',
    ],
  },
  Opioid: {
    GainPerDose: 12,
    DecayPerHour: 0.4,
    WithdrawalOnsetHours: 2,
    Narrations: [
      'shivers despite the warmth.',
      'hugs their arms against a wave of nausea.',
      'wipes at their watering eyes.',
    ],
  },
  Cannabis: {
    GainPerDose: 4,
    DecayPerHour: 0.75,
    WithdrawalOnsetHours: 12,
    Narrations: [
      'drums their fingers with thin patience.',
      'rubs their temples and exhales slowly.',
      'picks at the seam of their sleeve.',
    ],
  },
  Psychedelic: {
    GainPerDose: 1,
    DecayPerHour: 1,
    WithdrawalOnsetHours: 24,
    Narrations: [
      'stares a moment too long at nothing in particular.',
      'blinks as if surfacing from somewhere else.',
    ],
  },
  Sedative: {
    GainPerDose: 8,
    DecayPerHour: 0.5,
    WithdrawalOnsetHours: 4,
    Narrations: [
      'steadies one trembling hand with the other.',
      'blinks heavily, slow to refocus.',
      'grips the nearest surface until a tremor passes.',
    ],
  },
  Alcohol: {
    GainPerDose: 5,
    DecayPerHour: 0.6,
    WithdrawalOnsetHours: 6,
    Narrations: [
      'wipes a fine sheen of sweat from their forehead.',
      'flexes unsteady fingers.',
      'swallows hard against a dry throat.',
    ],
  },
};

/** Addiction level ceiling - matches the DECIMAL(5,2) column. */
export const AddictionLevelCap = 100;

/** Level at or above which a missed window means withdrawal. */
export const AddictionThreshold = 40;

/** How often the server evaluates spawned players for withdrawal. */
export const WithdrawalSweepIntervalMs = 60_000;

/** Minimum spacing between one character's withdrawal symptoms. */
export const WithdrawalSymptomIntervalMs = 120_000;

/** Column-range HP lost per withdrawal symptom. */
export const WithdrawalDrainHp = 1;

/**
 * Withdrawal never drains below this column HP - it makes a
 * character miserable and fragile, never dead. The injury machine
 * stays the only road to the ground.
 */
export const WithdrawalDrainFloorHp = 25;

/** Client-side sanity ceiling on a withdrawal tick's |HpDelta|. */
export const WithdrawalMaxAbsHpDelta = 5;

/** One standard drink's ethanol grams - the alcohol DoseScale unit. */
export const StandardDrinkEthanolGrams = 14;

/** RecordDose clamps DoseScale into this band so one giant pour cannot hook a character instantly. */
export const DoseScaleMin = 0.25;
export const DoseScaleMax = 3;

/** ThcPercent at which cannabis counts as full potency (hash territory). */
export const ThcReferencePercent = 40;

/** Floor so even garbage product produces a faint effect. */
export const PotencyFloor = 0.1;

/**
 * Batch potency as a 0..1 fraction, read from a row's hidden
 * metadata: Purity drives powders, ThcPercent drives cannabis, and a
 * batch carrying neither (pharmaceutical pills) is factory-standard.
 * The visible Quality label is the player-facing face of these
 * hidden values and is deliberately not consulted - it is moderated
 * flavour text, not a number.
 */
export function PotencyFromMetadata(MetadataJson: string | null): number {
  if (MetadataJson === null) return 1;
  try {
    const Parsed = JSON.parse(MetadataJson) as Record<string, unknown>;
    const Purity = Parsed['Purity'];
    if (typeof Purity === 'number' && Number.isFinite(Purity)) {
      return Math.min(1, Math.max(PotencyFloor, Purity / 100));
    }
    const Thc = Parsed['ThcPercent'];
    if (typeof Thc === 'number' && Number.isFinite(Thc)) {
      return Math.min(1, Math.max(PotencyFloor, Thc / ThcReferencePercent));
    }
    return 1;
  } catch {
    return 1;
  }
}

/** Lazily decayed addiction level after `ElapsedMs` of abstinence. */
export function DecayedAddictionLevel(
  Level: number,
  ElapsedMs: number,
  Class: DrugClass,
): number {
  const Shed = (ElapsedMs / 3_600_000) * AddictionTuning[Class].DecayPerHour;
  return Math.max(0, Level - Shed);
}
