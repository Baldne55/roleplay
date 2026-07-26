import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import {
  FormatCashCents,
  FormatWeightGrams,
  ParseDollarsToCents,
} from '@Shared/Constants/Inventory.js';
import { CurrencyCents, GetItemType, ListItemTypeIDs } from '@Shared/Constants/ItemTypes.js';
import type { StaffLevel } from '@/Data/Models/Account.js';
import { StaffMeets } from '@/Services/StaffLevelRanking.js';
import type { CommandContext, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { CatalogAuditResult, InventoryService } from '@/Services/InventoryService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { CashService } from '@/Services/CashService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { InventoryRepository } from '@/Data/Repositories/InventoryRepository.js';
import type { InventoryMutationLogRepository } from '@/Data/Repositories/InventoryMutationLogRepository.js';
import type { WeaponDischargeLogRepository } from '@/Data/Repositories/WeaponDischargeLogRepository.js';
import type { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import type { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import type { InventoryItem } from '@/Data/Models/InventoryItem.js';
import type { InventoryMutationLog } from '@/Data/Models/InventoryMutationLog.js';
import type { WeaponDischargeLog } from '@/Data/Models/WeaponDischargeLog.js';

/**
 * Admin inventory cluster. Single `/aitem` parent dispatcher; bare
 * `/aitem` prints the grouped subcommand list with descriptions and
 * required staff tier. Per-subcommand gates enforce blast-radius split:
 *
 *   - Founder       give, create, cleanlog        (creates value / retention)
 *   - Administrator remove, extend, removeserial, setholder, cleardrops,
 *                   testcatalog                    (mutates existing rows / ped state)
 *   - Moderator     list, find, history, trace, traceweapon, lastfired,
 *                   requests, approve, deny
 *                                                  (read-only audit)
 *
 * The parent gate is Moderator (lowest tier with any access); the per-
 * subcommand handler re-checks against the actor's actual tier via
 * StaffMeets and refuses if insufficient.
 */

/**
 * An `/aitem` subcommand body. Receives the args after the subcommand
 * name, and is only reached once the dispatcher has confirmed the actor
 * meets that entry's RequiredStaffLevel - so a handler never re-checks
 * permission, and must not be called from anywhere that skips the gate.
 */
type AdminSubHandler = (Ctx: CommandContext, SubArgs: string[]) => Promise<CommandResult>;

/**
 * One `/aitem` subcommand and the tier required to run it.
 *
 * The gate lives on the entry rather than in the handler so the same
 * value drives both enforcement and the `(locked)` markers in the help
 * listing - the two can never disagree about what a tier may do.
 */
interface AdminSubCommand {
  readonly Name: string;
  readonly Params: string;
  readonly Description: string;
  readonly RequiredStaffLevel: StaffLevel;
  readonly Handler: AdminSubHandler;
}

/**
 * Wire the `/aitem` dispatcher and its subcommand table.
 *
 * The parent command is gated at Moderator, the lowest tier with any
 * access; each handler re-checks the actor against its own
 * RequiredStaffLevel. Both checks are needed - the parent gate keeps the
 * command out of an ordinary player's help listing, and the per-handler
 * check is what actually authorises the action.
 */
export function Register(
  Registry: CommandRegistry,
  Inventory: InventoryService,
  Cash: CashService,
  State: PlayerStateService,
  InventoryRepo: InventoryRepository,
  MutationLog: InventoryMutationLogRepository,
  DischargeLog: WeaponDischargeLogRepository,
  Accounts: AccountRepository,
  Characters: CharacterRepository,
  Chat: ChatService,
): void {
  const Subs: AdminSubCommand[] = [
    // ── Founder ─────────────────────────────────────────────────────
    {
      Name: 'give',
      Params: '<player_id> <type_id> [amount]',
      Description: 'Grant an item to a player. Cash takes dollars; other types take a unit count.',
      RequiredStaffLevel: 'Founder',
      Handler: (Ctx, Sub) => HandleGive(Inventory, State, Ctx, Sub),
    },
    {
      Name: 'create',
      Params: '<player_id> <type_id> [metadata_json]',
      Description: 'Create a single item with explicit metadata JSON.',
      RequiredStaffLevel: 'Founder',
      Handler: (Ctx, Sub) => HandleCreate(Inventory, State, Ctx, Sub),
    },
    {
      Name: 'cleanlog',
      Params: '<days>',
      Description: 'Delete inventory log rows older than N days.',
      RequiredStaffLevel: 'Founder',
      Handler: (_Ctx, Sub) => HandleCleanLog(MutationLog, Sub),
    },

    // ── Administrator ──────────────────────────────────────────────
    {
      Name: 'remove',
      Params: '<player_id> <slot> [amount]',
      Description: 'Remove a quantity from a player slot. Cash takes dollars.',
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx, Sub) => HandleRemove(Inventory, State, Ctx, Sub),
    },
    {
      Name: 'extend',
      Params: '<player_id> slots|weight <value>',
      Description: "Raise a player's slot count or weight cap.",
      RequiredStaffLevel: 'Administrator',
      Handler: (_Ctx, Sub) => HandleExtend(Inventory, InventoryRepo, State, Sub),
    },
    {
      Name: 'removeserial',
      Params: '<player_id> <slot>',
      Description: 'Strip the unique serial from an item.',
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx, Sub) => HandleRemoveSerial(Inventory, State, Ctx, Sub),
    },
    {
      Name: 'setholder',
      Params: '<player_id> <slot> <new_holder_character_id>',
      Description: "Set a bound item's holder to another character.",
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx, Sub) => HandleSetHolder(Inventory, State, Ctx, Sub),
    },
    {
      Name: 'cleardrops',
      Params: '<radius_meters>',
      Description: 'Sweep all ground drops within a radius from your ped.',
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx, Sub) => HandleClearDrops(Inventory, Ctx, Sub),
    },
    {
      Name: 'testcatalog',
      Params: '',
      Description:
        'Sweep the weapon catalog through the engine on your client and report anything it rejects.',
      RequiredStaffLevel: 'Administrator',
      Handler: (Ctx) => Promise.resolve(HandleTestCatalog(Inventory, Chat, Ctx)),
    },

    // ── Moderator (read-only audit + queue) ────────────────────────
    {
      Name: 'list',
      Params: '<player_id>',
      Description: "List a player's inventory contents (admin view).",
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleList(Inventory, Cash, State, Sub),
    },
    {
      Name: 'find',
      Params: '<serial>',
      Description: 'Find an item row by serial.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleFind(InventoryRepo, Characters, Sub),
    },
    {
      Name: 'history',
      Params: '<serial>',
      Description: 'Show the mutation log for a serial.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleHistory(MutationLog, Sub),
    },
    {
      Name: 'trace',
      Params: '<transaction_id>',
      Description: 'Show every mutation row sharing a transaction ID.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleTrace(MutationLog, Sub),
    },
    {
      Name: 'traceweapon',
      Params: '<serial>',
      Description: 'List every recorded discharge for a weapon serial.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleTraceWeapon(DischargeLog, Sub),
    },
    {
      Name: 'lastfired',
      Params: '<character_id>',
      Description: 'List the last 10 weapons a character has fired.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleLastFired(DischargeLog, Sub),
    },
    {
      Name: 'requests',
      Params: '[page]',
      Description: 'List pending custom name, description, and deface requests.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleRequests(Inventory, Sub),
    },
    {
      Name: 'approve',
      Params: '<request_id>',
      Description: 'Approve a pending name, description, or deface request.',
      RequiredStaffLevel: 'Moderator',
      Handler: (Ctx, Sub) => HandleApprove(Inventory, Ctx, Sub),
    },
    {
      Name: 'deny',
      Params: '<request_id> [reason]',
      Description: 'Deny a pending name, description, or deface request.',
      RequiredStaffLevel: 'Moderator',
      Handler: (_Ctx, Sub) => HandleDeny(Inventory, Sub),
    },
  ];

  Registry.Add({
    Name: 'aitem',
    Description: 'Admin inventory actions. Type /aitem with no arguments to list every subcommand.',
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
          Reason: `Unknown subcommand "${Sub}". Type /aitem for the full list.`,
        };
      }
      if (!StaffMeets(ActorLevel, Found.RequiredStaffLevel)) {
        return { Outcome: 'PermissionDenied' };
      }
      return Found.Handler(Ctx, Ctx.Args.slice(1));
    },
  });

  void Accounts;
}

