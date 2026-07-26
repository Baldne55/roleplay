import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import type { AccountSessionService } from '@/Services/AccountSessionService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { CharacterController } from '@/Controllers/CharacterController.js';
import type { ChatController } from '@/Controllers/ChatController.js';
import type { AnticheatEventController } from '@/Controllers/AnticheatEventController.js';
import type { AnticheatController } from '@/Controllers/AnticheatController.js';
import type { NoClipService } from '@/Services/NoClipService.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';
import type { AnticheatScannerService } from '@/Services/AnticheatScannerService.js';
import type { InjuryService } from '@/Services/InjuryService.js';
import type { BleedingService } from '@/Services/BleedingService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { PrivateMessageStore } from '@/Services/PrivateMessageStore.js';
import type { IQueueService } from '@/Infrastructure/Queue/IQueueService.js';
import type { NametagActionService } from '@/Services/NametagActionService.js';
import type { PhoneCallService } from '@/Services/PhoneCallService.js';
import type { AddictionService } from '@/Services/AddictionService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Mid-session transitions out of a Spawned player.
 *
 *   ReturnToSelect (/changecharacter):
 *     1. Persist + detach runtime via CharacterController (same snapshot
 *        path as playerDropped, so a /changecharacter at the door of an
 *        in-progress save commits the same coord / HP / cash flush).
 *     2. Move the routing bucket back to the per-source auth bucket so
 *        the world stops rendering for this player and vice versa.
 *     3. Clear CharacterID + flip phase back to Authenticated. The
 *        AccountID stays - the account session is still live.
 *     4. Wipe the chat scrollback, notify the client via SessionReturnToSelect.
 *
 *   ReturnToAuth (/logout):
 *     Same teardown as above, plus:
 *     - Phase rewinds to PreAuth instead of Authenticated.
 *     - The AccountSession claim is released so the next AuthFinalize
 *       re-Claims cleanly (and a different account could in principle
 *       finalise on the same Source, though we don't expose that flow).
 *     The AccountID stays on PlayerState - AuthController.HandleFinalize
 *     reads it to re-claim the session when the player clicks Enter
 *     Server again.
 *
 * Phase gate: both methods refuse to act on a Source that isn't Spawned.
 * The command layer also gates with RequireCharacter, but the second
 * check here keeps the service safe to call from any future invoker
 * (admin tool, mass kick, anti-cheat).
 *
 * This service also owns the Backend's single playerDropped
 * registration - see HandleDropped for the eviction order contract.
 */
export class PlayerSessionService {
  private readonly Log = Logger.New('PlayerSession');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Routing: RoutingBucketService,
    private readonly Sessions: AccountSessionService,
    private readonly Chat: ChatService,
    private readonly Character: CharacterController,
    private readonly NoClip: NoClipService,
    private readonly Anticheat: AnticheatService,
    private readonly Injury: InjuryService,
    private readonly Bleeding: BleedingService,
    private readonly Inventory: InventoryService,
    private readonly Scanner: AnticheatScannerService,
    private readonly AnticheatEvents: AnticheatEventController,
    private readonly Monitor: AnticheatController,
    private readonly ChatIO: ChatController,
    private readonly Pms: PrivateMessageStore,
    private readonly Queue: IQueueService,
    private readonly NametagActions: NametagActionService,
    private readonly PhoneCall: PhoneCallService,
    private readonly Addiction: AddictionService,
    private readonly Broadcaster: ProximityBroadcaster,
  ) {
    on('playerDropped', (Reason: string): void => {
      this.HandleDropped(source, Reason);
    });
    this.Log.Debug('Handlers registered (playerDropped -> consolidated teardown dispatcher)');
  }

  /**
   * Take a spawned player back to the character selector
   * (`/changecharacter`).
   *
   * Runs the same teardown as a disconnect - saves the runtime, detaches
   * it, clears state bags, evicts per-Source caches - because the player
   * stays connected and a leftover cache would leak into their next
   * character. Returns false if they were not spawned.
   */
  ReturnToSelect(Source: number): boolean {
    if (!this.AssertSpawned(Source, 'ReturnToSelect')) return false;
    this.ResetSpawnedSideEffects(Source);
    this.Character.PersistAndDetachRuntime(Source);
    this.Routing.MoveToAuth(Source);
    this.State.ClearCharacterID(Source);
    this.State.SetPhase(Source, 'Authenticated');
    this.Chat.Clear(Source);
    const SelectPayload: NetEventPayloads[typeof NetEvents.SessionReturnToSelect] = {};
    emitNet(NetEvents.SessionReturnToSelect, Source, SelectPayload);
    this.Log.Info(`ReturnToSelect source=${Source}`);
    return true;
  }

  /**
   * Take a player back to the auth shell (`/logout`). Same teardown as
   * ReturnToSelect, one step further back - the account session is
   * released too, so the identity gate runs again.
   */
  ReturnToAuth(Source: number): boolean {
    if (!this.AssertSpawned(Source, 'ReturnToAuth')) return false;
    this.ResetSpawnedSideEffects(Source);
    this.Character.PersistAndDetachRuntime(Source);
    this.Routing.MoveToAuth(Source);
    this.State.ClearCharacterID(Source);
    this.State.SetPhase(Source, 'PreAuth');
    this.Sessions.Release(Source);
    this.Chat.Clear(Source);
    const AuthPayload: NetEventPayloads[typeof NetEvents.SessionReturnToAuth] = {};
    emitNet(NetEvents.SessionReturnToAuth, Source, AuthPayload);
    this.Log.Info(`ReturnToAuth source=${Source}`);
    return true;
  }

  /**
   * Consolidated playerDropped teardown - the Backend's single
   * registration for the event. Every service/controller used to
   * self-register its own eviction handler, which left the eviction
   * order to implicit construction order; this dispatcher makes the
   * order explicit and deliberate:
   *
   *   1. Persistence FIRST. Character.PersistAndDetachRuntime snapshots
   *      position / heading / HP / AP / runtime (and detaches the
   *      runtime + validator entry) while the ped is still resolvable.
   *      It is the only step that reads world state, so nothing may run
   *      before it. Fenced in try/catch: under the old per-service
   *      layout a throw here killed only its own handler, and a native
   *      throw must not starve the evictions below.
   *   2. Per-Source session-state evictions. Order-independent among
   *      themselves - each only drops its own maps/timers:
   *        - Bleeding + Inventory: PersistAndDetachRuntime already
   *          evicts both on every path, but it runs inside the
   *          try/catch fence above - a native throw there must not
   *          leak the pending bleeding confirm timer (which would
   *          fire against a recycled netId) or the inventory
   *          cooldown / rate-limit / shot-accounting maps, so both
   *          re-run here as idempotent backstops.
   *        - Injury: cooldown + dead-timestamp maps.
   *        - NoClip: drops only the flight bit. The validator entry
   *          died with the persist detach and the expected-state
   *          ledger dies with Anticheat.Evict - no Resume /
   *          SetExpected runs against the gone client.
   *        - Anticheat / Scanner / AnticheatEvents / Monitor: session
   *          scores + expected state, sweep entries, game-event rate
   *          windows, client-monitor heartbeats.
   *        - ChatIO: rate-limit bucket + command cooldown entries.
   *        - Pms: the /reply last-sender map (account-keyed blocks
   *          survive by design).
   *        - NametagActions: drains the action-float clear timer
   *          (/ame /amy and the item-interaction floats) so a late
   *          fire cannot write a recycled Source's state bag.
   *   3. Connection / identity LAST. Queue.Remove rejects a
   *      still-queued connection, Sessions.Release frees the account
   *      claim for the next join, and State.Clear runs as the final
   *      act - PlayerState is the identity record (Phase / AccountID)
   *      that any earlier step may still consult.
   *
   * The teardown is synchronous end-to-end, so no interval (scanner
   * sweep, injury watchdog, bleeding scheduler) can interleave with a
   * half-evicted Source.
   */
  private HandleDropped(Source: number, Reason: string): void {
    this.Log.Info(`playerDropped source=${Source} reason="${Reason}"`);

    try {
      this.Character.PersistAndDetachRuntime(Source);
    } catch (Err: unknown) {
      this.Log.Error(`Persist-on-drop failed for source=${Source}`, { Err: String(Err) });
    }

    this.Bleeding.Evict(Source);
    this.Inventory.Evict(Source);
    // Live-call teardown: PersistAndDetachRuntime already evicts it, but
    // that runs inside the fence above - re-run here (idempotent) so a
    // native throw cannot strand the peer or leak the billing entry.
    this.PhoneCall.Evict(Source);
    this.Injury.Evict(Source);
    this.NoClip.Evict(Source);
    this.Anticheat.Evict(Source);
    this.Scanner.Evict(Source);
    this.AnticheatEvents.Evict(Source);
    this.Monitor.Evict(Source);
    this.ChatIO.Evict(Source);
    this.Pms.Evict(Source);
    this.Addiction.Evict(Source);
    // Drops the proximity prune sample, so a recycled netId cannot
    // inherit the previous occupant's position and be culled out of a
    // broadcast it was standing in.
    this.Broadcaster.Evict(Source);
    this.NametagActions.OnPlayerDropped(Source);

    this.Queue.Remove(Source);
    this.Sessions.Release(Source);
    this.State.Clear(Source);
  }

  /**
   * Clear the spawned-only cheat-shaped side effects before the player
   * leaves the world: noclip (its validator suspend + sanction) and the
   * accrued anti-cheat session scores / expected-state mirrors. Without
   * this a noclip left on at /changecharacter, or a session score
   * accrued on one character, would carry into the next on the same
   * connection. Runs before the detach so the client still owns its ped.
   */
  private ResetSpawnedSideEffects(Source: number): void {
    this.NoClip.Reset(Source);
    this.Anticheat.ResetSpawnedState(Source);
    // Injury session maps (death-wait clock, cascade cooldown, watchdog
    // debounce) are per-Source, and the Source id survives a character
    // switch - without this they would leak to the next character on
    // this connection (a stale wait clock could skip /acceptdeath's
    // timer; a stale cooldown could suppress the next character's first
    // knockdown). The disconnect path evicts Injury in HandleDropped;
    // this covers /changecharacter + /logout, matching Inventory /
    // Bleeding eviction on the same teardown.
    this.Injury.Evict(Source);
    // Same reasoning for the withdrawal sweep's per-Source bookkeeping:
    // its own lazy eviction only fires once PlayerState goes null, which
    // a character switch never does, so the next character would inherit
    // the previous one's symptom spacing.
    this.Addiction.Evict(Source);
  }

  /**
   * Guard for the transition methods: true when the player is spawned,
   * else log the refused operation and return false.
   */
  private AssertSpawned(Source: number, Op: string): boolean {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned') {
      this.Log.Warn(`${Op} rejected: source=${Source} not Spawned`);
      return false;
    }
    return true;
  }
}
