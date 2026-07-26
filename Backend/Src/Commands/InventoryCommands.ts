import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import { BreathTestRangeMeters, FormatBacPercent } from '@Shared/Constants/Alcohol.js';
import { StandardDrinkEthanolGrams } from '@Shared/Constants/Drugs.js';
import {
  FormatCashCents,
  FormatWeightGrams,
  HandoverRangeMeters,
  PickupRangeMeters,
} from '@Shared/Constants/Inventory.js';
import {
  CurrencyCents,
  GetItemType,
  type AttachmentSlot,
  type ItemTypeDefinition,
} from '@Shared/Constants/ItemTypes.js';
import type { CommandContext, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { InventoryService } from '@/Services/InventoryService.js';
import type { AddictionService } from '@/Services/AddictionService.js';
import type { AlcoholService } from '@/Services/AlcoholService.js';
import type { NametagActionService } from '@/Services/NametagActionService.js';
import type { BleedingService } from '@/Services/BleedingService.js';
import type { CashService } from '@/Services/CashService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import type { InventoryItem } from '@/Data/Models/InventoryItem.js';

/**
 * Player-facing inventory cluster.
 *
 *   /inventory (/inv, /i)        - text manifest (always flat for hot-path).
 *   /item                        - dispatcher; bare lists subcommands.
 *   /container                   - dispatcher for container ops.
 *
 * Slot args are 1-based at the chat boundary; the service uses 0-based
 * indices, conversion happens in `ParseSlot`.
 */

/** Receives the args *after* the subcommand name, already split. */
type SubHandler = (Ctx: CommandContext, SubArgs: string[]) => Promise<CommandResult>;

/**
 * One `/item` or `/container` subcommand. `Params` is the usage signature
 * shown in the generated help, so it doubles as documentation and must
 * match what the handler actually parses.
 */
interface SubCommand {
  readonly Name: string;
  readonly Params: string;
  readonly Description: string;
  readonly Handler: SubHandler;
}

/**
 * Wire the player-facing inventory commands into the registry.
 *
 * Takes a long dependency list because item use is the junction where
 * most gameplay systems meet: a single `/item use` can heal, sober,
 * dose, narrate and re-tag a player. InventoryService deliberately holds
 * none of those services (see its header on the acyclic-graph rule), so
 * the wiring lands here instead - this layer is what applies the effects
 * the service hands back.
 */
export function Register(
  Registry: CommandRegistry,
  Inventory: InventoryService,
  Cash: CashService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Bleeding: BleedingService,
  Alcohol: AlcoholService,
  Addiction: AddictionService,
  NametagActions: NametagActionService,
  Chat: ChatService,
  Runtimes: CharacterRuntimeService,
): void {
  // ── /inventory (kept flat - hot path, most-typed command) ──────────
  Registry.Add({
    Name: 'inventory',
    Aliases: ['inv', 'i'],
    Description: 'List your inventory, or open a container slot.',
    Params: '[container_slot]',
    Category: 'RP',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      return ShowManifest(Inventory, Ctx, Ctx.Args[0]);
    },
  });

  // ── /item <sub> ────────────────────────────────────────────────────
  const ItemSubs: SubCommand[] = [
    {
      Name: 'cash',
      Params: '',
      Description: 'Show your cash balance.',
      Handler: async (Ctx) => {
        if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
        if (!Inventory.TryConsumeReadToken(Ctx.Source)) {
          return { Outcome: 'OnCooldown', RemainingMs: 100 };
        }
        const Cents = await Cash.GetTotalCents(Ctx.PlayerState.CharacterID);
        return {
          Outcome: 'Ok',
          Reply: ChatFormatter.Info(`You are carrying ${FormatCashCents(Cents)} in cash.`),
        };
      },
    },
    {
      Name: 'use',
      Params: '<slot> [target]',
      Description:
        'Use the item in a slot. Some devices take a second argument: a player ID to read, or a slot to test.',
      Handler: (Ctx, Sub) =>
        HandleUse(
          Inventory,
          Bleeding,
          Alcohol,
          Addiction,
          State,
          Broadcaster,
          NametagActions,
          Chat,
          Runtimes,
          Ctx,
          Sub,
        ),
    },
    {
      Name: 'inspect',
      Params: '<slot>',
      Description: 'Read the visible metadata for an item in your inventory.',
      Handler: (Ctx, Sub) => HandleInspect(Inventory, Ctx, Sub),
    },
    {
      Name: 'examine',
      Params: '[drop_id]',
      Description: 'Examine a ground drop up close without picking it up.',
      Handler: (Ctx, Sub) => HandleExamine(Inventory, NametagActions, Ctx, Sub),
    },
    {
      Name: 'drop',
      Params: '<slot> [amount]',
      Description: 'Drop an item from your inventory to the ground.',
      Handler: (Ctx, Sub) => HandleDrop(Inventory, Ctx, Sub),
    },
    {
      Name: 'pickup',
      Params: '[drop_id]',
      Description: 'Pick up a drop by ID (defaults to the nearest in range).',
      Handler: (Ctx, Sub) => HandlePickup(Inventory, Ctx, Sub),
    },
    {
      Name: 'nearby',
      Params: '',
      Description: 'List items on the ground near you.',
      Handler: (Ctx) => HandleNearby(Inventory, Ctx),
    },
    {
      Name: 'give',
      Params: '<player_id> <slot> [amount]',
      Description: 'Hand an item to a nearby player.',
      Handler: (Ctx, Sub) => HandleGive(Inventory, State, Broadcaster, NametagActions, Ctx, Sub),
    },
    {
      Name: 'move',
      Params: '<from_slot> <to_slot> [amount]',
      Description: 'Move or merge an item between two slots; an amount moves part of a stack.',
      Handler: (Ctx, Sub) => HandleMove(Inventory, Ctx, Sub),
    },
    {
      Name: 'split',
      Params: '<slot> <amount>',
      Description: 'Split a stack into a new slot.',
      Handler: (Ctx, Sub) => HandleSplit(Inventory, Ctx, Sub),
    },
    {
      Name: 'equip',
      Params: '<slot>',
      Description: 'Equip a weapon from your inventory.',
      Handler: (Ctx, Sub) => HandleEquip(Inventory, Ctx, Sub),
    },
    {
      Name: 'unequip',
      Params: '',
      Description: 'Unequip your current weapon.',
      Handler: (Ctx) => HandleUnequip(Inventory, Ctx),
    },
    {
      Name: 'reload',
      Params: '',
      Description: 'Reload your equipped weapon from compatible loose ammo.',
      Handler: (Ctx) => HandleReload(Inventory, Ctx),
    },
    {
      Name: 'attach',
      Params: '<component_slot> <weapon_slot>',
      Description: 'Install a weapon component into a weapon.',
      Handler: (Ctx, Sub) => HandleAttach(Inventory, Ctx, Sub),
    },
    {
      Name: 'detach',
      Params: '<weapon_slot> <Magazine|Sight|Muzzle|Grip|Flashlight>',
      Description: 'Remove a component from a weapon back to your inventory.',
      Handler: (Ctx, Sub) => HandleDetach(Inventory, Ctx, Sub),
    },
    {
      Name: 'rename',
      Params: '<slot> <text|clear>',
      Description: 'Submit a custom name for staff review (or "clear" to remove).',
      Handler: (Ctx, Sub) => HandleNameKind(Inventory, Ctx, Sub, 'Name'),
    },
    {
      Name: 'describe',
      Params: '<slot> <text|clear>',
      Description: 'Submit a description for staff review (or "clear" to remove).',
      Handler: (Ctx, Sub) => HandleNameKind(Inventory, Ctx, Sub, 'Description'),
    },
    {
      Name: 'removeserial',
      Params: '<slot>',
      Description: 'Submit a serial-removal request for staff review.',
      Handler: (Ctx, Sub) => HandleRemoveSerial(Inventory, Ctx, Sub),
    },
  ];

  Registry.Add({
    Name: 'item',
    Description: 'Inventory actions. Type /item with no arguments to list every subcommand.',
    Params: '<subcommand> [...]',
    Category: 'RP',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => DispatchSub(Ctx, ItemSubs, 'item'),
  });

  // ── /container <sub> ───────────────────────────────────────────────
  const ContainerSubs: SubCommand[] = [
    {
      Name: 'info',
      Params: '<container_slot>',
      Description: 'List the contents of a held container.',
      Handler: (Ctx, Sub) => HandleContainerInfo(Inventory, Ctx, Sub),
    },
    {
      Name: 'store',
      Params: '<from_slot> <container_slot> [inner_slot]',
      Description: 'Move an item from your main inventory into a held container.',
      Handler: (Ctx, Sub) => HandleContainerStore(Inventory, Ctx, Sub),
    },
    {
      Name: 'take',
      Params: '<container_slot> <inner_slot> [to_slot]',
      Description: 'Move an item out of a held container into your main inventory.',
      Handler: (Ctx, Sub) => HandleContainerTake(Inventory, Ctx, Sub),
    },
  ];

  Registry.Add({
    Name: 'container',
    Description: 'Container actions. Type /container with no arguments to list every subcommand.',
    Params: '<subcommand> [...]',
    Category: 'RP',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => DispatchSub(Ctx, ContainerSubs, 'container'),
  });
}