// ── Help renderer ──────────────────────────────────────────────────────

/**
 * Render the grouped `/aitem` index, tier by tier.
 *
 * Subcommands above the actor's tier are listed but marked `(locked)`
 * rather than hidden. Concealing them would leave a junior admin unable
 * to discover that an escalation path exists at all - the command names
 * are not secret, only the authority to run them is.
 */
function RenderAdminHelp(Subs: readonly AdminSubCommand[], ActorLevel: StaffLevel): string {
  const Lines: string[] = [ChatFormatter.Header('/aitem commands', ChatColor.Header)];
  const Groups: Array<{ Tier: StaffLevel; Label: string }> = [
    { Tier: 'Founder', Label: 'Founder' },
    { Tier: 'Administrator', Label: 'Administrator' },
    { Tier: 'Moderator', Label: 'Moderator' },
  ];
  let First = true;
  for (const Group of Groups) {
    const TierSubs = Subs.filter((S) => S.RequiredStaffLevel === Group.Tier);
    if (TierSubs.length === 0) continue;
    if (!First) Lines.push(ChatFormatter.Divider(ChatColor.Header));
    First = false;
    Lines.push(ChatFormatter.OOC(`-- ${Group.Label} --`));
    for (const Sub of TierSubs) {
      const Gate = StaffMeets(ActorLevel, Sub.RequiredStaffLevel) ? '' : ' (locked)';
      const Sig = Sub.Params.length > 0 ? `/aitem ${Sub.Name} ${Sub.Params}` : `/aitem ${Sub.Name}`;
      Lines.push(`${Sig} - ${Sub.Description}${Gate}`);
    }
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

// ── Founder handlers ───────────────────────────────────────────────────

/**
 * Mint items into a player's inventory (Founder - this creates value from
 * nothing and is the single most abusable command in the tree).
 *
 * The amount argument means different things by type: currency takes
 * dollars and converts through the denomination's per-unit value, so
 * `/aitem give 3 cash_100 250` is rejected as a non-multiple rather than
 * silently rounding; everything else takes a unit count.
 *
 * Partial fills are reported, not hidden. AddItem can place fewer units
 * than asked when the target is near their slot or weight ceiling, so the
 * reply names the overflow explicitly - an admin who believes a grant
 * landed in full when it did not would go looking for a duplication bug.
 */
async function HandleGive(
  Inventory: InventoryService,
  State: PlayerStateService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const TypeArg = Sub[1];
  const AmountArg = Sub[2];
  if (!Number.isFinite(Target) || !Number.isInteger(Target) || TypeArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem give <player_id> <type_id> [amount]' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const ItemTypeID = TypeArg.toLowerCase();
  const Type = GetItemType(ItemTypeID);
  if (Type === undefined) {
    return {
      Outcome: 'BadArgs',
      Reason: `Unknown item type "${ItemTypeID}". Known: ${ListItemTypeIDs().join(', ')}.`,
    };
  }
  // Currency types take a dollar amount and convert through the
  // type's per-unit value; everything else takes a unit count.
  let Quantity: number;
  const UnitCents = Type.IsCurrency === true ? (Type.CurrencyValuePerUnit ?? 1) : null;
  if (UnitCents !== null) {
    if (AmountArg === undefined) {
      return { Outcome: 'BadArgs', Reason: `Usage: /aitem give <player_id> ${ItemTypeID} <dollars>` };
    }
    const Cents = ParseDollarsToCents(AmountArg);
    if (Cents === null || Cents <= 0) {
      return {
        Outcome: 'BadArgs',
        Reason: 'Amount must be a positive dollar value (up to two decimals).',
      };
    }
    if (Cents % UnitCents !== 0) {
      return {
        Outcome: 'BadArgs',
        Reason: 'Amount must be a whole multiple of the currency denomination.',
      };
    }
    Quantity = Cents / UnitCents;
  } else {
    Quantity = AmountArg === undefined ? 1 : Number.parseInt(AmountArg, 10);
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'BadArgs', Reason: 'Amount must be a positive integer.' };
    }
  }
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Result = await Inventory.AddItem(Inv.ID, ItemTypeID, Quantity, {
    ActorSource: Ctx.Source,
    ActorCharacterID: Ctx.PlayerState.CharacterID ?? null,
    ActorAccountID: Ctx.PlayerState.AccountID ?? null,
    Action: 'AdminGive',
    Reason: 'Admin /aitem give',
    // Rebindable types (phones, radio) bind to the recipient on mint
    // too - otherwise their OwnerOnly serials start life ownerless.
    ...(Type.IsHolderBound === true || Type.IsHolderRebindable === true
      ? { BoundCharacterID: TargetState.CharacterID }
      : {}),
  });
  if (Result.Outcome !== 'Ok') {
    return {
      Outcome: 'BadArgs',
      Reason: Result.Detail ?? `Grant failed (${Result.Outcome}).`,
    };
  }
  const Added = Result.AddedCount ?? Quantity;
  const Overflow = Result.OverflowCount ?? 0;
  const Display = Type.DisplayName;
  const AddedCents = CurrencyCents(ItemTypeID, Added);
  const OverflowCents = CurrencyCents(ItemTypeID, Overflow);
  const Summary =
    AddedCents !== null
      ? `Granted ${FormatCashCents(AddedCents)} ${Display.toLowerCase()} to player ${Target}.`
      : `Granted ${Display} x${Added} to player ${Target}.`;
  const OverflowNote =
    Overflow > 0
      ? ` (${OverflowCents !== null ? FormatCashCents(OverflowCents) : `x${Overflow}`} could not fit)`
      : '';
  return { Outcome: 'Ok', Reply: ChatFormatter.Info(`${Summary}${OverflowNote}`) };
}

/**
 * Mint exactly one item with caller-supplied metadata (Founder).
 *
 * The counterpart to `give`: that one makes bulk stacks, this one makes a
 * single instance whose metadata JSON can be dictated - which is how a
 * scripted or story item gets built by hand. Metadata is parsed and shape-
 * checked here, but its *contents* are not validated against the type's
 * expectations, so a malformed payload produces an item the consuming
 * system may not understand. Founder-only for exactly that reason.
 */
async function HandleCreate(
  Inventory: InventoryService,
  State: PlayerStateService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const TypeArg = Sub[1];
  if (!Number.isFinite(Target) || !Number.isInteger(Target) || TypeArg === undefined) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /aitem create <player_id> <type_id> [metadata_json]',
    };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const ItemTypeID = TypeArg.toLowerCase();
  const Type = GetItemType(ItemTypeID);
  if (Type === undefined) {
    return { Outcome: 'BadArgs', Reason: `Unknown item type "${ItemTypeID}".` };
  }
  let Metadata: Record<string, unknown> | undefined;
  if (Sub.length > 2) {
    const Raw = Sub.slice(2).join(' ');
    try {
      const Parsed: unknown = JSON.parse(Raw);
      if (typeof Parsed !== 'object' || Parsed === null || Array.isArray(Parsed)) {
        return { Outcome: 'BadArgs', Reason: 'Metadata must be a JSON object.' };
      }
      Metadata = Parsed as Record<string, unknown>;
    } catch {
      return { Outcome: 'BadArgs', Reason: 'Metadata is not valid JSON.' };
    }
  }
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Result = await Inventory.AddItem(Inv.ID, ItemTypeID, 1, {
    ActorSource: Ctx.Source,
    ActorCharacterID: Ctx.PlayerState.CharacterID ?? null,
    ActorAccountID: Ctx.PlayerState.AccountID ?? null,
    ...(Metadata !== undefined ? { Metadata } : {}),
    Action: 'AdminMint',
    Reason: 'Admin /aitem create',
    ...(Type.IsHolderBound === true || Type.IsHolderRebindable === true
      ? { BoundCharacterID: TargetState.CharacterID }
      : {}),
  });
  if (Result.Outcome !== 'Ok') {
    return {
      Outcome: 'BadArgs',
      Reason: Result.Detail ?? `Create failed (${Result.Outcome}).`,
    };
  }
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`Created ${Type.DisplayName} for player ${Target}.`),
  };
}

