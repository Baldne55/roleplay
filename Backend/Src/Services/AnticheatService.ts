import {
  AnticheatAlertCooldownMs,
  AnticheatExpectedStateBagKey,
  AnticheatPolicies,
  type AnticheatDetectionType,
  type AnticheatExpectedStateKey,
} from '@Shared/Constants/Anticheat.js';
import { ChatFormatter } from '@Shared/Chat/Index.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { DiscordWebhookService } from '@/Services/DiscordWebhookService.js';
import type { AnticheatViolationRepository } from '@/Data/Repositories/AnticheatViolationRepository.js';
import type { ServerConfig } from '@/Infrastructure/Config/ServerConfig.js';
import type { PositionViolation } from '@/Services/PositionValidatorService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(Entity: number): { x: number; y: number; z: number } & [number, number, number];
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;
declare function GetVehiclePedIsIn(Ped: number, LastVehicle: boolean): number;
declare function DropPlayer(PlayerSrc: string, Reason: string): void;
declare function AddStateBagChangeHandler(
  KeyFilter: string | null,
  BagFilter: string | null,
  Handler: (BagName: string, Key: string, Value: unknown, Reserved: number, Replicated: boolean) => void,
): number;
declare function GetPlayerFromStateBagName(BagName: string): number;
declare function Player(Source: number | string): {
  state: {
    set(Key: string, Value: unknown, Replicated: boolean): void;
  };
};
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * SMALLINT ceiling for the persisted session_score column. Scores are
 * clamped to this before write - a long session against a noisy detection
 * can otherwise exceed the column width and fail the INSERT, losing the
 * violation row entirely.
 *
 * Declared up here rather than next to the class so the class doc block
 * stays adjacent to the class it documents.
 */
const SessionScoreCeiling = 32767;

/**
 * Running score for one player against one detection type.
 *
 * `LastAlertMs` throttles alerting rather than scoring: score keeps
 * accruing on every detection, but the Discord/staff alert fires at most
 * once per window so a sustained cheat does not flood the channel.
 */
interface ScoreEntry {
  Score: number;
  LastAlertMs: number;
}

/**
 * Central anti-cheat pipeline. Every detection - in any service, any
 * controller, any phase - funnels through Report():
 *
 *   1. Exemption: on-duty staff never score (they are the ones testing
 *      cheat-shaped mechanics). Detection-specific sanctions (noclip,
 *      server warps) are checked by the DETECTOR via IsSanctioned /
 *      the PositionValidator Suspend hooks before reporting.
 *   2. Scoring: the policy weight accrues onto a per-Source, per-type
 *      session score (evicted on disconnect; the DB row is the durable
 *      record).
 *   3. Persistence: one `anticheat_violations` row per report, with
 *      bounded evidence JSON and the offender's current position.
 *   4. Alerting: crossing the policy AlertAt notifies on-duty staff
 *      in chat plus the Discord webhook, throttled per Source + type.
 *   5. Enforcement: crossing KickAt drops the player - but only when
 *      `anticheat_enforcement` is `kick`. The default `observe` mode
 *      never auto-acts, so thresholds can be tuned against live data
 *      before they bite anyone.
 *
 * The expected-state registry lives here too: the server records the
 * expected value of cheat-shaped client states (noclip on, future
 * invincibility windows / assigned models) and mirrors each onto a
 * replicated `Roleplay:Anticheat:*` player state bag. The server-memory
 * map is the ledger of record; the bag is a broadcast mirror for the
 * client monitor and is never read back server-side, because a client
 * can overwrite its own bag keys. The state-bag tamper watch is the
 * complement of that rule: no client has a legitimate write path to
 * any `Roleplay:`-prefixed player bag key, so a client-originated bag
 * write is itself a detection and reports into the scoring pipeline
 * (the Reserved-arg origin signal was field-confirmed 2026-06-11 -
 * see HandleStateBagWrite).
 */