// ── Dispatcher ─────────────────────────────────────────────────────────

/**
 * Route `/parent <sub> ...` to its handler.
 *
 * A bare parent, `help` and `?` all print the index rather than erroring,
 * so a player who forgets the syntax is shown it instead of scolded. An
 * unknown subcommand names the parent in the refusal for the same reason.
 */
function DispatchSub(
  Ctx: CommandContext,
  Subs: readonly SubCommand[],
  Parent: string,
): CommandResult | Promise<CommandResult> {
  const Sub = (Ctx.Args[0] ?? '').toLowerCase();
  if (Sub === '' || Sub === 'help' || Sub === '?') {
    return { Outcome: 'Ok', Reply: RenderHelp(Parent, Subs) };
  }
  const Found = Subs.find((S) => S.Name === Sub);
  if (Found === undefined) {
    return {
      Outcome: 'BadArgs',
      Reason: `Unknown subcommand "${Sub}". Type /${Parent} for the full list.`,
    };
  }
  return Found.Handler(Ctx, Ctx.Args.slice(1));
}

/**
 * Build the subcommand index from the table itself, so a new entry is
 * documented in chat the moment it is registered. Unlike the admin
 * equivalent there is no tier filtering - every subcommand here is
 * available to every player with a character.
 */
function RenderHelp(Parent: string, Subs: readonly SubCommand[]): string {
  const Lines: string[] = [
    ChatFormatter.Header(`/${Parent} commands`, ChatColor.Header),
  ];
  for (const Sub of Subs) {
    const Sig = Sub.Params.length > 0 ? `/${Parent} ${Sub.Name} ${Sub.Params}` : `/${Parent} ${Sub.Name}`;
    Lines.push(`${Sig} - ${Sub.Description}`);
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

// ── /item handlers ─────────────────────────────────────────────────────

/**
 * `/item use <slot> [target]` - the widest command in the cluster.
 *
 * InventoryService decides what using the item *means* and returns the
 * consequences without applying them; this function is where they land.
 * That split exists because the service deliberately holds none of the
 * bleeding, alcohol or addiction services (see the InventoryService
 * header on the acyclic-graph rule), so every effect on the result object
 * has to be dispatched here.
 *
 * Two shapes of outcome:
 *   - Consumables report deltas already decided (HP regen, ethanol grams,
 *     a drug dose, a bleeding-relief tier) which are handed to the owning
 *     service.
 *   - Devices report a flag (BreathTest, SampleTest, IdPresent) meaning
 *     nothing was consumed and the real work is here - resolve the
 *     optional target argument, then stamp the cooldown only once that
 *     target validates, so a mistyped target does not burn the device.
 *
 * Missing a branch loses that half of an item's behaviour silently, since
 * the service still reports Ok.
 */
async function HandleUse(
  Inventory: InventoryService,
  Bleeding: BleedingService,
  Alcohol: AlcoholService,
  Addiction: AddictionService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  NametagActions: NametagActionService,
  Chat: ChatService,
  Runtimes: CharacterRuntimeService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  if (Slot === null) return { Outcome: 'BadArgs', Reason: 'Usage: /item use <slot> [target]' };
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Result = await Inventory.UseItem(Ctx.Source, Slot);
  switch (Result.Outcome) {
    case 'Ok':
      if (Result.BreathTest === true) {
        return await RunBreathTest(
          Alcohol,
          Inventory,
          State,
          Broadcaster,
          NametagActions,
          Ctx,
          Sub[1],
          Result.ItemTypeID,
        );
      }
      if (Result.SampleTest === true) {
        return await RunSampleTest(Inventory, NametagActions, Ctx, Sub[1], Result.ItemTypeID);
      }
      if (Result.IdPresent === true) {
        return RunIdPresent(
          Inventory,
          State,
          Broadcaster,
          Runtimes,
          Chat,
          NametagActions,
          Ctx,
          Sub[1],
          Result.ItemTypeID,
          Result.CardSerial ?? null,
        );
      }
      if (Result.ApplyEffects !== undefined) {
        Inventory.ApplyConsumableEffects(Ctx.Source, Result.ApplyEffects);
        if (Result.ApplyEffects.BleedingRelief !== undefined) {
          // The relief hand-off lives here rather than inside
          // InventoryService: BleedingService depends on the
          // inventory for evidence spawning, so the command layer is
          // the lowest point that can hold both without a cycle.
          void Bleeding.ApplyRelief(Ctx.Source, Result.ApplyEffects.BleedingRelief);
        }
      }
      if (Result.AlcoholEthanolGrams !== undefined) {
        // Same layering rationale as the bleeding relief: the alcohol
        // bookkeeping needs the character repository, which the
        // inventory deliberately does not hold. Fire-and-forget - a
        // failed write loses one drink's BAC, never the item. The
        // drink also feeds the alcoholism ledger, weighted by its
        // ethanol share of a standard drink.
        void Alcohol.Ingest(Ctx.Source, Result.AlcoholEthanolGrams);
        void Addiction.RecordDose(
          Ctx.Source,
          'Alcohol',
          Result.AlcoholEthanolGrams / StandardDrinkEthanolGrams,
        );
      }
      if (Result.DrugDose !== undefined) {
        void Addiction.RecordDose(Ctx.Source, Result.DrugDose.Class, Result.DrugDose.DoseScale);
      }
      return {
        Outcome: 'Ok',
        ...(Result.Reply !== undefined ? { Reply: Result.Reply } : {}),
      };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
    case 'InvalidUse':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'You cannot use that item.' };
    case 'OnCooldown':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'That item is on cooldown.' };
    case 'PermissionDenied':
      return { Outcome: 'PermissionDenied' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Could not use that item (${Result.Outcome}).`,
      };
  }
}

/**
 * Breath-test flow for `/item use <slot> [player_id]` on a device
 * declaring IsBreathTester. Omitting the target reads the tester's
 * own breath. The subject must stand within BreathTestRangeMeters -
 * a breath sample is a close IC interaction, not a remote scan - and
 * the act always floats above the tester's head so a reading can
 * never be taken silently. The number itself goes to the tester
 * alone; announcing it is an IC choice.
 */
async function RunBreathTest(
  Alcohol: AlcoholService,
  Inventory: InventoryService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  NametagActions: NametagActionService,
  Ctx: CommandContext,
  TargetArg: string | undefined,
  ItemTypeID: string | undefined,
): Promise<CommandResult> {
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  let TargetSource = Ctx.Source;
  let TargetCharacterID = Ctx.PlayerState.CharacterID;
  if (TargetArg !== undefined) {
    const Parsed = Number(TargetArg);
    if (!Number.isFinite(Parsed) || !Number.isInteger(Parsed) || Parsed <= 0) {
      return { Outcome: 'BadArgs', Reason: 'Usage: /item use <slot> [player_id]' };
    }
    TargetSource = Parsed;
  }
  if (TargetSource !== Ctx.Source) {
    const TargetState = State.Get(TargetSource);
    if (
      TargetState === null ||
      TargetState.Phase !== 'Spawned' ||
      TargetState.CharacterID === null
    ) {
      return { Outcome: 'BadArgs', Reason: `Player ${TargetSource} is not in the world.` };
    }
    TargetCharacterID = TargetState.CharacterID;
    const IssuerCoord = Inventory.ReadPedCoord(Ctx.Source);
    const TargetCoord = Inventory.ReadPedCoord(TargetSource);
    if (IssuerCoord === null || TargetCoord === null) {
      return { Outcome: 'BadArgs', Reason: 'Target is not reachable.' };
    }
    // Different routing bucket = different world; overlapping coords
    // across instanced interiors must not pass the proximity gate.
    // The distance wording avoids leaking the instancing OOC.
    if (IssuerCoord.World !== TargetCoord.World) {
      return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
    }
    const Dx = IssuerCoord.X - TargetCoord.X;
    const Dy = IssuerCoord.Y - TargetCoord.Y;
    const Dz = IssuerCoord.Z - TargetCoord.Z;
    if (Dx * Dx + Dy * Dy + Dz * Dz > BreathTestRangeMeters * BreathTestRangeMeters) {
      return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
    }
  }
  // The subject validated - the device cooldown starts only now, so a
  // typo'd player ID or an out-of-range subject never burns the wait.
  if (ItemTypeID !== undefined) Inventory.StampUseCooldown(Ctx.Source, ItemTypeID);
  const Percent = await Alcohol.ReadBacPercent(TargetCharacterID);
  const Body =
    TargetSource === Ctx.Source
      ? 'breathes into a breathalyzer.'
      : `administers a breath test to ${Broadcaster.DisplayName(TargetSource) ?? 'someone'}.`;
  NametagActions.SetAction(Ctx.Source, Body);
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`The breathalyzer reads ${FormatBacPercent(Percent)} BAC.`),
  };
}

/**
 * Narcotics test-kit flow for `/item use <kit_slot> <target_slot>` on a
 * device declaring IsSampleTester. The second argument is a SLOT, not a
 * player - the kit reveals the hidden quality / purity of a drug in that
 * slot. The kit is reusable; its cooldown is stamped only on a valid
 * reading (a typo'd target or a non-drug slot never burns the wait), and
 * the analysis always floats above the user's head so it is never silent.
 */
async function RunSampleTest(
  Inventory: InventoryService,
  NametagActions: NametagActionService,
  Ctx: CommandContext,
  TargetArg: string | undefined,
  ItemTypeID: string | undefined,
): Promise<CommandResult> {
  const TargetSlot = ParseSlot(TargetArg);
  if (TargetSlot === null) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item use <kit_slot> <target_slot>' };
  }
  const Readout = await Inventory.ReadSampleReadout(Ctx.Source, TargetSlot);
  if (Readout.Outcome === 'NotFound') {
    return { Outcome: 'BadArgs', Reason: 'That target slot is empty.' };
  }
  if (Readout.Outcome === 'NotTestable') {
    return {
      Outcome: 'BadArgs',
      Reason: `The test kit only reads narcotics, not ${Readout.ItemName ?? 'that item'}.`,
    };
  }
  // The reading validated - stamp the kit cooldown now, gate-before-cost.
  if (ItemTypeID !== undefined) Inventory.StampUseCooldown(Ctx.Source, ItemTypeID);
  NametagActions.SetAction(Ctx.Source, 'tests a sample with a reagent kit.');
  const Lines: string[] = [
    ChatFormatter.Header(`Test result: ${Readout.ItemName ?? 'sample'}`, ChatColor.Header),
  ];
  if (Readout.Quality !== undefined) Lines.push(ChatFormatter.Label('Quality', Readout.Quality));
  if (Readout.Purity !== undefined) Lines.push(ChatFormatter.Label('Purity', `${Readout.Purity}%`));
  if (Readout.StrainType !== undefined) Lines.push(ChatFormatter.Label('Strain', Readout.StrainType));
  if (Readout.ThcPercent !== undefined) Lines.push(ChatFormatter.Label('THC', `${Readout.ThcPercent}%`));
  if (Readout.CbdPercent !== undefined) Lines.push(ChatFormatter.Label('CBD', `${Readout.CbdPercent}%`));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * Identity-document flow for `/item use <slot> [player_id]` on an item
 * declaring IsIdentityDocument. With no target the holder reads their own
 * card; with a target the card is shown to that nearby player. Presenting
 * is a voluntary IC identification, so the holder's LEGAL name is revealed
 * to the recipient even while masked - the float above the head, however,
 * stays mask-aware so bystanders learn only that an ID was shown. The
 * card serial is the document number minted on the item.
 */
function RunIdPresent(
  Inventory: InventoryService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  Runtimes: CharacterRuntimeService,
  Chat: ChatService,
  NametagActions: NametagActionService,
  Ctx: CommandContext,
  TargetArg: string | undefined,
  ItemTypeID: string | undefined,
  CardSerial: string | null,
): CommandResult {
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  const Holder = Runtimes.Get(Ctx.Source);
  const HolderName = Holder !== null ? `${Holder.FirstName} ${Holder.LastName}` : 'Unknown';
  const DocName = GetItemType(ItemTypeID ?? '')?.DisplayName ?? 'Identification';
  const Card = RenderIdCard(DocName, HolderName, CardSerial);

  // No target (or self) - the holder reads their own card. Nothing is
  // sent to anyone else, so no cooldown is stamped.
  if (TargetArg === undefined) return { Outcome: 'Ok', Reply: Card };
  const Parsed = Number(TargetArg);
  if (!Number.isFinite(Parsed) || !Number.isInteger(Parsed) || Parsed <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item use <slot> [player_id]' };
  }
  const TargetSource = Parsed;
  if (TargetSource === Ctx.Source) return { Outcome: 'Ok', Reply: Card };

  const TargetState = State.Get(TargetSource);
  if (TargetState === null || TargetState.Phase !== 'Spawned' || TargetState.CharacterID === null) {
    return { Outcome: 'BadArgs', Reason: `Player ${TargetSource} is not in the world.` };
  }
  const IssuerCoord = Inventory.ReadPedCoord(Ctx.Source);
  const TargetCoord = Inventory.ReadPedCoord(TargetSource);
  if (IssuerCoord === null || TargetCoord === null) {
    return { Outcome: 'BadArgs', Reason: 'Target is not reachable.' };
  }
  if (IssuerCoord.World !== TargetCoord.World) {
    return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
  }
  const Dx = IssuerCoord.X - TargetCoord.X;
  const Dy = IssuerCoord.Y - TargetCoord.Y;
  const Dz = IssuerCoord.Z - TargetCoord.Z;
  if (Dx * Dx + Dy * Dy + Dz * Dz > HandoverRangeMeters * HandoverRangeMeters) {
    return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
  }
  // The recipient validated - stamp the cooldown, narrate, hand the card
  // over. The recipient sees the legal name; bystanders see only the act.
  if (ItemTypeID !== undefined) Inventory.StampUseCooldown(Ctx.Source, ItemTypeID);
  const TargetName = Broadcaster.DisplayName(TargetSource) ?? 'someone';
  NametagActions.SetAction(Ctx.Source, `shows identification to ${TargetName}.`);
  Chat.SendTo(TargetSource, Card);
  return {
    Outcome: 'Ok',
    Reply: ChatFormatter.Info(`You present your ${DocName.toLowerCase()} to ${TargetName}.`),
  };
}

/** Framed identity card shared by the self-read and the recipient copy. */
function RenderIdCard(DocName: string, HolderName: string, Serial: string | null): string {
  const Lines: string[] = [
    ChatFormatter.Header(DocName, ChatColor.Header),
    ChatFormatter.Label('Name', HolderName),
  ];
  if (Serial !== null) Lines.push(ChatFormatter.Label('Number', Serial));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * `/item inspect <slot>` - read the detail card for a carried item.
 *
 * Shows only what the item's type declares visible, with the viewer
 * resolved for OwnerOnly fields - inspecting someone else's phone must
 * not read out its number. Hidden potency metadata stays hidden here by
 * design; the narcotics test kit is the purpose-built device for that.
 */
async function HandleInspect(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  if (Slot === null) return { Outcome: 'BadArgs', Reason: 'Usage: /item inspect <slot>' };
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  if (!Inventory.TryConsumeReadToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Inv = await Inventory.GetInventoryForCharacter(Ctx.PlayerState.CharacterID);
  const Items = await Inventory.ListItems(Inv.ID);
  const Row = Items.find((R) => R.SlotIndex === Slot);
  if (Row === undefined) return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
  const Type = GetItemType(Row.ItemTypeID);
  if (Type === undefined) return { Outcome: 'BadArgs', Reason: 'Unknown item type.' };
  return { Outcome: 'Ok', Reply: RenderInspectionCard(Row, Type.ID, Ctx.PlayerState.CharacterID) };
}

/**
 * `/item drop <slot> [amount]` - move items from a slot onto the ground
 * as a world drop others can see and take.
 *
 * Defaults to one unit rather than the whole stack, the opposite of
 * `/aitem remove`: dropping is a roleplay action a player may want to
 * repeat deliberately, and dumping an entire stack of cash by omitting an
 * argument would be an expensive surprise.
 *
 * `NotDroppable` is a type-level refusal - permanent items and fixture
 * evidence cannot be discarded this way.
 */
async function HandleDrop(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  const Amount = Sub[1] === undefined ? 1 : ParseInt(Sub[1]);
  if (Slot === null || Amount === null || Amount <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item drop <slot> [amount]' };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Result = await Inventory.DropToGround(Ctx.Source, Slot, Amount);
  switch (Result.Outcome) {
    case 'Ok':
      return { Outcome: 'Ok', Reply: ChatFormatter.Info('You dropped the item.') };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'That slot is empty.' };
    case 'NotDroppable':
      return { Outcome: 'BadArgs', Reason: 'This item type cannot be dropped.' };
    case 'NotEnoughQuantity':
      return { Outcome: 'BadArgs', Reason: 'Not enough in that stack.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Drop failed (${Result.Outcome}).`,
      };
  }
}