/**
 * Prune mutation-log rows older than `<days>` (Founder).
 *
 * Founder-gated despite being a maintenance chore: the mutation log is
 * the audit trail every other subcommand in the Moderator tier reads
 * from, so pruning it destroys the evidence for anything older than the
 * cutoff. `0` is accepted and wipes the trail entirely.
 */
async function HandleCleanLog(
  MutationLog: InventoryMutationLogRepository,
  Sub: string[],
): Promise<CommandResult> {
  const DaysArg = Sub[0];
  if (DaysArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem cleanlog <days>' };
  }
  const Days = Number.parseInt(DaysArg, 10);
  if (!Number.isFinite(Days) || !Number.isInteger(Days) || Days < 0) {
    return { Outcome: 'BadArgs', Reason: 'Days must be a non-negative integer.' };
  }
  const Cutoff = new Date(Date.now() - Days * 24 * 60 * 60 * 1000);
  const Count = await MutationLog.Prune(Cutoff);
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`Removed ${Count} log row(s) older than ${Days} day(s).`),
  };
}

// ── Administrator handlers ─────────────────────────────────────────────

/**
 * Destroy items from a slot (Administrator).
 *
 * Slots are 1-based in the player-facing argument and 0-based in storage;
 * the conversion happens here, matching what `/aitem list` prints.
 *
 * Omitting the amount clears the whole stack rather than removing one -
 * the common admin intent is "get rid of this", and requiring the exact
 * count first would mean looking it up. As with `give`, a currency row
 * reads the amount as dollars and rejects non-multiples of the
 * denomination.
 *
 * The `ReGrantIfPermanent` call afterwards is what stops this command
 * from permanently breaking a character: some types (the phone, the ID
 * card) are meant to always exist, so removing one re-issues a fresh
 * instance rather than leaving the player without it.
 */