export class AnticheatService {
  private readonly Log = Logger.New('Anticheat');
  private readonly Scores = new Map<number, Map<AnticheatDetectionType, ScoreEntry>>();
  /**
   * Synthetic scores from `/ac test report`, kept entirely apart from
   * the live Scores map so a drill can never combine with a real flag
   * into a kick, nor pollute the observe-mode tuning data.
   */
  private readonly TestScores = new Map<number, Map<AnticheatDetectionType, ScoreEntry>>();
  private readonly Expected = new Map<number, Map<AnticheatExpectedStateKey, boolean>>();

  constructor(
    private readonly State: PlayerStateService,
    private readonly Violations: AnticheatViolationRepository,
    private readonly Webhook: DiscordWebhookService,
    private readonly Chat: ChatService,
    private readonly Config: ServerConfig,
  ) {
    // State-bag tamper watch. The native's key/bag filters are exact-
    // match only (citizen-scripting-core/ResourceScriptFunctions.cpp
    // compares with ==, no prefix support), so both stay null and the
    // prefix filtering happens in the handler.
    AddStateBagChangeHandler(
      null,
      null,
      (BagName: string, Key: string, Value: unknown, Reserved: number, Replicated: boolean): void => {
        this.HandleStateBagWrite(BagName, Key, Value, Reserved, Replicated);
      },
    );
  }

  /**
   * Sink for PositionValidatorService violations. Teleports resolve
   * the vehicle context server-side (GetVehiclePedIsIn is
   * apiset-server) so the report lands as the precise detection type;
   * the movement kinds already carry their vehicle context and map
   * one-to-one onto detection types of the same name.
   */
  HandlePositionViolation = (V: PositionViolation): void => {
    let Type: AnticheatDetectionType;
    if (V.Kind === 'Teleport') {
      let InVehicle = false;
      try {
        const Ped = GetPlayerPed(String(V.Source));
        InVehicle = Ped !== 0 && GetVehiclePedIsIn(Ped, false) !== 0;
      } catch {
        // Vehicle context is best-effort; report as on-foot when unreadable.
      }
      Type = InVehicle ? 'InVehicleTeleport' : 'OnFootTeleport';
    } else {
      Type = V.Kind;
    }
    this.Report(V.Source, Type, {
      ...V.Evidence,
      Meters: Math.round(V.Meters * 10) / 10,
      ElapsedMs: V.ElapsedMs,
      SessionViolations: V.Violations,
      LastSane: {
        X: Math.round(V.Last.X * 10) / 10,
        Y: Math.round(V.Last.Y * 10) / 10,
        Z: Math.round(V.Last.Z * 10) / 10,
        World: V.Last.World,
      },
    });
  };

  /**
   * Damage arrived from a catalog firearm with no equipped-weapon bag
   * behind it - the single strongest signal the codebase produces.
   * Called from InventoryService.RecordWeaponDischarge after the
   * NPC-attribution gate, so relayed NPC shots never land here.
   */
  ReportWeaponNotGranted(Source: number, WeaponHash: number): void {
    this.Report(Source, 'WeaponNotGranted', { WeaponHash });
  }

  /**
   * The main detection entry point. Scores the event, persists it past
   * the threshold, alerts staff, and enforces if configured to.
   *
   * Silently exempts on-duty staff - admins legitimately do things that
   * look like cheating (noclip, teleport), so their detections are
   * dropped rather than scored. `InjectTestReport` bypasses that
   * exemption, since the tester is necessarily on duty.
   */
  Report(Source: number, Type: AnticheatDetectionType, Evidence: Record<string, unknown>): void {
    this.ReportCore(Source, Type, Evidence, false);
  }