/**
 * `/item pickup [drop_id]` - take a ground drop into the inventory.
 *
 * With no argument it resolves the nearest drop in reach, which is the
 * common case; an explicit id disambiguates a pile. Either way the
 * service re-checks range at pickup time, so the resolved id is a
 * convenience rather than an authorisation - a player cannot pass the id
 * of a drop across the map and have it teleport to them.
 *
 * The rate-limit token is spent before resolution, so scanning for the
 * nearest drop costs the same as naming one.
 */
async function HandlePickup(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  let DropID: string;
  const Arg = Sub[0];
  if (Arg === undefined) {
    const Listing = await Inventory.ListNearGround(Ctx.Source);
    const Nearest = Listing.Outcome === 'Ok' ? Listing.Drops?.[0] : undefined;
    if (Nearest === undefined) {
      return { Outcome: 'BadArgs', Reason: 'No drops in range.' };
    }
    DropID = String(Nearest.Drop.ID);
  } else if (/^\d+$/.test(Arg)) {
    DropID = Arg;
  } else {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item pickup [drop_id]' };
  }
  const Result = await Inventory.PickupDrop(Ctx.Source, DropID);
  switch (Result.Outcome) {
    case 'Ok':
      return { Outcome: 'Ok', Reply: ChatFormatter.Info('You picked up the item.') };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'That drop is no longer there.' };
    case 'OutOfSlots':
      return { Outcome: 'BadArgs', Reason: 'Your inventory is full.' };
    case 'OverWeight':
      return { Outcome: 'BadArgs', Reason: 'Too heavy to carry.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Pickup failed (${Result.Outcome}).`,
      };
  }
}

