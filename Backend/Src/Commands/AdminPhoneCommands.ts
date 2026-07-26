import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import { FormatCashCents, ParseDollarsToCents } from '@Shared/Constants/Inventory.js';
import { IsValidPhoneNumber, MaxPhoneCreditsCents } from '@Shared/Constants/Phone.js';
import type { StaffLevel } from '@/Data/Models/Account.js';
import { StaffMeets } from '@/Services/StaffLevelRanking.js';
import type { CommandContext, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PhoneService } from '@/Services/PhoneService.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';

/**
 * Admin phone cluster. Single `/aphone` parent dispatcher; bare `/aphone`
 * lists the subcommands with their required tier. The parent gate is the
 * lowest tier with any access (Moderator); each subcommand re-checks the
 * actor's tier via StaffMeets and refuses if insufficient.
 *
 *   - Moderator      find        (read-only number lookup)
 *   - Administrator  credits     (grants value)
 */

/**
 * A `/aphone` subcommand body. Receives the args AFTER the subcommand
 * name (so `find` sees `['555-0100']`, not `['find', '555-0100']`) and
 * is only ever invoked once the dispatcher has confirmed the actor's
 * tier - handlers do not re-check permission.
 */
type AdminSubHandler = (Ctx: CommandContext, SubArgs: string[]) => Promise<CommandResult>;

/**
 * One `/aphone` subcommand, carrying its own tier gate. Same shape as the
 * `/aitem` table - the two clusters are intentionally parallel so an
 * admin's mental model transfers.
 */
interface AdminSubCommand {
  readonly Name: string;
  readonly Params: string;
  readonly Description: string;
  readonly RequiredStaffLevel: StaffLevel;
  readonly Handler: AdminSubHandler;
}

/** Wire the `/aphone` dispatcher and its subcommand table. */
export function Register(
  Registry: CommandRegistry,
  Phone: PhoneService,
  Inventory: InventoryService,
  State: PlayerStateService,
  Characters: CharacterRepository,
): void {
  const Subs: AdminSubCommand[] = [
    {
      Name: 'find',
      Params: '<number>',
      Description: 'Show which character holds a phone number.',
      RequiredStaffLevel: 'Moderator',
      Handler: (Ctx, Sub) => HandleFind(Inventory, State, Characters, Ctx, Sub),
    },
    {
      Name: 'credits',
      Params: '<player_id> <dollars>',
      Description: "Top up a player's active phone balance.",
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx, Sub) => HandleCredits(Phone, State, Ctx, Sub),
    },
  ];

  Registry.Add({
    Name: 'aphone',
    Description: 'Admin phone actions. Type /aphone with no arguments to list every subcommand.',
    Params: '<subcommand> [...]',
    Category: 'Admin',
    RequiredStaffLevel: 'Moderator',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      const Sub = (Ctx.Args[0] ?? '').toLowerCase();
      const ActorLevel = Ctx.Account?.StaffLevel ?? 'None';
      if (Sub === '' || Sub === 'help' || Sub === '?') {
        return { Outcome: 'Ok', Reply: RenderAdminHelp(Subs, ActorLevel) };
      }
      const Found = Subs.find((S) => S.Name === Sub);
      if (Found === undefined) {
        return {
          Outcome: 'BadArgs',
          Reason: `Unknown subcommand "${Sub}". Type /aphone for the full list.`,
        };
      }
      if (!StaffMeets(ActorLevel, Found.RequiredStaffLevel)) {
        return { Outcome: 'PermissionDenied' };
      }
      return Found.Handler(Ctx, Ctx.Args.slice(1));
    },
  });
}

/**
 * Render the `/aphone` index, marking entries above the actor's tier as
 * `(locked)` rather than hiding them - same disclosure rule as `/aitem`.
 */