async function HandleRemove(
  Inventory: InventoryService,
  State: PlayerStateService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const SlotArg = Sub[1];
  const AmountArg = Sub[2];
  if (!Number.isFinite(Target) || !Number.isInteger(Target) || SlotArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem remove <player_id> <slot> [amount]' };
  }
  const SlotN = Number.parseInt(SlotArg, 10);
  if (!Number.isFinite(SlotN) || !Number.isInteger(SlotN) || SlotN <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Slot must be a positive integer.' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const SlotIndex = SlotN - 1;
  const Items = await Inventory.ListItems(Inv.ID);
  const Row = Items.find((R) => R.SlotIndex === SlotIndex);
  if (Row === undefined) {
    return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
  }
  let Quantity: number;
  const RowType = GetItemType(Row.ItemTypeID);
  const RowUnitCents = RowType?.IsCurrency === true ? (RowType.CurrencyValuePerUnit ?? 1) : null;
  if (RowUnitCents !== null) {
    if (AmountArg === undefined) {
      Quantity = Row.StackQuantity ?? 0;
    } else {
      const Cents = ParseDollarsToCents(AmountArg);
      if (Cents === null || Cents <= 0) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Amount must be a positive dollar value (up to two decimals).',
        };
      }
      if (Cents % RowUnitCents !== 0) {
        return {
          Outcome: 'BadArgs',
          Reason: 'Amount must be a whole multiple of the currency denomination.',
        };
      }
      Quantity = Cents / RowUnitCents;
    }
  } else if (AmountArg === undefined) {
    Quantity = Row.StackQuantity ?? 1;
  } else {
    Quantity = Number.parseInt(AmountArg, 10);
    if (!Number.isFinite(Quantity) || !Number.isInteger(Quantity) || Quantity <= 0) {
      return { Outcome: 'BadArgs', Reason: 'Amount must be a positive integer.' };
    }
  }
  const ItemTypeID = Row.ItemTypeID;
  const Result = await Inventory.RemoveItem(Inv.ID, SlotIndex, Quantity, {
    ActorSource: Ctx.Source,
    ActorCharacterID: Ctx.PlayerState.CharacterID ?? null,
    ActorAccountID: Ctx.PlayerState.AccountID ?? null,
    Action: 'AdminRemove',
    Reason: 'Admin /aitem remove',
  });
  if (Result.Outcome !== 'Ok') {
    return {
      Outcome: 'BadArgs',
      Reason: Result.Detail ?? `Remove failed (${Result.Outcome}).`,
    };
  }
  await Inventory.ReGrantIfPermanent(TargetState.CharacterID, ItemTypeID);
  const Removed = Result.RemovedCount ?? 0;
  const RemovedCents = CurrencyCents(ItemTypeID, Removed);
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(
      RemovedCents !== null
        ? `Removed ${FormatCashCents(RemovedCents)} from slot ${SlotN}.`
        : `Removed x${Removed} from slot ${SlotN}.`,
    ),
  };
}

/**
 * Resize a player's carrying capacity - slot count or weight ceiling
 * (Administrator).
 *
 * Each branch rewrites one axis and carries the other through unchanged,
 * because SaveCapacity takes both. Note the asymmetry in units: `slots`
 * is a count capped at 255 (the column's width), `weight` is grams, so
 * `/aitem extend 3 weight 50` sets a ceiling of 50g rather than 50kg.
 *
 * Shrinking below what the player already carries is permitted and does
 * not drop anything - the inventory simply sits over its ceiling until
 * they remove something, since silently destroying the excess would be
 * far worse than a temporarily illegal state.
 */