/**
 * `/item nearby` - list ground drops in reach with their distance.
 *
 * A read, so it spends a read token rather than a mutation token. The
 * printed `#id` is exactly what `/item pickup <id>` expects, which is why
 * the world label's trailing `[ID: n]` is stripped and lifted to the
 * front - the same number should not appear twice in one line.
 */
async function HandleNearby(
  Inventory: InventoryService,
  Ctx: CommandContext,
): Promise<CommandResult> {
  if (!Inventory.TryConsumeReadToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Result = await Inventory.ListNearGround(Ctx.Source);
  if (Result.Outcome !== 'Ok' || Result.Drops === undefined || Result.Drops.length === 0) {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info('No items on the ground nearby.') };
  }
  const Lines: string[] = [ChatFormatter.Header('Nearby Items', ChatColor.Header)];
  for (const Entry of Result.Drops) {
    // The world label embeds the ID for at-distance reading; in chat
    // we lift the ID to the prefix and strip the suffix so
    // `/item pickup <id>` reads off the visible number.
    const StrippedLabel = Entry.Label.replace(/\s*\[ID:\s*\d+\]\s*$/, '');
    Lines.push(
      `#${Entry.Drop.ID}: ${StrippedLabel} (${Entry.DistanceMeters.toFixed(1)}m)`,
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * `/item examine [drop_id]` - read a ground drop's card without
 * picking it up; defaults to the nearest drop in reach. The
 * close-range counterpart to the at-distance world label: the label
 * deliberately carries no metadata, while kneeling beside the drop
 * reads whatever the type declares visible (a blood pool's type, a
 * casing's stamped serial). This is the surface that makes fixture
 * evidence - which refuses pickup - readable at all. Examining
 * always floats above the examiner's head: forensics happen in
 * front of witnesses, never silently.
 */
async function HandleExamine(
  Inventory: InventoryService,
  NametagActions: NametagActionService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  if (!Inventory.TryConsumeReadToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Listing = await Inventory.ListNearGround(Ctx.Source);
  if (Listing.Outcome !== 'Ok' || Listing.Drops === undefined) {
    return { Outcome: 'BadArgs', Reason: 'Nothing within reach to examine.' };
  }
  const Arg = Sub[0];
  let Entry: (typeof Listing.Drops)[number] | undefined;
  if (Arg === undefined) {
    Entry = Listing.Drops[0];
  } else if (/^\d+$/.test(Arg)) {
    Entry = Listing.Drops.find((D) => String(D.Drop.ID) === Arg);
  } else {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item examine [drop_id]' };
  }
  if (Entry === undefined || Entry.DistanceMeters > PickupRangeMeters) {
    return { Outcome: 'BadArgs', Reason: 'Nothing within reach to examine.' };
  }
  const Drop = Entry.Drop;
  const Type = GetItemType(Drop.ItemTypeID);
  const Display = Type?.DisplayName ?? Drop.ItemTypeID;

  const Lines: string[] = [
    ChatFormatter.Header('Examine', ChatColor.Header),
    ChatFormatter.Label('Type', Display),
  ];
  if (Drop.CustomName !== null) Lines.push(ChatFormatter.Label('Name', Drop.CustomName));
  if (Type !== undefined) Lines.push(ChatFormatter.Label('Category', Type.Category));
  const Cents =
    Drop.StackQuantity !== null ? CurrencyCents(Drop.ItemTypeID, Drop.StackQuantity) : null;
  if (Cents !== null) {
    Lines.push(ChatFormatter.Label('Value', FormatCashCents(Cents)));
  } else if (Drop.StackQuantity !== null && Drop.StackQuantity > 1) {
    Lines.push(ChatFormatter.Label('Quantity', String(Drop.StackQuantity)));
  }
  // A serial on the ground follows the type's declared scope, with
  // OwnerOnly resolved against the examiner - a dropped phone does
  // not read its number out to a stranger.
  if (Drop.UniqueSerial !== null) {
    const Scope = Type?.SerialVisibility;
    const IsOwner =
      Drop.BoundCharacterID !== null && Drop.BoundCharacterID === Ctx.PlayerState.CharacterID;
    const ShowSerial = Scope === 'OwnerOnly' ? IsOwner : Scope !== 'Never';
    if (ShowSerial) Lines.push(ChatFormatter.Label('Serial', Drop.UniqueSerial));
  }
  Lines.push(...RenderVisibleMetadataLines(Drop.MetadataJson, Type));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));

  NametagActions.SetAction(Ctx.Source, `examines the ${Display.toLowerCase()}.`);
  return { Outcome: 'Ok', Reply: Lines.join('\n') };
}

/**
 * `/item give <player_id> <slot> [amount]` - hand an item to another
 * player in reach.
 *
 * The most guarded command in the cluster, because it is the one that
 * moves property between people. After the arguments parse, five gates
 * run before any mutation, in this order. The target:
 *
 *   1. must not be the issuer;
 *   2. must be a spawned character;
 *   3. must have a readable ped coordinate (both sides) - refuses with
 *      "not reachable", which is the streaming/desync case, not a
 *      distance one;
 *   4. must share a routing bucket;
 *   5. must be within HandoverRangeMeters.
 *
 * Gates 4 and 5 deliberately share the "not close enough" wording -
 * telling a player they are in a different instance would leak the
 * instancing layer into IC space.
 *
 * The mutation-rate token is taken only after all five pass, so a
 * refused give does not spend the issuer's budget.
 *
 * Range is compared squared to avoid the square root, matching the
 * convention used across the proximity paths.
 *
 * The transfer itself is one transactional TransferItem rather than a
 * remove followed by an add, so the item can never exist in both
 * inventories or neither - see the InventoryService header.
 */
async function HandleGive(
  Inventory: InventoryService,
  State: PlayerStateService,
  Broadcaster: ProximityBroadcaster,
  NametagActions: NametagActionService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const TargetID = Number(Sub[0]);
  const Slot = ParseSlot(Sub[1]);
  const Amount = Sub[2] === undefined ? 1 : ParseInt(Sub[2]);
  if (
    !Number.isFinite(TargetID) ||
    !Number.isInteger(TargetID) ||
    Slot === null ||
    Amount === null ||
    Amount <= 0
  ) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item give <player_id> <slot> [amount]' };
  }
  if (TargetID === Ctx.Source) return { Outcome: 'BadArgs', Reason: 'Cannot give to yourself.' };
  const TargetState = State.Get(TargetID);
  if (
    TargetState === null ||
    TargetState.Phase !== 'Spawned' ||
    TargetState.CharacterID === null
  ) {
    return { Outcome: 'BadArgs', Reason: `Player ${TargetID} is not in the world.` };
  }
  const IssuerCoord = Inventory.ReadPedCoord(Ctx.Source);
  const TargetCoord = Inventory.ReadPedCoord(TargetID);
  if (IssuerCoord === null || TargetCoord === null) {
    return { Outcome: 'BadArgs', Reason: 'Target is not reachable.' };
  }
  // Different routing bucket = different world; mirror PickupDrop's
  // cross-world refusal without leaking the instancing OOC.
  if (IssuerCoord.World !== TargetCoord.World) {
    return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
  }
  const Dx = IssuerCoord.X - TargetCoord.X;
  const Dy = IssuerCoord.Y - TargetCoord.Y;
  const Dz = IssuerCoord.Z - TargetCoord.Z;
  if (Dx * Dx + Dy * Dy + Dz * Dz > HandoverRangeMeters * HandoverRangeMeters) {
    return { Outcome: 'BadArgs', Reason: 'Target is not close enough.' };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  const FromInv = await Inventory.GetInventoryForCharacter(Ctx.PlayerState.CharacterID);
  const ToInv = await Inventory.GetInventoryForCharacter(TargetState.CharacterID);
  const Result = await Inventory.TransferItem(FromInv.ID, Slot, ToInv.ID, Amount, {
    ActorSource: Ctx.Source,
    ActorCharacterID: Ctx.PlayerState.CharacterID,
    Reason: 'IC handover',
    TargetCharacterID: TargetState.CharacterID,
  });
  switch (Result.Outcome) {
    case 'Ok': {
      const TargetName = Broadcaster.DisplayName(TargetID) ?? 'someone';
      NametagActions.SetAction(Ctx.Source, `gives something to ${TargetName}.`);
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`You gave the item to ${TargetName}.`),
      };
    }
    case 'NotTradeable':
      return { Outcome: 'BadArgs', Reason: 'This item type cannot be given to others.' };
    case 'NotEnoughQuantity':
      return { Outcome: 'BadArgs', Reason: 'Not enough in that stack.' };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
    case 'OutOfSlots':
      return { Outcome: 'BadArgs', Reason: "Recipient's inventory is full." };
    case 'OverWeight':
      return { Outcome: 'BadArgs', Reason: 'Too heavy for the recipient.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Give failed (${Result.Outcome}).`,
      };
  }
}

/**
 * `/item move <from> <to> [amount]` - reorganise within one inventory.
 *
 * Omitting the amount moves the whole stack; supplying one splits off
 * part of it into the destination, merging if the target slot holds a
 * compatible stack. Purely a rearrangement - nothing enters or leaves the
 * inventory, so no weight or capacity check applies beyond the target
 * stack's own ceiling.
 */
async function HandleMove(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const From = ParseSlot(Sub[0]);
  const To = ParseSlot(Sub[1]);
  const Amount = Sub[2] === undefined ? undefined : ParseInt(Sub[2]);
  if (From === null || To === null || Amount === null || (Amount !== undefined && Amount <= 0)) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item move <from_slot> <to_slot> [amount]' };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  const Inv = await Inventory.GetInventoryForCharacter(Ctx.PlayerState.CharacterID);
  const Result = await Inventory.MoveItem(Inv.ID, From, To, Amount);
  switch (Result.Outcome) {
    case 'Ok':
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(
          Amount === undefined
            ? `Moved slot ${From + 1} to slot ${To + 1}.`
            : `Moved ${Result.MovedCount ?? Amount} from slot ${From + 1} to slot ${To + 1}.`,
        ),
      };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
    case 'SlotOccupied':
      return { Outcome: 'BadArgs', Reason: 'The target slot is occupied.' };
    case 'NotEnoughQuantity':
      return { Outcome: 'BadArgs', Reason: 'Not enough in that stack.' };
    case 'InvalidQuantity':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'Cannot move that quantity.' };
    case 'OutOfSlots':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'Slot index out of range.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Move failed (${Result.Outcome}).`,
      };
  }
}

