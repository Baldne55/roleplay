import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import {
  CharacterCreateError,
  CharacterSelectError,
  type CharacterService,
} from '@/Services/CharacterService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type {
  PositionValidatorService,
  ValidatedPosition,
} from '@/Services/PositionValidatorService.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { ChatController } from '@/Controllers/ChatController.js';
import type { InjuryService } from '@/Services/InjuryService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { BleedingService } from '@/Services/BleedingService.js';
import type { PhoneCallService } from '@/Services/PhoneCallService.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function GetPlayerEndpoint(PlayerSrc: string): string;
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(Entity: number): { x: number; y: number; z: number } & [number, number, number];
/* eslint-enable @typescript-eslint/naming-convention */
// Remaining CitizenFX natives, already PascalCase so outside the pragma.
// These four are the disconnect-time snapshot source: they must be read
// synchronously while the player entity still resolves, because an await
// before them can outlive the entity and yield zeroes.
declare function GetEntityHeading(Entity: number): number;
declare function GetEntityHealth(Entity: number): number;
declare function GetPedArmour(Ped: number): number;
declare function GetPlayerRoutingBucket(PlayerSrc: string): number;

/**
 * Character lifecycle - create, list, select, spawn, persist.
 *
 *   onNet CharacterCreate:
 *     1. Require Phase=Authenticated + an AccountID. Anything earlier
 *        is an untrusted client trying to skip the gate.
 *     2. Validate + persist via CharacterService.Create.
 *     3. Chain into Select internally so the freshly created character
 *        auto-spawns - the post-Create flow on the client converges with
 *        the post-Select flow on a single event (CharacterSpawned).
 *     4. CharacterCreateSuccess is still emitted for UI bookkeeping
 *        (form reset / log line); the actual spawn rides
 *        CharacterSpawned.
 *
 *   onNet CharacterList:
 *     Require Phase=Authenticated. Project the account's characters
 *     into CharacterSummary[] and reply via CharacterListResponse.
 *
 *   onNet CharacterSelect:
 *     Require Phase=Authenticated. Forge-guarded inside
 *     CharacterService.Select; on success, flip Phase=Spawned, switch
 *     bucket to the world, stamp CharacterID, attach runtime cache,
 *     and emit CharacterSpawned.
 *
 *   PersistAndDetachRuntime (invoked by the PlayerSessionService
 *   playerDropped dispatcher and the mid-session transitions):
 *     Snapshot native-side state (coord / heading / HP / AP / world)
 *     synchronously while the player entity is still resolvable,
 *     combine with the in-memory runtime (IsMasked / Cash / Bank /
 *     InjuryStatus / BleedingStatus), then fire-and-forget the
 *     SaveRuntime UPDATE. The save is skipped if the player never
 *     reached Spawned (or no trustworthy position survives); the
 *     per-Source inventory + bleeding evictions run on every path.
 */
