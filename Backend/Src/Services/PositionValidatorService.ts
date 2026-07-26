import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(Entity: number): { x: number; y: number; z: number } & [number, number, number];
declare function GetEntityVelocity(Entity: number): { x: number; y: number; z: number } & [number, number, number];
declare function GetEntityHeading(Entity: number): number;
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;
declare function GetVehiclePedIsIn(Ped: number, LastVehicle: boolean): number;
declare function GetEntityAttachedTo(Entity: number): number;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Anti-teleport position-delta validator. Operates entirely server-side
 * via FiveM server natives - no client trust.
 *
 *   - Spawn pathway calls Seed(Source, initial coord) when a character
 *     enters the world. That value is sane by construction (server
 *     placed the ped there).
 *   - A recurring tick reads GetEntityCoords / GetEntityHeading /
 *     GetPlayerRoutingBucket from the engine. If the per-tick distance
 *     to the previous sane value exceeds the threshold, the snapshot is
 *     discarded (last-sane stays in the cache) and a violation count
 *     ticks up.
 *   - Disconnect / character-switch reads `Get(Source)` and persists
 *     that value rather than a fresh native read - any in-progress
 *     teleport hack at the moment of disconnect lands on the last
 *     verified coord instead.
 *   - SetServerOverride lets future server-driven teleports (interior
 *     entry, jail, hospital, /tp admin) bypass the validator by
 *     resetting the baseline. Without this, a legitimate server
 *     teleport would trip the next tick.
 *
 * Threshold: 200m per tick @ 2s interval = ~100 m/s average. Covers
 * most legitimate vehicles (top-end supercars ~80 m/s, jets ~150 m/s
 * sustained but they ramp up smoothly, never single-tick jumps).
 * Catches obvious teleports of >200m in a 2s window.
 *
 * Movement-aware analysis: snapshots that pass the teleport gate feed
 * a rolling per-Source sample window which backs four further
 * detections - on-foot speed, in-vehicle speed, on-foot fly and
 * super-jump (thresholds documented on the class constants). Unlike
 * the teleport branch, none of these freeze the last-sane coord: the
 * position is real, merely reached impossibly fast. Grace and Suspend
 * windows produce no movement reports and reset the sample history.
 */
export interface ValidatedPosition {
  X: number;
  Y: number;
  Z: number;
  Heading: number;
  World: number;
}

/** Discriminator for the violation sink - one literal per detection the validator produces. */
export type PositionViolationKind = 'Teleport' | 'OnFootSpeed' | 'InVehicleSpeed' | 'OnFootFly' | 'SuperJump';

/**
 * Snapshot handed to the violation sink when a tick trips a detection.
 * `Last` is the retained sane coord (for `Teleport` the discarded
 * hostile snapshot is deliberately not exposed - it is unvouched data;
 * for the movement kinds it is simply the previous tick's coord).
 */
export interface PositionViolation {
  Source: number;
  Kind: PositionViolationKind;
  /**
   * The figure depends on Kind:
   *   - Teleport: straight-line meters between the discarded snapshot
   *     and the last sane coord.
   *   - OnFootSpeed / InVehicleSpeed: horizontal speed in meters per
   *     second over the last tick.
   *   - OnFootFly: net Z gain in meters across the sample window.
   *   - SuperJump: single-tick Z gain in meters.
   */
  Meters: number;
  ElapsedMs: number;
  Violations: number;
  Last: ValidatedPosition;
  Evidence?: Record<string, unknown>;
}

/**
 * One per-tick movement observation. The rolling window (newest last)
 * backs the detections that need history - consecutive-tick runs and
 * net climb across several ticks while never in a vehicle.
 */
interface MovementSample {
  X: number;
  Y: number;
  Z: number;
  TickMs: number;
  InVehicle: boolean;
  VelocityZ: number;
}