/**
 * `/item split <slot> <amount>` - break part of a stack into the first
 * free slot.
 *
 * The destination is chosen by the service rather than named by the
 * player, which is what distinguishes this from `/item move` with an
 * amount; the reply reports where it landed. Fails with `OutOfSlots`
 * when the inventory is full, since a split needs somewhere to go.
 */
async function HandleSplit(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  const Amount = ParseInt(Sub[1]);
  if (Slot === null || Amount === null || Amount <= 0) {
    return { Outcome: 'BadArgs', Reason: 'Usage: /item split <slot> <amount>' };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  const Inv = await Inventory.GetInventoryForCharacter(Ctx.PlayerState.CharacterID);
  const Result = await Inventory.SplitStack(Inv.ID, Slot, Amount);
  switch (Result.Outcome) {
    case 'Ok':
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`Split ${Amount} into slot ${(Result.ToSlot ?? 0) + 1}.`),
      };
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: 'That slot is empty.' };
    case 'OutOfSlots':
      return { Outcome: 'BadArgs', Reason: 'No free slot to split into.' };
    case 'InvalidQuantity':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'Cannot split that quantity.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Split failed (${Result.Outcome}).`,
      };
  }
}

/**
 * `/item equip <slot>` - draw the weapon in a slot.
 *
 * Spends no rate-limit token: equipping writes the authoritative
 * EquippedBags entry and hands the weapon to the ped, but does not create
 * or move any item, so it is not a mutation in the ledger sense. The
 * service serialises it under the inventory lock regardless.
 */