async function HandleExtend(
  Inventory: InventoryService,
  InventoryRepo: InventoryRepository,
  State: PlayerStateService,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const FieldRaw = Sub[1];
  const ValueArg = Sub[2];
  if (
    !Number.isFinite(Target) ||
    !Number.isInteger(Target) ||
    FieldRaw === undefined ||
    ValueArg === undefined
  ) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /aitem extend <player_id> slots|weight <value>',
    };
  }
  const Field = FieldRaw.toLowerCase();
  if (Field !== 'slots' && Field !== 'weight') {
    return { Outcome: 'BadArgs', Reason: 'Field must be "slots" or "weight".' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  if (Field === 'slots') {
    const Slots = Number.parseInt(ValueArg, 10);
    if (!Number.isFinite(Slots) || !Number.isInteger(Slots) || Slots <= 0 || Slots > 255) {
      return { Outcome: 'BadArgs', Reason: 'Slot count must be between 1 and 255.' };
    }
    await InventoryRepo.SaveCapacity(
      Inv.ID,
      Slots,
      Number.parseFloat(Inv.WeightCapacityGrams),
    );
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info(`Inventory slot capacity set to ${Slots}.`),
    };
  }
  const Weight = Number.parseFloat(ValueArg);
  if (!Number.isFinite(Weight) || Weight <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Weight must be a positive number of grams.' };
  }
  await InventoryRepo.SaveCapacity(Inv.ID, Inv.SlotCapacity, Weight);
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(
      `Inventory weight capacity set to ${FormatWeightGrams(Weight)}.`,
    ),
  };
}

/**
 * Strip the serial from a serialised item, simulating a filed-off number
 * (Administrator).
 *
 * A roleplay tool, not a repair one: defacing a weapon's serial is what
 * makes it untraceable through `/aitem traceweapon`, so this is how an
 * admin sets up a scene where forensics comes back empty. Irreversible -
 * there is no re-stamp command - and recorded against the acting
 * account, which is why an actor without an AccountID is refused.
 */
async function HandleRemoveSerial(
  Inventory: InventoryService,
  State: PlayerStateService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const SlotArg = Sub[1];
  if (!Number.isFinite(Target) || !Number.isInteger(Target) || SlotArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem removeserial <player_id> <slot>' };
  }
  const SlotN = Number.parseInt(SlotArg, 10);
  if (!Number.isFinite(SlotN) || !Number.isInteger(SlotN) || SlotN <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Slot must be a positive integer.' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  if (Ctx.PlayerState.AccountID === null) return { Outcome: 'PermissionDenied' };
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Ok = await Inventory.DefaceSerial(Inv.ID, SlotN - 1, Ctx.PlayerState.AccountID);
  if (!Ok) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Cannot remove serial (wrong type or already stripped).',
    };
  }
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`Serial stripped from slot ${SlotN}.`),
  };
}

/**
 * Re-point a holder-bound item at a different character (Administrator).
 *
 * Bound items (phones, radios) carry an owning character id that gates
 * who can use them. This is the escape hatch for when that binding is
 * wrong - a phone recovered from a dead character, an item restored to
 * the wrong owner after a rollback.
 *
 * The new holder is taken as a raw character id rather than a server id,
 * since the intended recipient is frequently offline. Nothing verifies
 * that the id exists: a typo produces an item bound to a character that
 * never logs in, effectively destroying it.
 */
async function HandleSetHolder(
  Inventory: InventoryService,
  State: PlayerStateService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  const SlotArg = Sub[1];
  const NewHolderArg = Sub[2];
  if (
    !Number.isFinite(Target) ||
    !Number.isInteger(Target) ||
    SlotArg === undefined ||
    NewHolderArg === undefined ||
    !/^\d+$/.test(NewHolderArg)
  ) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /aitem setholder <player_id> <slot> <new_holder_character_id>',
    };
  }
  const SlotN = Number.parseInt(SlotArg, 10);
  if (!Number.isFinite(SlotN) || !Number.isInteger(SlotN) || SlotN <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Slot must be a positive integer.' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  if (Ctx.PlayerState.AccountID === null) return { Outcome: 'PermissionDenied' };
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Ok = await Inventory.RebindHolder(
    Inv.ID,
    SlotN - 1,
    NewHolderArg,
    Ctx.PlayerState.AccountID,
  );
  if (!Ok) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Cannot set the holder of that item (wrong type or empty slot).',
    };
  }
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`Holder of slot ${SlotN} set to character ${NewHolderArg}.`),
  };
}

/**
 * Delete every ground drop within a radius of the admin (Administrator).
 *
 * The cleanup tool for a scene littered with casings, blood splats and
 * dropped loot. Radius is metres, capped at 5000 - large enough to clear
 * a district, small enough that a mistyped value cannot wipe the map.
 * Destructive and unrecoverable: dropped items are gone, not returned to
 * anyone's inventory.
 */
async function HandleClearDrops(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const RadiusArg = Sub[0];
  if (RadiusArg === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem cleardrops <radius_meters>' };
  }
  const Radius = Number.parseFloat(RadiusArg);
  if (!Number.isFinite(Radius) || Radius <= 0 || Radius > 5_000) {
    return { Outcome: 'BadArgs', Reason: 'Radius must be a positive number up to 5000.' };
  }
  const Coord = Inventory.ReadPedCoord(Ctx.Source);
  if (Coord === null) {
    return { Outcome: 'BadArgs', Reason: 'Could not read your position.' };
  }
  const Count = await Inventory.ClearDropsInRadius(
    Coord.World,
    Coord.X,
    Coord.Y,
    Coord.Z,
    Radius,
  );
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`Cleared ${Count} drop(s) within ${Radius}m.`),
  };
}

/**
 * Start an engine-backed audit of the weapon catalog (Administrator).
 *
 * Asynchronous by nature: only a game client can answer "does this hash
 * resolve, does this component fit this weapon", so the sweep runs on the
 * admin's own client and reports back seconds later through the callback.
 * The command therefore returns immediately and the result arrives as a
 * separate chat message.
 *
 * Requires an empty loadout - the audit gives and strips weapons on the
 * admin's ped, so an equipped weapon would be clobbered. The callback is
 * wrapped in try/catch because the admin may have disconnected before the
 * sweep returned.
 */
