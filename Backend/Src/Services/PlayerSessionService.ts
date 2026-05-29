import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import type { AccountSessionService } from '@/Services/AccountSessionService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { CharacterController } from '@/Controllers/CharacterController.js';

declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;

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
 */
export class PlayerSessionService {
  private readonly Log = Logger.New('PlayerSession');

  constructor(
    private readonly State: PlayerStateService,
    private readonly Routing: RoutingBucketService,
    private readonly Sessions: AccountSessionService,
    private readonly Chat: ChatService,
    private readonly Character: CharacterController,
  ) {}

  ReturnToSelect(Source: number): boolean {
    if (!this.AssertSpawned(Source, 'ReturnToSelect')) return false;
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

  ReturnToAuth(Source: number): boolean {
    if (!this.AssertSpawned(Source, 'ReturnToAuth')) return false;
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

  private AssertSpawned(Source: number, Op: string): boolean {
    const PlayerState = this.State.Get(Source);
    if (PlayerState === null || PlayerState.Phase !== 'Spawned') {
      this.Log.Warn(`${Op} rejected: source=${Source} not Spawned`);
      return false;
    }
    return true;
  }
}