async function HandleEquip(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  if (Slot === null) return { Outcome: 'BadArgs', Reason: 'Usage: /item equip <slot>' };
  const Result = await Inventory.EquipWeapon(Ctx.Source, Slot);
  if (Result.Outcome === 'Ok') {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info('Weapon equipped.') };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Equip failed (${Result.Outcome}).`,
  };
}

/** `/item unequip` - holster the currently drawn weapon. */
async function HandleUnequip(
  Inventory: InventoryService,
  Ctx: CommandContext,
): Promise<CommandResult> {
  const Result = await Inventory.UnequipWeapon(Ctx.Source);
  if (Result.Outcome === 'Ok') {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info('Weapon unequipped.') };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Unequip failed (${Result.Outcome}).`,
  };
}

/**
 * `/item reload` - feed rounds from carried ammunition into the equipped
 * weapon's magazine.
 *
 * Consumes real ammunition items, so the reply reports both how many
 * rounds were spent and the resulting magazine count - a partial reload
 * (not enough carried) succeeds with a smaller number rather than
 * refusing.
 */
async function HandleReload(
  Inventory: InventoryService,
  Ctx: CommandContext,
): Promise<CommandResult> {
  const Result = await Inventory.Reload(Ctx.Source);
  if (Result.Outcome === 'Ok') {
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info(
        `Reloaded - ${Result.Consumed ?? 0} rounds. Magazine: ${Result.NewTotal ?? 0}.`,
      ),
    };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Reload failed (${Result.Outcome}).`,
  };
}

/**
 * `/item attach <component_slot> <weapon_slot>` - fit an attachment to a
 * weapon.
 *
 * Argument order is component-first, mirroring the physical action of
 * bringing a part to the gun. The component leaves the inventory and
 * lives on the weapon's row until detached; the pairing is validated
 * against the catalog, so a suppressor cannot be fitted to a weapon that
 * does not accept one.
 */
async function HandleAttach(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const ComponentSlot = ParseSlot(Sub[0]);
  const WeaponSlot = ParseSlot(Sub[1]);
  if (ComponentSlot === null || WeaponSlot === null) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /item attach <component_slot> <weapon_slot>',
    };
  }
  const Result = await Inventory.AttachComponent(Ctx.Source, ComponentSlot, WeaponSlot);
  if (Result.Outcome === 'Ok') {
    return { Outcome: 'Ok', Reply: ChatFormatter.Info('Component attached.') };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Attach failed (${Result.Outcome}).`,
  };
}

/**
 * `/item detach <weapon_slot> <attachment_slot>` - remove a fitted
 * component back into the inventory.
 *
 * Takes the attachment *kind* rather than an inventory slot, because the
 * component is on the weapon and has no inventory slot to name while
 * fitted. The reply reports which slot it returned to, since the service
 * picks the first free one.
 */
async function HandleDetach(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const WeaponSlot = ParseSlot(Sub[0]);
  const SlotArg = Sub[1];
  if (WeaponSlot === null || SlotArg === undefined) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /item detach <weapon_slot> <Magazine|Sight|Muzzle|Grip|Flashlight|Barrel|Skin>',
    };
  }
  const SlotEnum = NormaliseAttachmentSlot(SlotArg);
  if (SlotEnum === null) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Slot must be one of: Magazine, Sight, Muzzle, Grip, Flashlight, Barrel, Skin.',
    };
  }
  const Result = await Inventory.DetachComponent(Ctx.Source, WeaponSlot, SlotEnum);
  if (Result.Outcome === 'Ok') {
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info(
        `Component returned to slot ${(Result.DetachedSlot ?? 0) + 1}.`,
      ),
    };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Detach failed (${Result.Outcome}).`,
  };
}

/**
 * Shared implementation of `/item rename` and `/item describe`.
 *
 * `clear` removes existing text immediately; anything else is submitted
 * to the staff review queue rather than applied. Custom text is visible
 * to everyone who inspects the item, so it is moderated on the way in -
 * the player is told it was submitted, not that it took effect.
 */
async function HandleNameKind(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
  Kind: 'Name' | 'Description',
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  const Text = Sub.slice(1).join(' ');
  const ParentVerb = Kind === 'Name' ? 'rename' : 'describe';
  const Noun = Kind === 'Name' ? 'name' : 'description';
  if (Slot === null || Text.length === 0) {
    return { Outcome: 'BadArgs', Reason: `Usage: /item ${ParentVerb} <slot> <text|clear>` };
  }
  if (Text.toLowerCase() === 'clear') {
    const Result = await Inventory.ClearCustomName(Ctx.Source, Slot, Kind);
    if (Result.Outcome === 'Ok') {
      return { Outcome: 'Ok', Reply: ChatFormatter.Info(`Custom ${Noun} cleared.`) };
    }
    return {
      Outcome: 'BadArgs',
      Reason: Result.Detail ?? `Clear failed (${Result.Outcome}).`,
    };
  }
  const Result = await Inventory.SubmitNameRequest(Ctx.Source, Slot, Kind, Text);
  if (Result.Outcome === 'Ok') {
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info(
        `${Kind === 'Name' ? 'Name' : 'Description'} submitted for staff review.`,
      ),
    };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Submission failed (${Result.Outcome}).`,
  };
}

/**
 * `/item removeserial <slot>` - ask staff to file the serial off an item.
 *
 * Submits a request rather than acting, unlike the admin command of the
 * same name. Defacing destroys the forensic link that `/aitem traceweapon`
 * depends on, so it stays behind human review; the player is told it was
 * submitted, not that it was done.
 */
async function HandleRemoveSerial(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Slot = ParseSlot(Sub[0]);
  if (Slot === null) return { Outcome: 'BadArgs', Reason: 'Usage: /item removeserial <slot>' };
  const Result = await Inventory.SubmitDefaceRequest(Ctx.Source, Slot);
  if (Result.Outcome === 'Ok') {
    return {
      Outcome: 'Ok',
      Reply: ChatFormatter.Info('Serial-removal request submitted for staff review.'),
    };
  }
  return {
    Outcome: 'BadArgs',
    Reason: Result.Detail ?? `Serial-removal request failed (${Result.Outcome}).`,
  };
}