  /**
   * `/ac test report` harness. Pushes one synthetic report through the
   * FULL pipeline - scoring, persistence, staff alert, webhook - in
   * test mode: the on-duty exemption is bypassed (the tester is
   * necessarily on-duty staff, whom Report() would silently exempt)
   * and enforcement is disabled (repeated invocations must never cross
   * a kick line, whatever the enforcement convar says). The evidence
   * carries `Test: true` so the resulting `anticheat_violations` row
   * is never mistaken for a live detection; the second invocation in a
   * session crosses AlertAt and demonstrates the staff-alert + webhook
   * path.
   */
  InjectTestReport(Source: number): void {
    this.ReportCore(Source, 'OnFootTeleport', { Test: true, Meters: 999 }, true);
  }

  /**
   * Shared pipeline behind Report and InjectTestReport.
   *
   * `TestMode` changes exactly two things: the on-duty exemption is
   * skipped, and enforcement never fires however the convar is set - so
   * a drill can be repeated without ever kicking the tester.
   */
  private ReportCore(
    Source: number,
    Type: AnticheatDetectionType,
    Evidence: Record<string, unknown>,
    TestMode: boolean,
  ): void {
    const Policy = AnticheatPolicies[Type];
    const PState = this.State.Get(Source);

    if (!TestMode && PState !== null && PState.AdminDuty) {
      this.Log.Info(`Exempt (on-duty staff): ${Type} source=${Source}`);
      return;
    }

    const Entry = this.UpsertScore(TestMode ? this.TestScores : this.Scores, Source, Type);
    Entry.Score += Policy.Weight;

    const Now = Date.now();
    let Action = 'None';
    const ShouldAlert = Entry.Score >= Policy.AlertAt && Now - Entry.LastAlertMs >= AnticheatAlertCooldownMs;
    if (ShouldAlert) {
      Entry.LastAlertMs = Now;
      Action = 'Alert';
    }
    const ShouldKick =
      !TestMode &&
      this.Config.AnticheatEnforcement === 'kick' &&
      Policy.KickAt !== null &&
      Entry.Score >= Policy.KickAt;
    if (ShouldKick) Action = 'Kick';

    this.Log.Warn(
      `${TestMode ? '[TEST] ' : ''}${Type} source=${Source} score=${Entry.Score} action=${Action} ` +
        `evidence=${BoundedJSON(Evidence, 500)}`,
    );

    void this.Persist(
      Source,
      PState?.AccountID ?? null,
      PState?.CharacterID ?? null,
      Type,
      Entry.Score,
      Action,
      Evidence,
    ).catch((Err: unknown) => {
      this.Log.Error(`Violation persist rejected - source=${Source} type=${Type}`, {
        Err: String(Err),
      });
    });

    if (ShouldAlert || ShouldKick) {
      this.NotifyStaff(Source, Type, Entry.Score, Action, TestMode);
    }
    if (ShouldKick) {
      // Generic reason on purpose - the kick message must not teach a
      // cheater which detection caught them.
      try {
        DropPlayer(String(Source), 'Disconnected by the anti-cheat.');
      } catch (Err: unknown) {
        this.Log.Error(`Kick failed source=${Source}`, { Err: String(Err) });
      }
    }
  }

  // ── Expected-state registry ──────────────────────────────────────

  /**
   * Record the expected value of a cheat-shaped client state and
   * mirror it onto the replicated bag for the client monitor.
   */
  SetExpected(Source: number, Key: AnticheatExpectedStateKey, Value: boolean): void {
    let Entry = this.Expected.get(Source);
    if (Entry === undefined) {
      Entry = new Map();
      this.Expected.set(Source, Entry);
    }
    Entry.set(Key, Value);
    try {
      Player(Source).state.set(AnticheatExpectedStateBagKey(Key), Value, true);
    } catch (Err: unknown) {
      this.Log.Warn(`Expected-state bag write failed - source=${Source} key=${Key}`, { Err: String(Err) });
    }
  }

  /**
   * True when the server itself put this Source into the named
   * cheat-shaped state. Detectors consult this BEFORE reporting -
   * always against the server-memory ledger, never the bag.
   */
  IsSanctioned(Source: number, Key: AnticheatExpectedStateKey): boolean {
    return this.Expected.get(Source)?.get(Key) === true;
  }