function RenderAdminHelp(Subs: readonly AdminSubCommand[], ActorLevel: StaffLevel): string {
  const Lines: string[] = [ChatFormatter.Header('/aphone commands', ChatColor.Header)];
  for (const Sub of Subs) {
    const Gate = StaffMeets(ActorLevel, Sub.RequiredStaffLevel) ? '' : ' (locked)';
    const Sig = Sub.Params.length > 0 ? `/aphone ${Sub.Name} ${Sub.Params}` : `/aphone ${Sub.Name}`;
    Lines.push(`${Sig} - ${Sub.Description}${Gate}`);
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Report which character currently holds a phone number (Moderator,
 * read-only).
 *
 * A phone number IS the handset's serial, so this walks item rows rather
 * than any subscriber table - which means it follows the physical phone
 * through trades, drops and thefts. Also reports whether the holder is
 * online, since the usual next step is talking to them.
 */
async function HandleFind(
  Inventory: InventoryService,
  State: PlayerStateService,
  Characters: CharacterRepository,
  _Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Number = Sub[0];
  if (Number === undefined || !IsValidPhoneNumber(Number)) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aphone find <555-number>' };
  }
  const HolderCharacter = await Inventory.ResolveCharacterForSerial(Number);
  if (HolderCharacter === null) {
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info(`No character is holding ${Number} (it may be on the ground or unknown).`),
    };
  }
  const Row = await Characters.FindByID(HolderCharacter);
  const Name = Row !== null ? `${Row.FirstName} ${Row.LastName}` : 'Unknown';
  const OnlineSource = FindOnlineSource(State, HolderCharacter);
  const Presence = OnlineSource !== null ? `online as player ${OnlineSource}` : 'offline';
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(
      `${Number} is held by ${Name} (character #${HolderCharacter}, ${Presence}).`,
    ),
  };
}

/**
 * Top up a player's active phone balance (Administrator - this creates
 * value).
 *
 * Targets the player's *active* phone rather than taking a number, so a
 * player carrying several phones with none selected is refused instead of
 * having the credit land on an arbitrary one. Amounts are dollars, capped
 * at MaxPhoneCreditsCents to make a mistyped top-up a rejection rather
 * than an economy incident.
 */
async function HandleCredits(
  Phone: PhoneService,
  State: PlayerStateService,
  _Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const AmountArg = Sub[1];
  if (!Number.isInteger(Target) || AmountArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aphone credits <player_id> <dollars>' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const Cents = ParseDollarsToCents(AmountArg);
  if (Cents === null || Cents <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Amount must be a positive dollar value (up to two decimals).' };
  }
  if (Cents > MaxPhoneCreditsCents) {
    return { Outcome: 'BadArgs', Reason: `That top-up amount is too large (maximum ${FormatCashCents(MaxPhoneCreditsCents)}).` };
  }
  const ActiveNumber = await Phone.ResolveActiveNumber(Target);
  if (ActiveNumber === null) {
    return {
      Outcome: 'BadArgs',
      Reason: `Player ${Target} has no usable active phone (none carried, or several with none chosen).`,
    };
  }
  const NewBalance = await Phone.GrantCredits(ActiveNumber, Cents);
  if (NewBalance === null) {
    return { Outcome: 'BadArgs', Reason: 'Could not top up that phone.' };
  }
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(
      `Added ${FormatCashCents(Cents)} to ${ActiveNumber}; balance is now ${FormatCashCents(NewBalance)}.`,
    ),
  };
}

/**
 * Reverse-resolve a character id to a live server id, or null when that
 * character is not currently spawned.
 *
 * Linear scan over spawned players - fine at this scale and only reached
 * from an admin lookup, never a hot path. Used so `/aphone find` can
 * report whether the holder is reachable right now.
 */
function FindOnlineSource(State: PlayerStateService, CharacterID: string): number | null {
  for (const Source of State.GetSpawnedSources()) {
    if (State.Get(Source)?.CharacterID === CharacterID) return Source;
  }
  return null;
}