// ── /container handlers ────────────────────────────────────────────────

/**
 * `/container info <slot>` - list a container's contents. Same manifest
 * renderer as `/inventory <slot>`; the two spellings exist so the command
 * is discoverable from either parent.
 */
async function HandleContainerInfo(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  return ShowManifest(Inventory, Ctx, Sub[0]);
}

/**
 * `/container store <from> <container> [inner]` - put an item into a
 * container.
 *
 * The inner slot is optional; omitting it lets the service pick the first
 * free slot inside. A container is a separate inventory row, so this is a
 * cross-inventory move and takes both locks in InventoryID order.
 */
async function HandleContainerStore(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const From = ParseSlot(Sub[0]);
  const Container = ParseSlot(Sub[1]);
  const Inner = Sub[2] === undefined ? null : ParseSlot(Sub[2]);
  if (From === null || Container === null) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /container store <from_slot> <container_slot> [inner_slot]',
    };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Result = await Inventory.MoveToContainer(
    Ctx.Source,
    From,
    Container,
    Inner ?? undefined,
  );
  return RenderMoveResult(Result, From, Inner === null ? undefined : Inner);
}

/**
 * `/container take <container> <inner> [to]` - pull an item out of a
 * container into the carried inventory.
 *
 * The mirror of `store`. The destination slot is optional for the same
 * reason the inner slot is there.
 *
 * Can fail on weight even though the item was already "carried" inside
 * the container. A container is its own inventory with its own capacity
 * (ContainerWeightGrams); what counts against the carrier is the
 * container item's fixed WeightGrams, not its contents. So pulling
 * something out genuinely adds weight the carrier was not paying before,
 * which is why the add runs AllOrNothing - a partial take would leave the
 * remainder destroyed rather than back in the bag.
 */
async function HandleContainerTake(
  Inventory: InventoryService,
  Ctx: CommandContext,
  Sub: string[],
): Promise<CommandResult> {
  const Container = ParseSlot(Sub[0]);
  const Inner = ParseSlot(Sub[1]);
  const To = Sub[2] === undefined ? null : ParseSlot(Sub[2]);
  if (Container === null || Inner === null) {
    return {
      Outcome: 'BadArgs',
      Reason: 'Usage: /container take <container_slot> <inner_slot> [to_slot]',
    };
  }
  if (!Inventory.TryConsumeMutationToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  const Result = await Inventory.MoveFromContainer(
    Ctx.Source,
    Container,
    Inner,
    To ?? undefined,
  );
  return RenderMoveResult(Result, Inner, To === null ? undefined : To);
}

// ── Shared helpers ─────────────────────────────────────────────────────

/**
 * Render either the carried inventory or one container's contents,
 * depending on whether a slot argument was supplied.
 *
 * Shared by `/inventory`, `/inventory <slot>` and `/container info`, so
 * all three produce an identical-looking manifest. Spends a read token.
 */
async function ShowManifest(
  Inventory: InventoryService,
  Ctx: CommandContext,
  ContainerArg: string | undefined,
): Promise<CommandResult> {
  if (Ctx.PlayerState.CharacterID === null) return { Outcome: 'RequiresCharacter' };
  if (!Inventory.TryConsumeReadToken(Ctx.Source)) {
    return { Outcome: 'OnCooldown', RemainingMs: 100 };
  }
  if (ContainerArg !== undefined) {
    const ContainerSlot = ParseSlot(ContainerArg);
    if (ContainerSlot === null) {
      return { Outcome: 'BadArgs', Reason: 'Slot must be a positive integer.' };
    }
    const Inner = await Inventory.GetContainerInventory(Ctx.Source, ContainerSlot);
    if (Inner === null) {
      return { Outcome: 'BadArgs', Reason: 'That slot is empty or not a container.' };
    }
    const Items = await Inventory.ListItems(Inner.ID);
    return {
      Outcome: 'Ok',
      Reply: RenderManifest(
        Inner.SlotCapacity,
        Number.parseFloat(Inner.WeightCapacityGrams),
        Items,
        `Container (slot ${ContainerSlot + 1})`,
      ),
    };
  }
  const Inv = await Inventory.GetInventoryForCharacter(Ctx.PlayerState.CharacterID);
  const Items = await Inventory.ListItems(Inv.ID);
  return {
    Outcome: 'Ok',
    Reply: RenderManifest(
      Inv.SlotCapacity,
      Number.parseFloat(Inv.WeightCapacityGrams),
      Items,
    ),
  };
}

/**
 * Turn a container move outcome into a player-facing reply, shared by
 * `store` and `take` so both refuse in the same words.
 *
 * The hints supply slot numbers for the success line when the service
 * chose the destination itself: `Result.ToSlot` wins when present,
 * falling back to the caller's requested slot.
 */
function RenderMoveResult(
  Result: { Outcome: string; ToSlot?: number; Detail?: string },
  FromHint: number,
  ToHint?: number,
): CommandResult {
  switch (Result.Outcome) {
    case 'Ok': {
      const To = Result.ToSlot ?? ToHint ?? 0;
      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(`Moved slot ${FromHint + 1} -> slot ${To + 1}.`),
      };
    }
    case 'NotFound':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'Slot empty.' };
    case 'OutOfSlots':
      return { Outcome: 'BadArgs', Reason: 'No free slot in the destination.' };
    case 'OverWeight':
      return { Outcome: 'BadArgs', Reason: 'Destination is over its weight cap.' };
    case 'ContainerNestingForbidden':
      return {
        Outcome: 'BadArgs',
        Reason: 'Containers cannot be placed inside other containers.',
      };
    case 'InvalidUse':
      return { Outcome: 'BadArgs', Reason: Result.Detail ?? 'Target is not a container.' };
    default:
      return {
        Outcome: 'BadArgs',
        Reason: Result.Detail ?? `Move failed (${Result.Outcome}).`,
      };
  }
}

/**
 * Case-insensitively resolve a player-typed attachment slot name to the
 * catalog enum, returning null for anything unrecognised so the caller
 * can list the valid names.
 */
function NormaliseAttachmentSlot(Raw: string): AttachmentSlot | null {
  const Norm = Raw.charAt(0).toUpperCase() + Raw.slice(1).toLowerCase();
  if (
    Norm === 'Magazine' ||
    Norm === 'Sight' ||
    Norm === 'Muzzle' ||
    Norm === 'Grip' ||
    Norm === 'Flashlight' ||
    Norm === 'Barrel' ||
    Norm === 'Skin'
  ) {
    return Norm;
  }
  return null;
}

/**
 * Render a slot listing with a weight/slot footer. Used for both the
 * carried inventory and container contents - the title is the only thing
 * that differs.
 *
 * Weight is summed from the rows rather than read from a stored total, so
 * the figure always matches what is listed above it.
 */