/**
 * Per-player movement-validation state.
 *
 * `Samples` is a rolling window rather than a single previous position
 * because one implausible step is not evidence - a legitimate teleport
 * (spawn, respawn, admin move) looks identical to a cheat in isolation.
 * `Violations` accumulates across the window so a sustained pattern is
 * what trips the detection.
 */
interface ValidatorEntry {
  Last: ValidatedPosition;
  LastTickMs: number;
  Violations: number;
  /** Rolling window of the last MovementWindowSize observations (newest last). */
  Samples: MovementSample[];
  /** Consecutive ticks of on-foot horizontal speed above threshold. */
  OnFootSpeedTicks: number;
  /** Consecutive ticks of in-vehicle horizontal speed above threshold. */
  InVehicleSpeedTicks: number;
  /** Consecutive ticks of on-foot upward velocity above threshold. */
  OnFootFlyTicks: number;
  /**
   * Consecutive ticks the teleport gate has tripped while holding the
   * frozen baseline. After MaxFrozenTeleportTicks the baseline is
   * force-re-based to the observed coord so the violation stream cannot
   * emit forever against a stale last-sane value.
   */
  TeleportTripTicks: number;
  /**
   * Per-kind monotonic timestamp of the last movement report. The
   * anti-cheat policy weights assume at most one report per kind per
   * MovementReportThrottleMs.
   */
  LastReportMs: Partial<Record<PositionViolationKind, number>>;
  /**
   * Until this monotonic timestamp, ticks update `Last` without
   * threshold checks. Set on Seed (post-spawn model-load can take
   * several seconds, during which the engine briefly reports the
   * pre-spawn coord) and on SetServerOverride (teleport just landed,
   * the next native read will look like a huge jump).
   */
  GraceUntilMs: number;
}

/**
 * The validator itself - see the file header for the detection model.
 *
 * Owns the authoritative last-known position for every spawned player,
 * which makes it two things at once: the teleport/speed detector, and the
 * position source other systems read when they need a coord they can
 * trust rather than one the client just claimed.
 *
 * Runs on its own timer, started explicitly from Bootstrap rather than in
 * the constructor, so composition order stays visible at the call site.
 */
export class PositionValidatorService {
  private readonly Log = Logger.New('PositionValidator');
  private readonly Cache = new Map<number, ValidatorEntry>();
  private readonly TickIntervalMs = 2000;
  private readonly MaxDeltaMetersPerTick = 200;
  /**
   * Teleport ceiling while the ped is inside a vehicle. 400m per tick @
   * 2s = ~200 m/s, above the fastest stock aircraft. The on-foot
   * ceiling (MaxDeltaMetersPerTick) would consume any sample in the
   * 100-170 m/s band before AnalyzeMovement runs, making the InVehicle
   * speed detector unreachable; raising the in-vehicle ceiling lets
   * that band fall through to the movement analysis instead.
   */
  private readonly MaxVehicleDeltaMetersPerTick = 400;
  /**
   * Consecutive teleport-trip ticks tolerated while holding the frozen
   * baseline before it is force-re-based to the observed coord. A real
   * teleport hack stays put after the first trip (one report, then
   * within threshold); a legitimate jet at 150 m/s would otherwise trip
   * forever against an ever-frozen baseline, so after this many trips
   * the baseline is re-seeded to the current coord to stop the stream.
   */
  private readonly MaxFrozenTeleportTicks = 3;
  /**
   * Per-Source floor between Teleport reports. The frozen-baseline
   * window can span several ticks; this caps it to one report per
   * period rather than one per tick.
   */
  private readonly TeleportReportThrottleMs = 10000;
  /** Samples retained per Source for the window-based movement checks. */
  private readonly MovementWindowSize = 5;
  /** Speed / climb signals must persist this many consecutive ticks before a report. */
  private readonly ConsecutiveTickTrigger = 3;
  /**
   * Horizontal on-foot ceiling. Sprint tops out around 7 m/s; 15 m/s
   * held for three consecutive ticks is unreachable legitimately.
   */
  private readonly OnFootSpeedMetersPerSecond = 15;
  /**
   * Horizontal in-vehicle ceiling. Jets sustain roughly 150 m/s;
   * 170 m/s held for three consecutive ticks exceeds any stock top end.
   */
  private readonly InVehicleSpeedMetersPerSecond = 170;
  /**
   * A ped descending faster than this is falling or parachuting - a
   * thrown ped translates fast horizontally, so the on-foot speed
   * check excludes those samples.
   */
  private readonly FallingVelocityZMetersPerSecond = -4;
  /**
   * Sustained upward velocity above this marks fly-mode movement - no
   * engine mechanic moves a ped upward continuously.
   */
  private readonly FlyVelocityZMetersPerSecond = 5;
  /** Net Z gain across a full never-in-vehicle sample window that marks fly-mode movement. */
  private readonly FlyWindowZGainMeters = 30;
  /**
   * Single-tick Z gain that marks a super jump while the ped is still
   * moving upward. Explosions and vehicle clips can hurl a ped - that
   * is why the policy for this type alerts slowly.
   */
  private readonly SuperJumpZGainMeters = 12;
  /**
   * Per-kind, per-Source floor between movement reports. The
   * anti-cheat policy weights are calibrated against this cadence.
   */
  private readonly MovementReportThrottleMs = 30000;
  /**
   * A coord whose XYZ all fall within this radius of world origin is
   * treated as "not yet loaded" - the engine reports (0, 0, 0) for a
   * brief window during ped spawn / model swap. Persisting that lands
   * the player in the ocean on next login.
   */
  private readonly OriginRadius = 5;
  private TickHandle: NodeJS.Timeout | null = null;
  private ViolationSink: ((V: PositionViolation) => void) | null = null;