export class CharacterController {
  private readonly Log = Logger.New('Character');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Routing: RoutingBucketService,
    private readonly Characters: CharacterService,
    private readonly Runtimes: CharacterRuntimeService,
    private readonly Validator: PositionValidatorService,
    private readonly CharacterRows: CharacterRepository,
    private readonly Chat: ChatController,
    private readonly Injury: InjuryService,
    private readonly Inventory: InventoryService,
    private readonly Bleeding: BleedingService,
    private readonly PhoneCall: PhoneCallService,
  ) {
    onNet(
      NetEvents.CharacterCreate,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterCreate]): void => {
        const Src = source;
        void this.HandleCreate(Src, Payload).catch((Err: unknown) => {
          this.Log.Error(`HandleCreate failed for source=${Src}`, { Err: String(Err) });
        });
      },
    );

    onNet(NetEvents.CharacterList, (): void => {
      const Src = source;
      void this.HandleList(Src).catch((Err: unknown) => {
        this.Log.Error(`HandleList failed for source=${Src}`, { Err: String(Err) });
      });
    });

    onNet(
      NetEvents.CharacterSelect,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterSelect]): void => {
        const Src = source;
        void this.HandleSelect(Src, Payload).catch((Err: unknown) => {
          this.Log.Error(`HandleSelect failed for source=${Src}`, { Err: String(Err) });
        });
      },
    );

    this.Log.Debug('Handlers registered (CharacterCreate, CharacterList, CharacterSelect)');
  }

  /**
   * Create a character from the wizard submission, then spawn it.
   *
   * Payload arrives over a NUI callback and is re-validated in full by
   * CharacterService - nothing here trusts the client's own bounds
   * checking. Failures come back as CharacterCreateFailure with a
   * player-readable reason so the wizard can be corrected and resubmitted.
   */
  private async HandleCreate(
    Src: number,
    Payload: NetEventPayloads[typeof NetEvents.CharacterCreate],
  ): Promise<void> {
    const PlayerState = this.State.Get(Src);
    if (PlayerState === null || PlayerState.Phase !== 'Authenticated' || PlayerState.AccountID === null) {
      this.Log.Warn(`CharacterCreate rejected: source=${Src} not Authenticated`);
      this.EmitCreateFailure(Src, 'Your session is not ready. Please reconnect.');
      return;
    }

    try {
      const Created = await this.Characters.Create({
        AccountID: PlayerState.AccountID,
        FirstName: Payload.FirstName,
        LastName: Payload.LastName,
        Age: Payload.Age,
        Gender: Payload.Gender,
        BloodType: Payload.BloodType,
        HeightCm: Payload.HeightCm,
        WeightKg: Payload.WeightKg,
        Appearance: Payload.Appearance,
        Outfit: Payload.Outfit,
        CreationIP: SafeEndpoint(Src),
      });

      const CreateReply: NetEventPayloads[typeof NetEvents.CharacterCreateSuccess] = {
        CharacterID: Created.ID,
        SlotID: Created.SlotID,
        FirstName: Created.FirstName,
        LastName: Created.LastName,
      };
      emitNet(NetEvents.CharacterCreateSuccess, Src, CreateReply);

      // Chain straight into Select so the freshly-created character
      // auto-spawns. Re-reads the row to project the canonical spawn
      // payload (same shape the selector returns for an existing pick),
      // which keeps the client-side handler symmetric across the two
      // entry paths.
      await this.SpawnInto(Src, PlayerState.AccountID, Created.ID);
    } catch (Err: unknown) {
      if (Err instanceof CharacterCreateError) {
        this.Log.Info(`CharacterCreate rejected: source=${Src} reason="${Err.Reason}"`);
        this.EmitCreateFailure(Src, Err.Reason);
        return;
      }
      this.Log.Error(`CharacterCreate failed for source=${Src}`, { Err: String(Err) });
      this.EmitCreateFailure(Src, 'Server error creating character. Please try again.');
    }
  }

  /**
   * Send the account's character roster to the selector. Active rows
   * only - deleted characters are filtered in the repository, so the
   * client never learns they existed.
   */
  private async HandleList(Src: number): Promise<void> {
    const PlayerState = this.State.Get(Src);
    if (PlayerState === null || PlayerState.Phase !== 'Authenticated' || PlayerState.AccountID === null) {
      this.Log.Warn(`CharacterList rejected: source=${Src} not Authenticated`);
      return;
    }

    try {
      const Summaries = await this.Characters.ListByAccount(PlayerState.AccountID);
      const Reply: NetEventPayloads[typeof NetEvents.CharacterListResponse] = {
        Characters: Summaries,
      };
      emitNet(NetEvents.CharacterListResponse, Src, Reply);
      this.Log.Debug(`Listed ${Summaries.length} characters for source=${Src}`);
    } catch (Err: unknown) {
      this.Log.Error(`CharacterList failed for source=${Src}`, { Err: String(Err) });
    }
  }

  /**
   * Spawn the chosen character into the world.
   *
   * Ownership is verified server-side: a client that forges someone
   * else's character id is refused, which is why the service raises
   * CharacterSelectError rather than trusting the id to be theirs.
   *
   * On success this attaches the runtime, applies the inventory, moves
   * the player out of their private auth bucket into the shared world,
   * and dresses the ped.
   */
  private async HandleSelect(
    Src: number,
    Payload: NetEventPayloads[typeof NetEvents.CharacterSelect],
  ): Promise<void> {
    const PlayerState = this.State.Get(Src);
    if (PlayerState === null || PlayerState.Phase !== 'Authenticated' || PlayerState.AccountID === null) {
      this.Log.Warn(`CharacterSelect rejected: source=${Src} not Authenticated`);
      this.EmitSelectFailure(Src, 'Your session is not ready. Please reconnect.');
      return;
    }

    // mysql2 returns BIGINT UNSIGNED as a JS number when the value fits in
    // Number's safe-integer range (most account / character IDs in
    // practice). The summary objects we project back to the UI carry
    // those numeric IDs through the JSON pipe untouched, so when the UI
    // POSTs CharacterSelect the inbound CharacterID is a number, not a
    // string. Coerce at the boundary instead of insisting on a strict
    // string type and silently 404-ing the click.
    const Normalised = NormaliseID(Payload.CharacterID);
    if (Normalised === null) {
      this.Log.Warn(`CharacterSelect rejected: source=${Src} bad payload=${String(Payload.CharacterID)}`);
      this.EmitSelectFailure(Src, 'Character not found.');
      return;
    }

    await this.SpawnInto(Src, PlayerState.AccountID, Normalised);
  }

  /**
   * Common spawn path: resolve the character, flip phase + bucket, emit
   * CharacterSpawned. Shared between post-Create auto-spawn and the
   * selector pick.
   */
  private async SpawnInto(Src: number, AccountID: string, CharacterID: string): Promise<void> {
    try {
      const { Payload, Runtime } = await this.Characters.Select(AccountID, CharacterID);
      this.State.SetCharacterID(Src, Payload.CharacterID);
      this.State.SetPhase(Src, 'Spawned');
      this.Routing.MoveToWorld(Src);
      this.Runtimes.Attach(Src, Runtime);
      // Ensure the character's inventory row exists and re-grant any
      // missing IsPermanent items (decision 33). Runs ahead of the
      // injury check so the inventory layer is live by the time
      // /useitem can be invoked.
      await this.Inventory.ApplyOnSpawn(Src, Runtime);
      // Restamp the /acceptdeath wait clock if the character is
      // reconnecting in a non-Healthy state. The replicated state bag
      // is already written by Attach above; the client's
      // AddStateBagChangeHandler picks it up and applies the dead pose
      // + combat lock without anything more from us.
      this.Injury.ApplyOnSpawn(Src, Runtime);
      // Seed the validator with the canonical spawn coord. The 5s grace
      // window baked into Seed absorbs the client's model-load /
      // fade-in delay before the first delta check kicks in.
      this.Validator.Seed(Src, {
        X: Payload.Coord.X,
        Y: Payload.Coord.Y,
        Z: Payload.Coord.Z,
        Heading: Payload.Heading,
        World: Payload.World,
      });
      emitNet(NetEvents.CharacterSpawned, Src, Payload);
      // Hand the registered command surface to the freshly-spawned client
      // so its chat autocomplete is populated before the player can type.
      this.Chat.PushCommandListToSource(Src);
      // Welcome card lands in chat right after spawn. Fire-and-forget so
      // a slow Account read can't block the spawn-info log line.
      void this.Chat.PushSpawnWelcome(Src, Payload.FirstName, Payload.LastName);
      this.Log.Debug(`Spawned source=${Src} character=${Payload.CharacterID}`);
    } catch (Err: unknown) {
      if (Err instanceof CharacterSelectError) {
        this.Log.Warn(
          `CharacterSelect rejected: source=${Src} account=${AccountID} char=${CharacterID}`,
        );
        this.EmitSelectFailure(Src, Err.Reason);
        return;
      }
      this.Log.Error(`SpawnInto failed for source=${Src}`, { Err: String(Err) });
      this.EmitSelectFailure(Src, 'Server error spawning character. Please try again.');
    }
  }

  /**
   * Snapshot, persist, and detach the runtime for a spawned source.
   *
   *   Position / heading / world: prefer the validator's last-sane
   *   value. The validator's per-tick delta check has been throwing
   *   out any teleport-hack snapshots throughout the session, so the
   *   cached value is the most trustworthy thing we have. Fall back
   *   to a fresh native read only if the validator has no entry
   *   (caller invoked us before any tick fired).
   *
   *   HP / AP: read freshly from natives. These are bounded ints and
   *   we clamp aggressively (Math.max/min + Number.isFinite + Math.floor).
   *
   *   IsMasked / Cash / Bank / InjuryStatus / BleedingStatus: read
   *   from the in-memory runtime cache (server-tracked, never client-
   *   trusted in the first place).
   *
   * Runtime + Validator are detached BEFORE the async write so a
   * subsequent spawn (reconnect / character-switch) on the same Source
   * can't race against a late save. Caller is responsible for any
   * downstream state changes (phase, bucket, etc.).
   */
  PersistAndDetachRuntime(Src: number): void {
    // Decision 21: tear the equipped weapon down first - null the
    // replicated bag and strip the ped's weapons server-side (the
    // weapon natives are apiset-server) before any other detach work.
    // A /changecharacter cannot leak a gun across the switch even if
    // the old client ignores every event from here on.
    this.Inventory.ClearEquippedWeapon(Src);

    // Per-Source inventory + bleeding evictions run unconditionally,
    // NOT behind the early returns below: the cooldown / rate-limit /
    // shot-accounting maps and the bleeding timers are session state
    // that must not leak to the next character on this Source (or the
    // next connection recycling it) just because there was nothing to
    // persist (never spawned, no trustworthy position). The persisted
    // rows are untouched - inventory self-saves on every mutation and
    // the BleedingStatus column rides the SaveRuntime write below.
    // After ClearEquippedWeapon so its bag-mirror write cannot
    // resurrect the just-evicted entry.
    this.Inventory.Evict(Src);
    this.Bleeding.Evict(Src);
    // Tear down any live call (final bill, peer notify) before the runtime
    // detaches. Idempotent - HandleDropped re-runs it after its fence.
    this.PhoneCall.Evict(Src);

    const Runtime = this.Runtimes.Detach(Src);
    if (Runtime === null) {
      // Source never reached Spawned (or already detached). Drop the
      // validator entry if any and bail.
      this.Validator.Detach(Src);
      return;
    }

    const Validated = this.Validator.Detach(Src);
    const SrcStr = String(Src);
    const Ped = GetPlayerPed(SrcStr);

    const Position = this.ResolvePersistedPosition(Src, Ped, Validated);
    if (Position === null) {
      // No trustworthy position available - skip the position-bearing
      // save rather than clobber the row with garbage. Most non-position
      // fields are fine to lose here (Cash / Bank flow through the
      // economy layer; IsMasked / Injury / Bleeding revert to safe
      // defaults). Radio tuning is the exception: it has no safe default,
      // so persist it on its own before bailing.
      void this.CharacterRows
        .SaveRadioState(Runtime.CharacterID, Runtime.RadioState)
        .catch((Err: unknown) => {
          this.Log.Error(`SaveRadioState failed for source=${Src}`, { Err: String(Err) });
        });
      this.Log.Warn(
        `Runtime persist: no trustworthy position for source=${Src} character=${Runtime.CharacterID}; ` +
          'position save skipped (radio tuning persisted)',
      );
      return;
    }

    // HP / AP: native reads with full sanitisation. If the ped is gone
    // they degrade to the model defaults.
    const HP = Ped === 0 ? 100 : ClampHealth(GetEntityHealth(Ped) - 100);
    const AP = Ped === 0 ? 0 : ClampArmour(GetPedArmour(Ped));

    void this.CharacterRows
      .SaveRuntime(Runtime.CharacterID, {
        World: Position.World,
        PositionX: Position.X,
        PositionY: Position.Y,
        PositionZ: Position.Z,
        Heading: Position.Heading,
        HP,
        AP,
        InjuryStatus: Runtime.InjuryStatus,
        BleedingStatus: Runtime.BleedingStatus,
        IsMasked: Runtime.IsMasked,
        Bank: Runtime.Bank,
        RadioState: Runtime.RadioState,
        ActivePhoneSerial: Runtime.ActivePhoneSerial,
      })
      .then(() => {
        this.Log.Debug(
          `Persisted character=${Runtime.CharacterID} source=${Src} at ` +
            `(${Position.X.toFixed(1)}, ${Position.Y.toFixed(1)}, ${Position.Z.toFixed(1)}) ` +
            `world=${Position.World}`,
        );
      })
      .catch((Err: unknown) => {
        this.Log.Error(`SaveRuntime failed for source=${Src}`, { Err: String(Err) });
      });
  }

  /**
   * Pick the position to persist:
   *   1. Validator's last sane value (preferred - vouched-for).
   *   2. Fresh native read, but ONLY if it passes the finite-and-not-
   *      near-origin guards (handles the rare disconnect-before-first-
   *      tick case).
   *   3. null if neither path produces a trustworthy coord.
   */
  private ResolvePersistedPosition(
    Src: number,
    Ped: number,
    Validated: ValidatedPosition | null,
  ): ValidatedPosition | null {
    if (Validated !== null) return Validated;
    if (Ped === 0) return null;

    const Coords = GetEntityCoords(Ped);
    const X = Number(Coords[0]);
    const Y = Number(Coords[1]);
    const Z = Number(Coords[2]);
    if (!Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) return null;
    if (Math.abs(X) < 5 && Math.abs(Y) < 5 && Math.abs(Z) < 5) return null;

    const Heading = Number(GetEntityHeading(Ped));
    const World = Number(GetPlayerRoutingBucket(String(Src)));

    return {
      X,
      Y,
      Z,
      Heading: Number.isFinite(Heading) ? Heading : 0,
      World: Number.isFinite(World) ? World : 0,
    };
  }

  /** Report a creation failure, leaving the wizard's draft intact to fix. */
  private EmitCreateFailure(Src: number, Reason: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.CharacterCreateFailure] = { Reason };
    emitNet(NetEvents.CharacterCreateFailure, Src, Payload);
  }

  /**
   * Report a spawn failure. Clears the selector's in-flight marker so the
   * roster becomes interactive again rather than stuck on "Spawning...".
   */
  private EmitSelectFailure(Src: number, Reason: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.CharacterSelectFailure] = { Reason };
    emitNet(NetEvents.CharacterSelectFailure, Src, Payload);
  }
}