function RenderManifest(
  SlotCapacity: number,
  WeightCapacityGrams: number,
  Items: readonly InventoryItem[],
  Title: string = 'Inventory',
): string {
  const Lines: string[] = [ChatFormatter.Header(Title, ChatColor.Header)];
  if (Items.length === 0) {
    Lines.push(ChatFormatter.OOC('Empty.'));
  } else {
    let TotalWeight = 0;
    for (const Row of Items) {
      const Weight = Number.parseFloat(Row.WeightGrams);
      TotalWeight += Weight;
      Lines.push(RenderRow(Row));
    }
    Lines.push(ChatFormatter.Divider(ChatColor.Header));
    Lines.push(
      `${ChatFormatter.Label('Weight', `${FormatWeightGrams(TotalWeight)} / ${FormatWeightGrams(WeightCapacityGrams)}`)}`,
    );
    Lines.push(
      `${ChatFormatter.Label('Slots', `${Items.length} / ${SlotCapacity}`)}`,
    );
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * One manifest line: `Slot N: <name>[ xQty] [weight]`.
 *
 * Currency collapses to its dollar value instead of a unit count - a
 * player thinks in "$400", not "4 x $100 bill". A custom name (approved
 * through the `/item rename` review queue) is shown with the catalog name
 * in parentheses, so a renamed item can still be identified.
 */
function RenderRow(Row: InventoryItem): string {
  const Type = GetItemType(Row.ItemTypeID);
  const Display = Type?.DisplayName ?? Row.ItemTypeID;
  const SlotLabel = `Slot ${Row.SlotIndex + 1}`;
  const Weight = FormatWeightGrams(Number.parseFloat(Row.WeightGrams));

  const Cents =
    Row.StackQuantity !== null ? CurrencyCents(Row.ItemTypeID, Row.StackQuantity) : null;
  if (Cents !== null) {
    return `${SlotLabel}: ${Display} ${FormatCashCents(Cents)} [${Weight}]`;
  }
  const Custom = Row.CustomName !== null ? `${Row.CustomName} (${Display})` : Display;
  const Quantity =
    Row.StackQuantity !== null && Row.StackQuantity > 1 ? ` x${Row.StackQuantity}` : '';
  return `${SlotLabel}: ${Custom}${Quantity} [${Weight}]`;
}

/**
 * Build the inspection card for one item, filtered to the viewer.
 *
 * `ViewerCharacterID` is what resolves OwnerOnly serial visibility, so it
 * must be the *inspecting* character rather than the holder. Only keys
 * the type lists as visible are rendered; everything else in the metadata
 * blob stays out of the card.
 */
function RenderInspectionCard(
  Row: InventoryItem,
  ItemTypeID: string,
  ViewerCharacterID: string | null,
): string {
  const Type = GetItemType(ItemTypeID);
  const Lines: string[] = [
    ChatFormatter.Header('Inspect', ChatColor.Header),
    ChatFormatter.Label('Type', Type?.DisplayName ?? ItemTypeID),
  ];
  if (Row.CustomName !== null) Lines.push(ChatFormatter.Label('Name', Row.CustomName));
  if (Type !== undefined) Lines.push(ChatFormatter.Label('Category', Type.Category));
  const Cents =
    Row.StackQuantity !== null ? CurrencyCents(Row.ItemTypeID, Row.StackQuantity) : null;
  if (Cents !== null) {
    Lines.push(ChatFormatter.Label('Value', FormatCashCents(Cents)));
  } else if (Row.StackQuantity !== null && Row.StackQuantity > 1) {
    Lines.push(ChatFormatter.Label('Quantity', String(Row.StackQuantity)));
  }
  Lines.push(
    ChatFormatter.Label('Weight', FormatWeightGrams(Number.parseFloat(Row.WeightGrams))),
  );
  // OwnerOnly resolves against the inspecting character, mirroring
  // the ground examine card - a found phone never reveals its former
  // owner's number, even from inside the finder's own pockets.
  if (Row.UniqueSerial !== null) {
    const Scope = Type?.SerialVisibility;
    const IsOwner =
      Row.BoundCharacterID !== null && Row.BoundCharacterID === ViewerCharacterID;
    const ShowSerial = Scope === 'OwnerOnly' ? IsOwner : Scope !== 'Never';
    if (ShowSerial) Lines.push(ChatFormatter.Label('Serial', Row.UniqueSerial));
  }
  Lines.push(...RenderVisibleMetadataLines(Row.MetadataJson, Type));
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/**
 * Render a type's VisibleMetadataKeys out of a metadata JSON blob.
 * Shared by the self-inventory inspect card and the ground examine
 * card. Hidden keys (Purity, *Percent, IsForged, IsStolen) never
 * enter VisibleMetadataKeys, so both surfaces stay leak-free by
 * construction.
 */
function RenderVisibleMetadataLines(
  MetadataJson: string | null,
  Type: ItemTypeDefinition | undefined,
): string[] {
  if (MetadataJson === null || Type?.VisibleMetadataKeys === undefined) return [];
  const Lines: string[] = [];
  try {
    const Parsed = JSON.parse(MetadataJson) as Record<string, unknown>;
    for (const Key of Type.VisibleMetadataKeys) {
      const Value = Parsed[Key];
      if (Value === undefined || Value === null) continue;
      if (Key === 'LoadedAmmo' && Array.isArray(Value)) {
        const Segments = Value as Array<{ ItemTypeID: string; Qty: number }>;
        const Total = Segments.reduce((Acc, Seg) => Acc + (Seg.Qty ?? 0), 0);
        const MaxAmmo = Type.MaxAmmo ?? Total;
        Lines.push(ChatFormatter.Label('Loaded', `${Total} / ${MaxAmmo}`));
        for (const [I, Seg] of Segments.entries()) {
          const AmmoType = GetItemType(Seg.ItemTypeID);
          const Name = AmmoType?.DisplayName ?? Seg.ItemTypeID;
          const Tag = I === 0 ? ' [next to fire]' : '';
          Lines.push(`  - ${Name} x${Seg.Qty}${Tag}`);
        }
        continue;
      }
      if (Key === 'AttachedComponents' && Array.isArray(Value)) {
        const Comps = Value as Array<{ ItemTypeID: string; AttachmentSlot: string }>;
        if (Comps.length === 0) {
          Lines.push(ChatFormatter.Label('Attached', '<none>'));
        } else {
          Lines.push(ChatFormatter.Label('Attached', String(Comps.length)));
          for (const Comp of Comps) {
            const CompType = GetItemType(Comp.ItemTypeID);
            const Name = CompType?.DisplayName ?? Comp.ItemTypeID;
            Lines.push(`  - ${Comp.AttachmentSlot}: ${Name}`);
          }
        }
        continue;
      }
      const DisplayKey = Key === 'WeaponSerial' ? 'Serial' : Key;
      // Object values would render as '[object Object]' - show JSON instead.
      const Rendered =
        typeof Value === 'string' || typeof Value === 'number' || typeof Value === 'boolean'
          ? String(Value)
          : JSON.stringify(Value);
      Lines.push(ChatFormatter.Label(DisplayKey, Rendered));
    }
  } catch {
    // Malformed metadata - skip the visible-key render rather than
    // crash the render path.
  }
  return Lines;
}

/**
 * Parse a player-supplied slot number into a storage index.
 *
 * This is the single 1-based -> 0-based conversion point for the whole
 * cluster: chat says "slot 1", the service means index 0. Every handler
 * routes its slot argument through here so the offset is applied exactly
 * once - applying it twice, or forgetting it, silently targets the wrong
 * item.
 *
 * The regex rejects `-1`, `1.5` and `1e3` before parseInt gets a chance
 * to coerce them into something plausible.
 */
function ParseSlot(Arg: string | undefined): number | null {
  if (Arg === undefined) return null;
  if (!/^\d+$/.test(Arg)) return null;
  const N = Number.parseInt(Arg, 10);
  if (!Number.isFinite(N) || N <= 0) return null;
  return N - 1;
}

/**
 * Parse a non-negative integer argument (quantities, player ids) with the
 * same strict digits-only rule as ParseSlot, but no index conversion and
 * zero permitted.
 */
function ParseInt(Arg: string | undefined): number | null {
  if (Arg === undefined) return null;
  if (!/^\d+$/.test(Arg)) return null;
  const N = Number.parseInt(Arg, 10);
  return Number.isFinite(N) ? N : null;
}
