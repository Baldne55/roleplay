/**
 * Blood-alcohol constants shared between Backend and (later) Frontend.
 *
 * The model is a deliberately small Widmark slice: drinking adds
 * ethanol grams to the character row, the liver removes them at a
 * fixed hourly rate, and the breathalyzer projects whatever remains
 * into a BAC percentage. Decay is computed lazily from the stored
 * timestamp - there is no server tick; a row that nobody reads costs
 * nothing.
 *
 * Intoxication EFFECTS (movement, camera, screen) stay deferred to the
 * bar slice. This module only makes the number real so the alcohol
 * items' ABV values and the breathalyzer device stop being inert.
 */

/**
 * Ethanol density in grams per millilitre. The drink's pour comes
 * from the catalog's LiquidVolumeMl (falling back to WeightGrams for
 * any future drink that omits it - a hot fallback, since carry weight
 * includes the vessel), so grams of ethanol = pour ml x ABV% x this
 * factor.
 */
export const EthanolDensityGramsPerMl = 0.789;

/**
 * Widmark distribution ratio. The published male/female averages are
 * 0.68 / 0.55; characters carry no body-mass data, so one fixed ratio
 * keeps the projection deterministic and argument-free.
 */
export const WidmarkDistributionRatio = 0.68;

/** Assumed body mass for the Widmark projection, in grams (80 kg). */
export const AssumedBodyMassGrams = 80_000;

/**
 * Liver elimination rate in ethanol grams per hour. Human baseline is
 * roughly 7-10 g/h; 12 runs slightly fast so a heavy session does not
 * outlast an entire play evening.
 */
export const EliminationGramsPerHour = 12;

/** Breath-test proximity requirement; matches the other close-interaction ranges. */
export const BreathTestRangeMeters = 3;

/**
 * Hard ceiling on how long any amount of alcohol lingers, in hours
 * since the last drink. Linear elimination alone is unbounded -
 * grams stack, and a determined bender against the storage ceiling
 * would take weeks of wall-clock to clear - so past this window the
 * character reads fully sober regardless of intake. Four hours
 * leaves ordinary sessions untouched (roughly three drinks or fewer
 * clear linearly sooner anyway) while guaranteeing that a night away
 * from the server, an arrest, or a long hospital stay always ends
 * sober.
 */
export const SoberExpiryHours = 4;

/** Ceiling on stored ethanol grams - matches the DECIMAL(6,2) column. */
export const MaxStoredEthanolGrams = 9_999;

/** Ethanol grams contributed by one consumed drink's pour. */
export function EthanolGramsForDrink(PourMl: number, AlcoholPercent: number): number {
  return PourMl * (AlcoholPercent / 100) * EthanolDensityGramsPerMl;
}

/**
 * Remaining ethanol grams after `ElapsedMs` of elimination; zero
 * outright once the sober expiry passes. Every read and every
 * decay-then-add write flows through here, so the expiry needs no
 * bookkeeping of its own.
 */
export function DecayedEthanolGrams(Grams: number, ElapsedMs: number): number {
  if (ElapsedMs >= SoberExpiryHours * 3_600_000) return 0;
  const Eliminated = (ElapsedMs / 3_600_000) * EliminationGramsPerHour;
  return Math.max(0, Grams - Eliminated);
}

/** Widmark projection: ethanol grams -> BAC as a mass percentage. */
export function BacPercentFromGrams(Grams: number): number {
  return (Grams / (WidmarkDistributionRatio * AssumedBodyMassGrams)) * 100;
}

/** Render a BAC percentage the way the device would print it: "0.084%". */
export function FormatBacPercent(Percent: number): string {
  return `${Percent.toFixed(3)}%`;
}