function HandleTestCatalog(
  Inventory: InventoryService,
  Chat: ChatService,
  Ctx: CommandContext,
): CommandResult {
  const Source = Ctx.Source;
  const Outcome = Inventory.StartCatalogAudit(Source, (Result): void => {
    try {
      Chat.SendTo(Source, RenderCatalogAudit(Result));
    } catch {
      // The admin may have disconnected before the sweep returned.
    }
  });
  switch (Outcome) {
    case 'Ok':
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(
          'Catalog audit started. The engine sweep reports back within a few seconds.',
        ),
      };
    case 'EquippedWeapon':
      return {
        Outcome: 'BadArgs',
        Reason: 'Unequip your weapon first - the audit needs a clean loadout.',
      };
    case 'Busy':
      return { Outcome: 'BadArgs', Reason: 'An audit is already running for you.' };
    case 'NoPed':
      return { Outcome: 'BadArgs', Reason: 'Could not resolve your ped.' };
  }
}

/**
 * Format a finished catalog audit for chat.
 *
 * Every failure bucket is a real defect except one: clip-size drift is
 * expected, because the catalog's MaxAmmo is the server's reload cap
 * rather than a claim about the engine default. That distinction is
 * called out inline so nobody "fixes" the catalog to match the engine and
 * quietly changes reload behaviour.
 *
 * Chat is the summary surface, not the report - buckets are capped and
 * the full detail goes to the server log.
 */