  /**
   * Wire the anti-cheat pipeline. The validator stays constructible
   * without it (Bootstrap order: validator starts before the chat
   * surface the pipeline alerts through), so the sink attaches late.
   */
  SetViolationSink(Sink: (V: PositionViolation) => void): void {
    this.ViolationSink = Sink;
  }

  /** Begin the movement-validation tick. Idempotent. */
  Start(): void {
    if (this.TickHandle !== null) return;
    this.TickHandle = setInterval(() => this.Tick(), this.TickIntervalMs);
    this.Log.Debug(
      `Started - tick=${this.TickIntervalMs}ms threshold=${this.MaxDeltaMetersPerTick}m`,
    );
  }

  /** Halt the validation tick. Idempotent. */
  Stop(): void {
    if (this.TickHandle === null) return;
    clearInterval(this.TickHandle);
    this.TickHandle = null;
  }

  /**
   * Establish the baseline sane coord when a character spawns. The
   * spawn pathway has just placed the ped via SetEntityCoords on the
   * client; server-side this is the authoritative starting point.
   */
  Seed(Source: number, Position: ValidatedPosition): void {
    const Now = Date.now();
    this.Cache.set(Source, {
      Last: { ...Position },
      LastTickMs: Now,
      Violations: 0,
      Samples: [],
      OnFootSpeedTicks: 0,
      InVehicleSpeedTicks: 0,
      OnFootFlyTicks: 0,
      TeleportTripTicks: 0,
      LastReportMs: {},
      GraceUntilMs: Now + 5000,
    });
    this.Log.Debug(
      `Seeded source=${Source} at (${Position.X.toFixed(1)}, ${Position.Y.toFixed(1)}, ${Position.Z.toFixed(1)})`,
    );
  }

  /**
   * Read the last sane position. Used by the disconnect persist path
   * so the saved coord is one the validator vouched for (not a fresh
   * native read that could include an in-flight hack).
   */
  Get(Source: number): ValidatedPosition | null {
    return this.Cache.get(Source)?.Last ?? null;
  }