  /**
   * Clear the per-Source session state that only makes sense while the
   * player is in the world: live + test scores, and every sanctioned
   * expected-state entry (with its replicated bag mirror reset to
   * false). Invoked when a player leaves the Spawned phase
   * (/changecharacter, /logout) so a noclip sanction or accrued score
   * cannot survive into the next character on the same connection. The
   * full Source teardown still happens on playerDropped via Evict.
   */
  ResetSpawnedState(Source: number): void {
    this.Scores.delete(Source);
    this.TestScores.delete(Source);
    const Keys = this.Expected.get(Source);
    if (Keys !== undefined) {
      for (const Key of Keys.keys()) this.SetExpected(Source, Key, false);
      this.Expected.delete(Source);
    }
  }

  /** Active enforcement mode (`observe` | `kick`) - the `/ac status` surface. */
  get EnforcementMode(): string {
    return this.Config.AnticheatEnforcement;
  }

  /** Live session scores for a Source - the `/ac status` surface. */
  GetSessionScores(Source: number): { Type: AnticheatDetectionType; Score: number }[] {
    const Entry = this.Scores.get(Source);
    if (Entry === undefined) return [];
    return Array.from(Entry.entries()).map(([Type, E]) => ({ Type, Score: E.Score }));
  }

  /**
   * Full per-Source teardown - invoked by the PlayerSessionService
   * playerDropped dispatcher. Plain map deletes, no bag mirror resets:
   * the player bag is gone with the client.
   */
  Evict(Source: number): void {
    this.Scores.delete(Source);
    this.TestScores.delete(Source);
    this.Expected.delete(Source);
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * State-bag tamper watch sink. A client write to any `Roleplay:`
   * player bag key is a detection: the whole namespace is server-owned
   * (the typing indicator, the last legitimate client write, moved to a
   * server-authoritative net event in 0.5.0).
   *
   * Origin signal - verified against citizenfx/fivem master (2026-06)
   * AND confirmed in-game 2026-06-11: the handler's Replicated argument
   * CANNOT discriminate origin on the server (client network writes and
   * server SetKey writes both arrive Replicated=true). The fourth
   * argument (documented "reserved, currently unused") carries SetKey's
   * source: 0 for every server script write, the sender's slot ID for a
   * network write. The /ac test bagwrite canary landed here with
   * reserved=2048 while every routine server write (equip, injury,
   * noclip mirror, nametag) was correctly filtered by the `Reserved===0`
   * gate, so the signal is trusted and this now reports rather than just
   * logs.
   */
  private HandleStateBagWrite(
    BagName: string,
    Key: string,
    Value: unknown,
    Reserved: number,
    Replicated: boolean,
  ): void {
    if (!Key.startsWith('Roleplay:') || !BagName.startsWith('player:')) return;
    // Reserved carries SetKey's source: 0 = server script write (every
    // legitimate producer), non-zero = arrived over the network.
    if (Reserved === 0) return;
    let Source = 0;
    try {
      Source = GetPlayerFromStateBagName(BagName);
    } catch {
      return;
    }
    if (Source === 0) return; // Entity/global bags, or the player is already gone.
    this.Report(Source, 'StateBagTampering', {
      Key,
      BagName,
      Reserved,
      Replicated,
      Value: BoundedJSON({ Value }, 120),
    });
  }

  /**
   * Add weight to a player's running score for one detection type and
   * return the new total, creating the entry on first sighting.
   */
  private UpsertScore(
    Target: Map<number, Map<AnticheatDetectionType, ScoreEntry>>,
    Source: number,
    Type: AnticheatDetectionType,
  ): ScoreEntry {
    let PerType = Target.get(Source);
    if (PerType === undefined) {
      PerType = new Map();
      Target.set(Source, PerType);
    }
    let Entry = PerType.get(Type);
    if (Entry === undefined) {
      Entry = { Score: 0, LastAlertMs: 0 };
      PerType.set(Type, Entry);
    }
    return Entry;
  }

  /**
   * Write the violation row. Fire-and-forget from the detection path: a
   * database failure must never stop enforcement or block the caller,
   * which is usually a net event handler.
   */
  private async Persist(
    Source: number,
    AccountID: string | null,
    CharacterID: string | null,
    Type: AnticheatDetectionType,
    SessionScore: number,
    Action: string,
    Evidence: Record<string, unknown>,
  ): Promise<void> {
    const Policy = AnticheatPolicies[Type];
    const Coord = this.ReadPedCoord(Source);
    try {
      await this.Violations.Append({
        AccountID,
        CharacterID,
        DetectionType: Type,
        Tier: Policy.Tier,
        Weight: Policy.Weight,
        // Clamp to the SMALLINT ceiling - a stuck detection stream must
        // never throw the whole Append on an out-of-range score.
        SessionScore: Math.min(SessionScore, SessionScoreCeiling),
        Action,
        EvidenceJSON: BoundedJSON(Evidence, 2000),
        World: Coord?.World ?? null,
        PositionX: Coord !== null ? Coord.X.toFixed(3) : null,
        PositionY: Coord !== null ? Coord.Y.toFixed(3) : null,
        PositionZ: Coord !== null ? Coord.Z.toFixed(3) : null,
        OccurredAt: new Date(),
      });
    } catch (Err: unknown) {
      this.Log.Error(`Violation persist failed - source=${Source} type=${Type}`, { Err: String(Err) });
    }
  }

  /**
   * Alert on-duty staff in chat and mirror to the Discord webhook.
   *
   * Throttled per Source and detection type by `LastAlertMs` - scoring
   * continues on every event, but a sustained cheat produces one alert
   * per window rather than one per packet.
   */
  private NotifyStaff(
    Source: number,
    Type: AnticheatDetectionType,
    Score: number,
    Action: string,
    TestMode: boolean,
  ): void {
    const PState = this.State.Get(Source);
    const CharacterID = PState?.CharacterID ?? 'none';
    const Tag = TestMode ? 'TEST ' : '';
    const Line = `${Tag}Anticheat: ${Type} - player ${Source} (character ${CharacterID}) score ${Score} action ${Action}.`;

    for (const AdminSource of this.State.GetAllSources()) {
      if (this.State.Get(AdminSource)?.AdminDuty === true) {
        this.Chat.SendTo(AdminSource, ChatFormatter.Admin(Line));
      }
    }
    void this.Webhook.PostAlert(`${Tag}Anti-cheat: ${Type}`, [
      `Player source: ${Source}`,
      `Account: ${PState?.AccountID ?? 'none'} / Character: ${CharacterID}`,
      `Session score: ${Score} (tier ${AnticheatPolicies[Type].Tier})`,
      `Action: ${Action}`,
    ]);
  }

  /**
   * Read a ped's position and routing bucket for detection evidence.
   * Null when the ped cannot be resolved - a player mid-disconnect - in
   * which case the report simply carries no coordinates.
   */
  private ReadPedCoord(Source: number): { World: number; X: number; Y: number; Z: number } | null {
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) return null;
      const Coords = GetEntityCoords(Ped);
      const X = Number(Coords[0]);
      const Y = Number(Coords[1]);
      const Z = Number(Coords[2]);
      if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return null;
      const World = Number(GetPlayerRoutingBucket(String(Source)));
      return { World: Number.isFinite(World) ? World : 0, X, Y, Z };
    } catch {
      return null;
    }
  }
}

/** JSON.stringify with a hard output bound; evidence must never bloat a row or a log line. */
function BoundedJSON(Value: Record<string, unknown>, MaxLength: number): string {
  try {
    const Raw = JSON.stringify(Value);
    return Raw.length > MaxLength ? `${Raw.slice(0, MaxLength - 1)}…` : Raw;
  } catch {
    return '{}';
  }
}
