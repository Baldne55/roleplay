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

declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
declare function GetPlayerEndpoint(PlayerSrc: string): string;
declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetEntityCoords(Entity: number): { x: number; y: number; z: number } & [number, number, number];
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
 *   on playerDropped:
 *     Snapshot native-side state (coord / heading / HP / AP / world)
 *     synchronously while the player entity is still resolvable,
 *     combine with the in-memory runtime (IsMasked / Cash / Bank /
 *     InjuryStatus / BleedingStatus), then fire-and-forget the
 *     SaveRuntime UPDATE. No-op if the player never reached Spawned.
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
  ) {
    onNet(
      NetEvents.CharacterCreate,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterCreate]): void => {
        const Src = source;
        void this.HandleCreate(Src, Payload);
      },
    );

    onNet(NetEvents.CharacterList, (): void => {
      const Src = source;
      void this.HandleList(Src);
    });

    onNet(
      NetEvents.CharacterSelect,
      (Payload: NetEventPayloads[typeof NetEvents.CharacterSelect]): void => {
        const Src = source;
        void this.HandleSelect(Src, Payload);
      },
    );

    on('playerDropped', (): void => {
      const Src = source;
      this.HandleDropped(Src);
    });

    this.Log.Debug(
      'Handlers registered (CharacterCreate, CharacterList, CharacterSelect, playerDropped)',
    );
  }

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
   * playerDropped: snapshot + persist.
   *
   * Thin wrapper around PersistAndDetachRuntime - the same persist path
   * is reused by mid-session transitions (/changecharacter, /logout) so
   * the snapshot logic lives there.
   */
  private HandleDropped(Src: number): void {
    this.PersistAndDetachRuntime(Src);
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
      // No trustworthy position available - skip the save rather than
      // clobber the row with garbage. The non-position fields are not
      // worth persisting in isolation (Cash / Bank flow through the
      // economy layer; IsMasked / Injury / Bleeding revert to defaults
      // at most, which is the smallest harm).
      this.Log.Warn(
        `Runtime persist: no trustworthy position for source=${Src} character=${Runtime.CharacterID}; ` +
          'save skipped',
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
        Cash: Runtime.Cash,
        Bank: Runtime.Bank,
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

  private EmitCreateFailure(Src: number, Reason: string): void {
    const Payload: NetEventPayloads[typeof NetEvents.CharacterCreateFailure] = { Reason };
    emitNet(NetEvents.CharacterCreateFailure, Src, Payload);
  }

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