  /**
   * Atomic fetch + remove. Called from playerDropped / character-switch
   * so a reconnect on the same Source can't race against a late save.
   */
  Detach(Source: number): ValidatedPosition | null {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) return null;
    this.Cache.delete(Source);
    return Entry.Last;
  }

  /**
   * Reset the baseline after a server-driven teleport (interior entry,
   * /tp admin, jail, hospital). Without this the next tick reports a
   * huge delta against a stale baseline and trips the validator.
   */
  SetServerOverride(Source: number, Position: ValidatedPosition): void {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) {
      this.Seed(Source, Position);
      return;
    }
    const Now = Date.now();
    Entry.Last = { ...Position };
    Entry.LastTickMs = Now;
    Entry.GraceUntilMs = Now + 2000;
  }

  /**
   * Indefinitely waive the delta check for this Source. The Tick still
   * walks the entry and refreshes Last / Heading / World from natives;
   * the threshold gate and the movement detections are bypassed. Use
   * for server-driven mobility modes that move the ped faster than any
   * vehicle - /noclip today, future cinematic-cam / spectate flows
   * tomorrow.
   */
  Suspend(Source: number): void {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) return;
    Entry.GraceUntilMs = Number.MAX_SAFE_INTEGER;
    this.Log.Debug(`Suspended source=${Source}`);
  }

  /**
   * End a Suspend window. The standard 2-second grace fires so the next
   * tick after Resume does not trip on a queued-up native coord that
   * was already authoritative while Suspended.
   */
  Resume(Source: number): void {
    const Entry = this.Cache.get(Source);
    if (Entry === undefined) return;
    Entry.GraceUntilMs = Date.now() + 2000;
    this.Log.Debug(`Resumed source=${Source}`);
  }

  /**
   * Sample every spawned player's position and compare against the
   * plausible travel budget since the last sample.
   *
   * Judges on a rolling window rather than a single step, because one
   * implausible jump is not evidence - legitimate teleports (spawn,
   * respawn, an admin move) look identical in isolation. Sustained
   * violations are what trip the detection.
   */
  private Tick(): void {
    const Now = Date.now();
    for (const [Source, Entry] of this.Cache.entries()) {
      try {
        const SrcStr = String(Source);
        const Ped = GetPlayerPed(SrcStr);
        if (Ped === 0) continue;

        const Coords = GetEntityCoords(Ped);
        const X = Number(Coords[0]);
        const Y = Number(Coords[1]);
        const Z = Number(Coords[2]);
        if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) {
          continue;
        }

        // Skip near-origin reads - the engine briefly reports (0,0,0)
        // during model swap / scene load.
        if (
          Math.abs(X) < this.OriginRadius &&
          Math.abs(Y) < this.OriginRadius &&
          Math.abs(Z) < this.OriginRadius
        ) {
          continue;
        }

        const InGrace = Now < Entry.GraceUntilMs;
        if (InGrace) {
          // Grace / Suspend windows must produce no movement reports,
          // and their coords must not seed the sample window - a
          // server teleport mid-grace would otherwise read as a huge
          // climb or sprint on the first post-grace tick.
          this.ResetMovementState(Entry);
          Entry.TeleportTripTicks = 0;

          // Continuity guard: during grace the baseline is the
          // server-installed seed / override coord. Accept a native
          // read as the new Last only when it is continuous with that
          // coord (within MaxDeltaMetersPerTick). If model-load lag
          // briefly reports the pre-teleport coord, that stale read is
          // skipped so grace converges on the server-installed coord
          // rather than persisting the wrong position.
          const GraceDx = X - Entry.Last.X;
          const GraceDy = Y - Entry.Last.Y;
          const GraceDz = Z - Entry.Last.Z;
          const GraceMeters = Math.sqrt(GraceDx * GraceDx + GraceDy * GraceDy + GraceDz * GraceDz);
          if (GraceMeters > this.MaxDeltaMetersPerTick) {
            // Discontinuous read - hold the server-installed coord and
            // let grace continue; do not refresh Last / LastTickMs.
            continue;
          }
        } else {
          const Dx = X - Entry.Last.X;
          const Dy = Y - Entry.Last.Y;
          const Dz = Z - Entry.Last.Z;
          const Meters = Math.sqrt(Dx * Dx + Dy * Dy + Dz * Dz);

          // The teleport ceiling is vehicle-aware: a fast aircraft
          // legitimately covers a large per-tick distance, so its
          // samples must fall through to AnalyzeMovement (which owns
          // the in-vehicle speed detector) rather than being consumed
          // by the on-foot ceiling here.
          let InVehicle = false;
          try {
            InVehicle = GetVehiclePedIsIn(Ped, false) !== 0;
          } catch {
            InVehicle = false;
          }
          const DeltaCeiling = InVehicle ? this.MaxVehicleDeltaMetersPerTick : this.MaxDeltaMetersPerTick;

          if (Meters > DeltaCeiling) {
            Entry.TeleportTripTicks += 1;
            Entry.Violations += 1;
            this.Log.Warn(
              `Delta over threshold: source=${Source} ${Meters.toFixed(1)}m in ${(
                (Now - Entry.LastTickMs) / 1000
              ).toFixed(1)}s violations=${Entry.Violations} trips=${Entry.TeleportTripTicks}`,
            );
            this.ReportTeleport(Source, Entry, Meters, Now);

            if (Entry.TeleportTripTicks >= this.MaxFrozenTeleportTicks) {
              // The frozen baseline has self-perpetuated for too long
              // (e.g. a jet whose per-tick distance stays above the
              // ceiling): force-re-base Last to the observed coord so
              // the stream cannot emit forever. The reports already
              // dispatched stand as the evidence. Reset the trip
              // counter and fall through to the baseline refresh below.
              Entry.TeleportTripTicks = 0;
            } else {
              // Hold the previous sane coord; do NOT update Last.
              continue;
            }
          } else {
            // A tick landed within threshold - the trip run is over.
            Entry.TeleportTripTicks = 0;

            // The snapshot passed the teleport gate - run the movement
            // detections. None of them discard the snapshot, so the
            // baseline update below proceeds regardless.
            this.AnalyzeMovement(Source, Entry, Ped, InVehicle, X, Y, Z, Dx, Dy, Dz, Now);
          }
        }

        const Heading = Number(GetEntityHeading(Ped));
        const World = Number(GetPlayerRoutingBucket(SrcStr));
        Entry.Last.X = X;
        Entry.Last.Y = Y;
        Entry.Last.Z = Z;
        Entry.Last.Heading = Number.isFinite(Heading) ? Heading : Entry.Last.Heading;
        Entry.Last.World = Number.isFinite(World) ? World : Entry.Last.World;
        Entry.LastTickMs = Now;
      } catch (Err: unknown) {
        this.Log.Error(`Tick failed for source=${Source}`, { Err: String(Err) });
      }
    }
  }

  /**
   * Movement-aware analysis for a snapshot that already passed the
   * teleport gate. Dx / Dy / Dz are the deltas against the last-sane
   * coord the caller just computed. None of these detections freeze
   * last-sane - the position is real, merely reached impossibly fast.
   * `InVehicle` was read by the caller (the teleport gate is
   * vehicle-aware) and is threaded through to avoid a second native
   * read.
   */
  private AnalyzeMovement(
    Source: number,
    Entry: ValidatorEntry,
    Ped: number,
    InVehicle: boolean,
    X: number,
    Y: number,
    Z: number,
    Dx: number,
    Dy: number,
    Dz: number,
    Now: number,
  ): void {
    // Velocity context is best-effort: a failed native read skips this
    // tick's analysis but must not block the baseline update in the
    // caller.
    let VelocityZ = 0;
    let AttachedTo = 0;
    try {
      const Velocity = GetEntityVelocity(Ped);
      VelocityZ = Number(Velocity[2]);
      AttachedTo = GetEntityAttachedTo(Ped);
    } catch {
      return;
    }
    if (!Number.isFinite(VelocityZ)) return;

    const ElapsedMs = Now - Entry.LastTickMs;
    if (ElapsedMs <= 0) return;
    const HorizontalMetersPerSecond = Math.sqrt(Dx * Dx + Dy * Dy) / (ElapsedMs / 1000);

    Entry.Samples.push({ X, Y, Z, TickMs: Now, InVehicle, VelocityZ });
    if (Entry.Samples.length > this.MovementWindowSize) Entry.Samples.shift();

    // On-vehicle-contact carve-out: a ped standing on a moving flatbed,
    // truck bed, boat deck or train is "on foot" (GetVehiclePedIsIn
    // returns 0) yet translates at vehicle speed, falsely flagging
    // OnFootSpeed and the OnFootFly window-gain trigger. When the ped
    // is attached to an entity, treat the sample as vehicle-context:
    // reset the on-foot speed / fly runs and skip those two
    // evaluations. The teleport check (in the caller), the in-vehicle
    // handling and the super-jump check are unaffected.
    const OnVehicleContact = !InVehicle && AttachedTo !== 0;
    if (OnVehicleContact) {
      Entry.OnFootSpeedTicks = 0;
      Entry.OnFootFlyTicks = 0;
    }

    // ── Horizontal speed ─────────────────────────────────────────────
    if (OnVehicleContact) {
      // Carve-out: on-foot speed evaluation skipped (counters already
      // reset above); in-vehicle speed does not apply to a ped merely
      // riding on an entity.
      Entry.InVehicleSpeedTicks = 0;
    } else if (InVehicle) {
      Entry.OnFootSpeedTicks = 0;
      Entry.InVehicleSpeedTicks =
        HorizontalMetersPerSecond > this.InVehicleSpeedMetersPerSecond ? Entry.InVehicleSpeedTicks + 1 : 0;
      if (Entry.InVehicleSpeedTicks >= this.ConsecutiveTickTrigger) {
        this.ReportMovement(Source, Entry, 'InVehicleSpeed', HorizontalMetersPerSecond, ElapsedMs, Now, {
          HorizontalMetersPerSecond: Round1(HorizontalMetersPerSecond),
          ConsecutiveTicks: Entry.InVehicleSpeedTicks,
        });
      }
    } else {
      Entry.InVehicleSpeedTicks = 0;
      if (VelocityZ < this.FallingVelocityZMetersPerSecond) {
        // Falling / parachuting - a thrown ped translates fast
        // horizontally, so the sample is excluded and the run restarts.
        Entry.OnFootSpeedTicks = 0;
      } else {
        Entry.OnFootSpeedTicks =
          HorizontalMetersPerSecond > this.OnFootSpeedMetersPerSecond ? Entry.OnFootSpeedTicks + 1 : 0;
      }
      if (Entry.OnFootSpeedTicks >= this.ConsecutiveTickTrigger) {
        this.ReportMovement(Source, Entry, 'OnFootSpeed', HorizontalMetersPerSecond, ElapsedMs, Now, {
          HorizontalMetersPerSecond: Round1(HorizontalMetersPerSecond),
          ConsecutiveTicks: Entry.OnFootSpeedTicks,
        });
      }
    }

    // ── Vertical: fly ────────────────────────────────────────────────
    // Carve-out: the OnFootFly evaluation is skipped for a ped riding
    // on an entity (counter already reset above); the upward
    // translation belongs to the carrier, not fly-mode movement.
    if (!OnVehicleContact) {
      Entry.OnFootFlyTicks = !InVehicle && VelocityZ > this.FlyVelocityZMetersPerSecond ? Entry.OnFootFlyTicks + 1 : 0;
      const First = Entry.Samples[0];
      const WindowZGain = First !== undefined ? Z - First.Z : 0;
      const ConsecutiveClimb = Entry.OnFootFlyTicks >= this.ConsecutiveTickTrigger;
      const SustainedGain =
        Entry.Samples.length === this.MovementWindowSize &&
        Entry.Samples.every((S) => !S.InVehicle) &&
        WindowZGain > this.FlyWindowZGainMeters;
      if (ConsecutiveClimb || SustainedGain) {
        this.ReportMovement(Source, Entry, 'OnFootFly', WindowZGain, ElapsedMs, Now, {
          ZGainMeters: Round1(WindowZGain),
          VerticalMetersPerSecond: Round1(VelocityZ),
          ConsecutiveTicks: Entry.OnFootFlyTicks,
          Trigger: ConsecutiveClimb ? 'ConsecutiveClimb' : 'WindowGain',
        });
      }
    }

    // ── Vertical: super jump ─────────────────────────────────────────
    if (!InVehicle && Dz > this.SuperJumpZGainMeters && VelocityZ > 0) {
      this.ReportMovement(Source, Entry, 'SuperJump', Dz, ElapsedMs, Now, {
        ZGainMeters: Round1(Dz),
        VerticalMetersPerSecond: Round1(VelocityZ),
      });
    }
  }

  /**
   * Throttled sink dispatch for the Teleport kind. The frozen-baseline
   * window can span MaxFrozenTeleportTicks ticks; this caps it to one
   * report per TeleportReportThrottleMs per Source so even within the
   * freeze window it is at most one report per period, not one per
   * tick. The retained sane coord is reported as Last (the discarded
   * hostile snapshot is deliberately not exposed).
   */
  private ReportTeleport(Source: number, Entry: ValidatorEntry, Meters: number, Now: number): void {
    const LastMs = Entry.LastReportMs['Teleport'] ?? 0;
    if (Now - LastMs < this.TeleportReportThrottleMs) return;
    Entry.LastReportMs['Teleport'] = Now;
    if (this.ViolationSink === null) return;
    this.ViolationSink({
      Source,
      Kind: 'Teleport',
      Meters,
      ElapsedMs: Now - Entry.LastTickMs,
      Violations: Entry.Violations,
      Last: { ...Entry.Last },
    });
  }

  /**
   * Throttled sink dispatch for the movement kinds: at most one report
   * per kind per MovementReportThrottleMs per Source. The teleport
   * branch uses its own ReportTeleport throttle - its policy expects a
   * tighter cadence than the movement kinds.
   */
  private ReportMovement(
    Source: number,
    Entry: ValidatorEntry,
    Kind: PositionViolationKind,
    Meters: number,
    ElapsedMs: number,
    Now: number,
    Evidence: Record<string, unknown>,
  ): void {
    const LastMs = Entry.LastReportMs[Kind] ?? 0;
    if (Now - LastMs < this.MovementReportThrottleMs) return;
    Entry.LastReportMs[Kind] = Now;
    Entry.Violations += 1;
    this.Log.Warn(
      `Movement violation: kind=${Kind} source=${Source} meters=${Meters.toFixed(1)} violations=${Entry.Violations}`,
    );
    if (this.ViolationSink === null) return;
    this.ViolationSink({
      Source,
      Kind,
      Meters,
      ElapsedMs,
      Violations: Entry.Violations,
      Last: { ...Entry.Last },
      Evidence,
    });
  }

  /**
   * Drop accumulated movement history. Grace and Suspend coords are
   * server-vouched but discontinuous - they must not feed the
   * consecutive-tick runs or the window-gain check.
   */
  private ResetMovementState(Entry: ValidatorEntry): void {
    if (Entry.Samples.length > 0) Entry.Samples.length = 0;
    Entry.OnFootSpeedTicks = 0;
    Entry.InVehicleSpeedTicks = 0;
    Entry.OnFootFlyTicks = 0;
  }
}

/** One-decimal rounding for evidence figures - keeps the persisted JSON compact. */
function Round1(Value: number): number {
  return Math.round(Value * 10) / 10;
}
