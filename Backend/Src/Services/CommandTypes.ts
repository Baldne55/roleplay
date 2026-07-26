import type { Account, StaffLevel } from '@/Data/Models/Account.js';
import type { PlayerState } from '@/Services/PlayerStateService.js';
import type { CommandCategory } from '@Shared/Chat/Index.js';

export type { CommandCategory };

/**
 * What every command handler sees at call time. Source is forge-proof
 * (FXServer sets it from the connection, not from any payload). Account
 * is loaded only when the definition declares a RequiredStaffLevel -
 * otherwise null, so handlers that need account data must declare a
 * staff gate (even RequiredStaffLevel='None' is enough to load it).
 */
export interface CommandContext {
  Source: number;
  PlayerState: PlayerState;
  Account: Account | null;
  Args: string[];
  RawInput: string;
}

/**
 * Discriminated outcome union. Handlers return CommandResult; the
 * dispatcher returns CommandResult; the caller (chat, later) renders
 * per outcome. Errors are NOT thrown - throws are caught and converted
 * to 'HandlerError'.
 */
export type CommandResult =
  | { Outcome: 'Ok'; Reply?: string }
  | { Outcome: 'UnknownCommand'; Name: string }
  | { Outcome: 'PermissionDenied' }
  | { Outcome: 'NotOnDuty' }
  | { Outcome: 'RequiresCharacter' }
  | { Outcome: 'OnCooldown'; RemainingMs: number }
  | { Outcome: 'BadArgs'; Reason: string }
  | { Outcome: 'HandlerError'; Reason: string };

/**
 * BeforeRun guard. Returns Ok=true to proceed to Run, or Ok=false with
 * a Reason to short-circuit as BadArgs. Lc-rp's BeforeRun returned
 * null/false; this is the typed TS shape.
 */
export type CommandBeforeRunOutcome = { Ok: true } | { Ok: false; Reason: string };
/**
 * Pre-execution guard. Returning `{Ok:false}` refuses the command with a
 * reason and the Run handler never fires, so handlers may assume their
 * preconditions already hold. May be async - guards that hit the database
 * (staff checks, character lookups) are ordinary.
 */
export type CommandBeforeRun = (
  Context: CommandContext,
) => CommandBeforeRunOutcome | Promise<CommandBeforeRunOutcome>;

/**
 * Run handler. Returns CommandResult; the dispatcher does not interpret
 * anything other than the Outcome - cooldown is stamped only on 'Ok'.
 */
export type CommandHandler = (
  Context: CommandContext,
) => CommandResult | Promise<CommandResult>;

/**
 * The data shape an author writes when adding a command. Normalised
 * into a CommandDefinition by Registry.Add.
 */
export interface CommandInput {
  Name: string;
  Aliases?: readonly string[];
  Description?: string;
  Params?: string;
  Category: CommandCategory;
  RequiredStaffLevel?: StaffLevel;
  RequireCharacter?: boolean;
  /** Skip the admin-on-duty step. Use on /aduty and /admins so duty
   * itself can be toggled / inspected without already being on. */
  SkipDutyCheck?: boolean;
  CooldownMs?: number;
  BeforeRun?: CommandBeforeRun;
  Run: CommandHandler;
}

/**
 * Frozen, dispatcher-internal view of a command. Differs from
 * CommandInput in that Name is lowercased, Aliases are lowercased +
 * deduped, and all the optional toggles have explicit defaults.
 */
export interface CommandDefinition {
  Name: string;
  Aliases: readonly string[];
  Description: string;
  Params: string;
  Category: CommandCategory;
  RequiredStaffLevel: StaffLevel | null;
  RequireCharacter: boolean;
  SkipDutyCheck: boolean;
  CooldownMs: number | null;
  BeforeRun: CommandBeforeRun | null;
  Run: CommandHandler;
}
