import { ChatColor, ChatFormatter, ChatVerbs } from '@Shared/Chat/Index.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import { Logger } from '@/Util/Logger.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import { AssertHealthy, ChainBeforeRun } from '@/Commands/Shared/AssertHealthy.js';

declare function GetPlayerPed(PlayerSrc: string): number;
declare function GetVehiclePedIsIn(Ped: number, LastVehicle: boolean): number;

/**
 * Vehicle-channel chat commands. /cb and /cw filter by shared FXServer
 * vehicle handle: each candidate's ped is resolved server-side and its
 * current vehicle compared against the sender's, so passenger membership
 * is decided by the engine rather than by proximity or routing tricks.
 * Both commands gracefully decline outside a vehicle. /cb reuses the /b
 * OOC grey-bracket wrap; /cw reuses the /whisper pale orange full-line
 * tint - the OOC vs whisper split mirrors lc-rp / ragemp conventions.
 */
export function Register(
  Registry: CommandRegistry,
  Chat: ChatService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
): void {
  const Log = Logger.New('VehicleChat');

  Registry.Add({
    Name: 'cb',
    Description: 'Speak out-of-character to vehicle passengers.',
    Params: '<message>',
    Category: 'Chat',
    RequireCharacter: true,
    BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody('cb')),
    Run: (Ctx): CommandResult => {
      const SenderVehicle = GetSenderVehicle(Ctx.Source);
      if (SenderVehicle === 0) {
        return { Outcome: 'BadArgs', Reason: 'You must be in a vehicle to use this command.' };
      }
      const Body = Ctx.Args.join(' ').trim();
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Line = ChatFormatter.LocalOoc(DisplayName, Body);
      const Reached = BroadcastToVehicle(State, Chat, SenderVehicle, Line);
      Log.Debug(`/cb source=${Ctx.Source} vehicle=${SenderVehicle} reached=${Reached}`);
      return { Outcome: 'Ok' };
    },
  });

  Registry.Add({
    Name: 'cw',
    Description: 'Whisper to vehicle passengers.',
    Params: '<message>',
    Category: 'Chat',
    RequireCharacter: true,
    BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody('cw')),
    Run: (Ctx): CommandResult => {
      const SenderVehicle = GetSenderVehicle(Ctx.Source);
      if (SenderVehicle === 0) {
        return { Outcome: 'BadArgs', Reason: 'You must be in a vehicle to use this command.' };
      }
      const Body = Ctx.Args.join(' ').trim();
      const DisplayName = Broadcaster.DisplayName(Ctx.Source) ?? 'Someone';
      const Line = ChatFormatter.ApplyChannelTint(
        `${DisplayName} ${ChatVerbs.Whisper}: ${Body}`,
        'Whisper',
      );
      const Reached = BroadcastToVehicle(State, Chat, SenderVehicle, Line);
      Log.Debug(`/cw source=${Ctx.Source} vehicle=${SenderVehicle} reached=${Reached}`);
      return { Outcome: 'Ok' };
    },
  });

  // Reference the imported ChatColor so a future palette tweak keeps the
  // import hot without polluting the runtime behaviour.
  void ChatColor;
}

/**
 * BeforeRun guard mirroring the SpeechCommands helper: reject empty
 * trimmed bodies with a Usage hint so Run handlers can assume the
 * joined Args are non-empty.
 */
function AssertNonEmptyBody(Name: string): CommandBeforeRun {
  return (Ctx) => {
    if (Ctx.Args.join(' ').trim().length === 0) {
      return { Ok: false, Reason: `Usage: /${Name} <message>` };
    }
    return { Ok: true };
  };
}

/**
 * Resolve the sender's current vehicle handle via the two server-side
 * natives. Wrapped in try/catch so a missing ped (player still loading,
 * or detached mid-flow) returns 0 instead of crashing the dispatcher.
 */
function GetSenderVehicle(Source: number): number {
  try {
    const Ped = GetPlayerPed(String(Source));
    if (Ped === 0) return 0;
    const Vehicle = GetVehiclePedIsIn(Ped, false);
    return Number.isFinite(Vehicle) ? Number(Vehicle) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fan `Line` out to every Spawned source whose ped is currently in
 * `SenderVehicle`. Each candidate's natives are guarded individually so
 * a single ped resolution failure does not skip the remaining seats.
 * Returns the receiver count (sender included when seated).
 */
function BroadcastToVehicle(
  State: PlayerStateService,
  Chat: ChatService,
  SenderVehicle: number,
  Line: string,
): number {
  let Count = 0;
  for (const Source of State.GetSpawnedSources()) {
    let Vehicle = 0;
    try {
      const Ped = GetPlayerPed(String(Source));
      if (Ped === 0) continue;
      Vehicle = GetVehiclePedIsIn(Ped, false);
    } catch {
      continue;
    }
    if (Vehicle !== SenderVehicle) continue;
    Chat.SendTo(Source, Line);
    Count += 1;
  }
  return Count;
}