function RenderCatalogAudit(Result: CatalogAuditResult): string {
  if (Result.TimedOut) {
    return ChatFormatter.Info(
      'Catalog audit timed out - the client never reported back. The audit loadout has been stripped.',
    );
  }
  const Lines: string[] = [ChatFormatter.Header('Catalog audit', ChatColor.Header)];
  Lines.push(ChatFormatter.Label('Weapons checked', String(Result.CheckedWeapons)));
  Lines.push(ChatFormatter.Label('Components checked', String(Result.CheckedComponents)));
  Lines.push(
    ChatFormatter.Label(
      'Component drop models',
      `${Result.ResolvedComponentModels} engine-resolved`,
    ),
  );
  const Failures =
    Result.InvalidWeapons.length +
    Result.MissingWeapons.length +
    Result.ComponentRejections.length +
    Result.InvalidDropModels.length;
  if (Failures === 0) {
    Lines.push(
      ChatFormatter.Info('The engine accepted every weapon, component pairing, and drop model.'),
    );
  }
  PushCappedList(Lines, 'Unknown to engine', Result.InvalidWeapons);
  PushCappedList(Lines, 'Give did not land', Result.MissingWeapons);
  PushCappedList(
    Lines,
    'Component rejected',
    Result.ComponentRejections.map((R) => `${R.Component} -> ${R.Weapon}`),
  );
  PushCappedList(Lines, 'Bad drop model', Result.InvalidDropModels);
  PushCappedList(
    Lines,
    'Clip size differs',
    Result.ClipSizeMismatches.map((R) => `${R.ID}: engine ${R.Engine}, catalog ${R.Catalog}`),
  );
  if (Result.ClipSizeMismatches.length > 0) {
    Lines.push(
      ChatFormatter.OOC(
        'Clip drift is informational - catalog MaxAmmo is the server reload cap, not the engine default.',
      ),
    );
  }
  Lines.push(ChatFormatter.OOC('The full report is in the server log.'));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Append a labelled failure bucket, truncated at 15 entries with an
 * explicit "...and N more" tail. Empty buckets emit nothing at all, so a
 * clean audit stays short.
 *
 * The count in the label is the true total, not the number printed - a
 * silent truncation would read as "only 15 problems" when there are
 * hundreds.
 */
function PushCappedList(Lines: string[], Label: string, Entries: readonly string[]): void {
  if (Entries.length === 0) return;
  const Cap = 15;
  Lines.push(ChatFormatter.Label(Label, String(Entries.length)));
  for (const Entry of Entries.slice(0, Cap)) {
    Lines.push(`  - ${Entry}`);
  }
  if (Entries.length > Cap) {
    Lines.push(`  ...and ${Entries.length - Cap} more in the server log.`);
  }
}

// ── Moderator handlers ─────────────────────────────────────────────────

/**
 * Print a spawned player's full inventory plus their cash total.
 *
 * Cash is fetched separately because it is not a single row: paper
 * currency is ordinary stackable items spread across slots, so the total
 * has to be summed by CashService rather than read off the listing.
 */
async function HandleList(
  Inventory: InventoryService,
  Cash: CashService,
  State: PlayerStateService,
  Sub: string[],
): Promise<CommandResult> {
  const Target = Number(Sub[0]);
  if (!Number.isFinite(Target) || !Number.isInteger(Target)) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem list <player_id>' };
  }
  const TargetState = State.Get(Target);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${Target} is not in the world.` };
  }
  const Inv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Items = await Inventory.ListItems(Inv.ID);
  const Cents = await Cash.GetTotalCents(TargetState.CharacterID);
  return { Outcome: 'Ok', Reply: RenderAdminInventory(Items, Cents) };
}

/**
 * Locate a serialised item by serial and report where it currently sits.
 *
 * The one lookup in this tier that works on offline characters, since it
 * queries storage by serial rather than walking a live session - which is
 * the point, as a stolen weapon is rarely still on the person who took it.
 * Answers "where is it now"; `history` answers "how did it get there".
 */
async function HandleFind(
  InventoryRepo: InventoryRepository,
  Characters: CharacterRepository,
  Sub: string[],
): Promise<CommandResult> {
  const Serial = Sub[0];
  if (Serial === undefined || Serial.length === 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem find <serial>' };
  }
  const Row = await InventoryRepo.FindByUniqueSerial(Serial);
  if (Row === null) {
    return { Outcome: 'BadArgs', Reason: `No item with serial "${Serial}".` };
  }
  const Type = GetItemType(Row.ItemTypeID);
  const HolderName = await ResolveCharacterName(Characters, Row.BoundCharacterID);
  const Lines: string[] = [
    ChatFormatter.Header('Find Item', ChatColor.Header),
    ChatFormatter.Label('Type', Type?.DisplayName ?? Row.ItemTypeID),
    ChatFormatter.Label('Serial', Serial),
    ChatFormatter.Label('InventoryID', String(Row.InventoryID)),
    ChatFormatter.Label('Slot', String(Row.SlotIndex + 1)),
  ];
  if (HolderName !== null) Lines.push(ChatFormatter.Label('Bound holder', HolderName));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * Print the last 50 mutations touching one serial - the item's life
 * story, from mint through every transfer, drop and pickup.
 *
 * Bounded by the retention `cleanlog` leaves behind: an item older than
 * the last prune shows a trail that begins mid-life rather than at mint.
 */
async function HandleHistory(
  MutationLog: InventoryMutationLogRepository,
  Sub: string[],
): Promise<CommandResult> {
  const Serial = Sub[0];
  if (Serial === undefined || Serial.length === 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem history <serial>' };
  }
  const Rows = await MutationLog.FindByUniqueSerial(Serial, 50);
  if (Rows.length === 0) {
    return { Outcome: 'BadArgs', Reason: `No mutation log entries for "${Serial}".` };
  }
  return { Outcome: 'Ok', Reply: RenderMutationTrail(`Trail: ${Serial}`, Rows) };
}

/**
 * Print every row sharing one transaction id - the other axis through the
 * mutation log.
 *
 * Composite operations (a give is a remove plus an add) write several
 * rows under one transaction id, so this is what shows both halves
 * together and proves an item moved rather than being duplicated. Where
 * `history` follows one item through time, this shows one moment across
 * items.
 */
async function HandleTrace(
  MutationLog: InventoryMutationLogRepository,
  Sub: string[],
): Promise<CommandResult> {
  const TransactionID = Sub[0];
  if (TransactionID === undefined || TransactionID.length === 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem trace <transaction_id>' };
  }
  const Rows = await MutationLog.FindByTransactionID(TransactionID);
  if (Rows.length === 0) {
    return { Outcome: 'BadArgs', Reason: `No rows for transaction "${TransactionID}".` };
  }
  return {
    Outcome: 'Ok',
    Reply: RenderMutationTrail(`Trace: ${TransactionID}`, Rows),
  };
}

/**
 * Ballistics for one weapon serial: the last 50 discharges with shooter,
 * victim, damage and position.
 *
 * Reads the discharge log rather than the mutation log - who *fired* it,
 * not who *carried* it. A defaced serial (see `removeserial`) has no
 * serial to query, which is the intended forensic dead end.
 */
async function HandleTraceWeapon(
  DischargeLog: WeaponDischargeLogRepository,
  Sub: string[],
): Promise<CommandResult> {
  const Serial = Sub[0];
  if (Serial === undefined || Serial.length === 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem traceweapon <serial>' };
  }
  const Rows = await DischargeLog.FindBySerial(Serial, 50);
  if (Rows.length === 0) {
    return { Outcome: 'BadArgs', Reason: `No discharge entries for serial "${Serial}".` };
  }
  return {
    Outcome: 'Ok',
    Reply: RenderDischargeRows(`Trace: ${Serial}`, Rows),
  };
}

/**
 * The inverse of `traceweapon`: given a character, list the serials they
 * most recently fired.
 *
 * Answers "what was this person shooting" when you have a suspect but no
 * weapon. Capped at 10 and keyed on character id rather than server id so
 * it works on someone already disconnected.
 */
async function HandleLastFired(
  DischargeLog: WeaponDischargeLogRepository,
  Sub: string[],
): Promise<CommandResult> {
  const Arg = Sub[0];
  if (Arg === undefined || !/^\d+$/.test(Arg)) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem lastfired <character_id>' };
  }
  const Entries = await DischargeLog.ListSerialsByShooter(Arg, 10);
  const Lines: string[] = [
    ChatFormatter.Header(`Last fired: char ${Arg}`, ChatColor.Header),
  ];
  if (Entries.length === 0) {
    Lines.push(ChatFormatter.OOC('No recorded discharges.'));
  } else {
    for (const Entry of Entries) {
      Lines.push(
        ChatFormatter.Label(Entry.Serial, Entry.LastShotAt.toISOString()),
      );
    }
    Lines.push(
      ChatFormatter.OOC('Older history surfaces in the web UCP when it lands.'),
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * Page through pending player-submitted item naming/description requests.
 *
 * Custom text on an item is moderated rather than free-form, so this is
 * the review queue feeding `approve` and `deny`. Ten per page; the
 * request id printed here is the argument those two take.
 */
async function HandleRequests(
  Inventory: InventoryService,
  Sub: string[],
): Promise<CommandResult> {
  const PageArg = Sub[0];
  let Page = 1;
  if (PageArg !== undefined) {
    const Parsed = Number.parseInt(PageArg, 10);
    if (!Number.isFinite(Parsed) || Parsed <= 0) {
      return { Outcome: 'BadArgs', Reason: 'Page must be a positive integer.' };
    }
    Page = Parsed;
  }
  const PageSize = 10;
  const Rows = await Inventory.ListPendingNameRequests(PageSize, (Page - 1) * PageSize);
  if (Rows.length === 0) {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info('No pending item requests.') };
  }
  const Lines: string[] = [
    ChatFormatter.Header(`Item Requests (page ${Page})`, ChatColor.Header),
  ];
  for (const Row of Rows) {
    Lines.push(
      `#${Row.ID} [${Row.Kind}] item=${Row.InventoryItemID} char=${Row.RequestedByCharacterID}: ${Row.RequestedText}`,
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * Approve a naming request, writing the player's text onto the item.
 *
 * The approving account is recorded, which is why this takes Ctx while
 * `deny` does not - an approval puts player-authored text in front of
 * everyone who inspects the item, so it needs to be attributable.
 */
async function HandleApprove(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Arg = Sub[0];
  if (Arg === undefined || !/^\d+$/.test(Arg)) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /aitem approve <request_id>' };
  }
  const ActorAccountID = Ctx.Account?.ID ?? null;
  const Result = await Inventory.ApproveNameRequest(Arg, ActorAccountID);
  if (Result.Outcome === 'Ok') {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info(`Approved request ${Arg}.`) };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Approval failed (${Result.Outcome}).`,
  };
}

/**
 * Reject a naming request, leaving the item's text untouched.
 *
 * The usage string advertises an optional `[reason]` that is parsed off
 * but not currently persisted or shown to the requester - the argument is
 * accepted so muscle memory and the eventual notification path do not
 * have to change when it is wired up.
 */
async function HandleDeny(
  Inventory: InventoryService,
  Sub: string[],
): Promise<CommandResult> {
  const Arg = Sub[0];
  if (Arg === undefined || !/^\d+$/.test(Arg)) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /aitem deny <request_id> [reason]',
    };
  }
  const Ok = await Inventory.DenyNameRequest(Arg);
  if (!Ok) {
    return { Outcome: 'BadArgs', Reason: 'No request with that ID.' };
  }
  return { Outcome: 'Ok', Reply: ChatFormatter.Info(`Denied request ${Arg}.`) };
}

// ── Renderers ──────────────────────────────────────────────────────────

/**
 * Format ballistics rows: when, who fired, who was hit, how hard, and
 * where. Position and world are included because a shooting's location is
 * usually the point of the query.
 */
function RenderDischargeRows(
  Title: string,
  Rows: readonly WeaponDischargeLog[],
): string {
  const Lines: string[] = [ChatFormatter.Header(Title, ChatColor.Header)];
  for (const Row of Rows) {
    const Shooter = Row.ShooterCharacterID ?? '?';
    const Victim = Row.VictimCharacterID ?? '?';
    const Where = `(${Row.PositionX}, ${Row.PositionY}, ${Row.PositionZ}) world=${Row.World}`;
    Lines.push(
      `${Row.OccurredAt.toISOString()} shooter=${Shooter} victim=${Victim} dmg=${Row.Damage} ${Where}`,
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Format a player's inventory for staff review.
 *
 * Differs from the player-facing manifest in RenderRow: serials are
 * always shown regardless of the type's SerialVisibility, since the point
 * of an admin listing is to see what the player cannot.
 */
function RenderAdminInventory(Items: readonly InventoryItem[], CashCents: number): string {
  const Lines: string[] = [ChatFormatter.Header('Admin Inventory', ChatColor.Header)];
  Lines.push(ChatFormatter.Label('Cash total', FormatCashCents(CashCents)));
  if (Items.length === 0) {
    Lines.push(ChatFormatter.OOC('No items.'));
  } else {
    for (const Row of Items) {
      const Type = GetItemType(Row.ItemTypeID);
      const Display = Type?.DisplayName ?? Row.ItemTypeID;
      const Quantity =
        Row.StackQuantity !== null && Row.StackQuantity > 1 ? ` x${Row.StackQuantity}` : '';
      const Serial = Row.UniqueSerial !== null ? ` [Serial: ${Row.UniqueSerial}]` : '';
      Lines.push(`Slot ${Row.SlotIndex + 1}: ${Display}${Quantity}${Serial}`);
    }
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Format mutation-log rows for `history` and `trace`.
 *
 * The actor column falls back through character, then account, then
 * `[system]` - a mutation with no character behind it was an admin acting
 * outside a character, or the server itself (a permanent re-grant, a
 * death snapshot).
 */
function RenderMutationTrail(Title: string, Rows: readonly InventoryMutationLog[]): string {
  const Lines: string[] = [ChatFormatter.Header(Title, ChatColor.Header)];
  for (const Row of Rows) {
    const Actor =
      Row.ActorCharacterID !== null
        ? `char ${Row.ActorCharacterID}`
        : Row.ActorAccountID !== null
          ? `account ${Row.ActorAccountID}`
          : '[system]';
    const Quantity = Row.Quantity !== null ? ` x${Row.Quantity}` : '';
    const Reason = Row.Reason !== null ? ` - ${Row.Reason}` : '';
    Lines.push(
      `${Row.CreatedAt.toISOString()} [${Row.Action}] ${Actor} ${Row.ItemTypeID}${Quantity}${Reason}`,
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Best-effort character id -> "First Last" for audit output.
 *
 * Deliberately reads through the soft-delete filter: an item bound to a
 * deleted character should still name them, since "bound to a character
 * that no longer exists" is exactly the state an admin is investigating.
 * Returns null rather than throwing when the row is genuinely gone.
 */
async function ResolveCharacterName(
  Characters: CharacterRepository,
  CharacterID: string | null,
): Promise<string | null> {
  if (CharacterID === null) return null;
  const Row = await Characters.FindByIDWithDeleted(CharacterID);
  if (Row === null) return null;
  return `${Row.FirstName} ${Row.LastName}`;
}