/**
 * Clamp + sanitise an HP value. Accepts the post-subtract-100 GTA player-
 * ped scale (so the caller did GetEntityHealth(ped) - 100). Returns an
 * integer in [0, 100], defaulting to 100 on a non-finite input.
 */
function ClampHealth(Raw: number): number {
  if (!Number.isFinite(Raw)) return 100;
  return Math.max(0, Math.min(100, Math.floor(Raw)));
}

/**
 * Clamp + sanitise armour. Accepts the raw GetPedArmour return (which is
 * 0..100 for unmodded peds; a hack could push higher, hence the cap).
 * Returns an integer in [0, 100], defaulting to 0 on a non-finite input.
 */
function ClampArmour(Raw: number): number {
  if (!Number.isFinite(Raw)) return 0;
  return Math.max(0, Math.min(100, Math.floor(Raw)));
}

/**
 * Coerce an inbound id payload to a canonical positive-integer string.
 * Accepts string ("1") or number (1); rejects empty / non-digit / negative
 * / NaN. Keeps the rest of the service layer free of type-narrowing
 * branches.
 */
function NormaliseID(Raw: unknown): string | null {
  if (typeof Raw === 'string') {
    return /^\d+$/.test(Raw) && Raw !== '0' ? Raw : null;
  }
  if (typeof Raw === 'number' && Number.isInteger(Raw) && Raw > 0) {
    return String(Raw);
  }
  return null;
}

/**
 * Connecting IP with the port stripped, recorded as the character's
 * creation IP. Reads from FXServer rather than the client, and yields
 * null rather than throwing if the player has already dropped.
 */
function SafeEndpoint(Src: number): string | null {
  try {
    const Raw = GetPlayerEndpoint(String(Src));
    if (typeof Raw !== 'string' || Raw.length === 0) return null;
    const ColonIdx = Raw.lastIndexOf(':');
    return ColonIdx === -1 ? Raw : Raw.slice(0, ColonIdx);
  } catch {
    return null;
  }
}
