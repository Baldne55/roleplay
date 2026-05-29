import type { Account } from '@/Data/Models/Account.js';
import { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import { Logger } from '@/Util/Logger.js';
import { PlayerStateService, type PlayerState } from '@/Services/PlayerStateService.js';
import { StaffMeets } from '@/Services/StaffLevelRanking.js';
import type {
  CommandContext,
  CommandDefinition,
  CommandInput,
  CommandResult,
} from '@/Services/CommandTypes.js';

/**
 * Central command registry and dispatcher.
 *
 * Lifecycle:
 *   - Constructed once at boot with PlayerStateService + AccountRepository.
 *   - Each cluster module calls Registry.Add(...) from its Register(Registry)
 *     entry point during Bootstrap.
 *   - Dispatch(Source, RawInput) is invoked by the input layer (chat, when
 *     it lands; nothing yet in this slice).
 *
 * Source is treated as forge-proof - it's the FXServer netId from the
 * connection, not the message body. Everything else the dispatcher reads
 * (PlayerState, Account row) is loaded from authoritative server state.
 */
export class CommandRegistry {
  private readonly Log = Logger.New('CommandRegistry');
  /** Lowercased Name -> Definition. */
  private readonly Commands = new Map<string, CommandDefinition>();
  /** Lowercased Alias -> Canonical Name. */
  private readonly Aliases = new Map<string, string>();
  /** `${Source}:${Name}` -> expiry epoch ms. */
  private readonly Cooldowns = new Map<string, number>();

  constructor(
    private readonly State: PlayerStateService,
    private readonly Accounts: AccountRepository,
  ) {}

  /**
   * Register a command. Throws on name / alias collision so boot fails
   * loud rather than silently dropping a definition.
   */
  Add(Input: CommandInput): void {
    const Name = Input.Name.toLowerCase();
    if (this.Commands.has(Name)) {
      throw new Error(`Command name collision: '${Name}' already registered`);
    }
    if (this.Aliases.has(Name)) {
      throw new Error(
        `Command name '${Name}' collides with existing alias for '${this.Aliases.get(Name) ?? ''}'`,
      );
    }

    const SeenAliases = new Set<string>();
    const Aliases: string[] = [];
    for (const Raw of Input.Aliases ?? []) {
      const Alias = Raw.toLowerCase();
      if (Alias === Name) continue;
      if (SeenAliases.has(Alias)) continue;
      if (this.Commands.has(Alias)) {
        throw new Error(
          `Command alias '${Alias}' for '${Name}' collides with existing command`,
        );
      }
      if (this.Aliases.has(Alias)) {
        throw new Error(
          `Command alias '${Alias}' for '${Name}' collides with existing alias for '${this.Aliases.get(Alias) ?? ''}'`,
        );
      }
      SeenAliases.add(Alias);
      Aliases.push(Alias);
    }

    const Definition: CommandDefinition = {
      Name,
      Aliases,
      Description: Input.Description ?? '',
      Params: Input.Params ?? '',
      Category: Input.Category,
      RequiredStaffLevel: Input.RequiredStaffLevel ?? null,
      RequireCharacter: Input.RequireCharacter ?? false,
      SkipDutyCheck: Input.SkipDutyCheck ?? false,
      CooldownMs: Input.CooldownMs ?? null,
      BeforeRun: Input.BeforeRun ?? null,
      Run: Input.Run,
    };

    this.Commands.set(Name, Definition);
    for (const Alias of Aliases) this.Aliases.set(Alias, Name);
  }

  /** All registered definitions, in insertion order. */
  GetAll(): CommandDefinition[] {
    return Array.from(this.Commands.values());
  }

  /** Resolve by name or alias; case-insensitive. */
  GetByName(Name: string): CommandDefinition | null {
    const Key = Name.toLowerCase();
    const Direct = this.Commands.get(Key);
    if (Direct !== undefined) return Direct;
    const Canonical = this.Aliases.get(Key);
    if (Canonical === undefined) return null;
    return this.Commands.get(Canonical) ?? null;
  }

  /** Size of the registry. Boot logs this for sanity. */
  get Size(): number {
    return this.Commands.size;
  }

  /**
   * Parse `RawInput` (with or without a leading '/') and run the command.
   * Returns the typed outcome; the caller renders it to the player.
   */
  async Dispatch(Source: number, RawInput: string): Promise<CommandResult> {
    const Trimmed = RawInput.trim().replace(/^\/+/, '');
    if (Trimmed.length === 0) {
      return { Outcome: 'UnknownCommand', Name: '' };
    }
    const Tokens = Trimmed.split(/\s+/);
    const Name = (Tokens[0] ?? '').toLowerCase();
    const Args = Tokens.slice(1);

    const Definition = this.GetByName(Name);
    if (Definition === null) {
      return { Outcome: 'UnknownCommand', Name };
    }

    const PlayerState = this.State.Get(Source);
    if (PlayerState === null) {
      return { Outcome: 'PermissionDenied' };
    }

    if (Definition.RequireCharacter && PlayerState.CharacterID === null) {
      return { Outcome: 'RequiresCharacter' };
    }

    let Account: Account | null = null;
    if (Definition.RequiredStaffLevel !== null) {
      const PermissionOutcome = await this.CheckStaffPermission(Definition, PlayerState);
      if (PermissionOutcome.Outcome !== 'Ok') return PermissionOutcome;
      Account = PermissionOutcome.Account;
    }

    const CooldownKey = `${Source}:${Definition.Name}`;
    if (Definition.CooldownMs !== null) {
      const Expiry = this.Cooldowns.get(CooldownKey);
      if (Expiry !== undefined && Expiry > Date.now()) {
        return { Outcome: 'OnCooldown', RemainingMs: Expiry - Date.now() };
      }
    }

    const Context: CommandContext = {
      Source,
      PlayerState,
      Account,
      Args,
      RawInput,
    };

    if (Definition.BeforeRun !== null) {
      const Pre = await Definition.BeforeRun(Context);
      if (!Pre.Ok) return { Outcome: 'BadArgs', Reason: Pre.Reason };
    }

    let Result: CommandResult;
    try {
      Result = await Definition.Run(Context);
    } catch (Err: unknown) {
      const Reason = Err instanceof Error ? Err.message : String(Err);
      this.Log.Error(`Handler threw - command=${Definition.Name} source=${Source}`, {
        Reason,
      });
      return { Outcome: 'HandlerError', Reason };
    }

    if (Result.Outcome === 'Ok' && Definition.CooldownMs !== null) {
      this.Cooldowns.set(CooldownKey, Date.now() + Definition.CooldownMs);
    }

    return Result;
  }

  /**
   * Per-Source eviction. Hook on playerDropped so cooldown keys for a
   * disconnected source don't linger across reconnects on the same Source.
   */
  Evict(Source: number): void {
    const Prefix = `${Source}:`;
    for (const Key of this.Cooldowns.keys()) {
      if (Key.startsWith(Prefix)) this.Cooldowns.delete(Key);
    }
  }

  private async CheckStaffPermission(
    Definition: CommandDefinition,
    PlayerState: PlayerState,
  ): Promise<
    | { Outcome: 'Ok'; Account: Account }
    | { Outcome: 'PermissionDenied' }
    | { Outcome: 'NotOnDuty' }
  > {
    if (PlayerState.AccountID === null) return { Outcome: 'PermissionDenied' };
    const Account = await this.Accounts.FindByID(PlayerState.AccountID);
    if (Account === null) return { Outcome: 'PermissionDenied' };
    if (Definition.RequiredStaffLevel === null) return { Outcome: 'Ok', Account };
    if (!StaffMeets(Account.StaffLevel, Definition.RequiredStaffLevel)) {
      return { Outcome: 'PermissionDenied' };
    }
    if (!Definition.SkipDutyCheck && !PlayerState.AdminDuty) {
      return { Outcome: 'NotOnDuty' };
    }
    return { Outcome: 'Ok', Account };
  }
}
