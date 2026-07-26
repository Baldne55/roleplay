/**
 * ============================================================================
 * SERVER COMPOSITION ROOT
 * ============================================================================
 *
 * Runs once at resource start. Wires the entire backend by hand - config,
 * database, repositories, services, commands, controllers - with no DI
 * container, so the dependency graph is exactly what is written here and
 * can be read top to bottom.
 *
 * ORDER IS LOAD-BEARING IN FOUR PLACES
 * Most of this file is order-independent, but these are not, and each is
 * marked inline where it occurs:
 *
 *   1. Config, then database, then repositories. Nothing above can be
 *      constructed without what precedes it.
 *   2. ChatController before CharacterController - the latter pushes a
 *      command list through the former immediately after spawn.
 *   3. AnticheatEventController after InventoryController, so its
 *      weaponDamageEvent sanity hook registers alongside the forensic
 *      hook rather than ahead of it, and AnticheatController after that.
 *   4. PlayerSessionService LAST among controllers. It owns the single
 *      `playerDropped` registration and every per-Source teardown target
 *      is injected into it, so all of them must already exist.
 *
 * TEARDOWN IS CENTRALISED, NOT DISTRIBUTED
 * Individual services do not register their own disconnect handlers.
 * PlayerSessionService holds the one registration and evicts each cache
 * in a documented order. A service that caches per-Source state must be
 * added to that constructor, or it leaks for the process lifetime and
 * a reconnecting player can inherit a previous occupant's state.
 *
 * THE `void _X` PATTERN
 * Controllers are built purely for their side effects - each registers
 * its own net-event handlers and ticks from its constructor and is then
 * never referenced. The bindings and their `void` statements exist so the
 * list reads as a list and neither the compiler nor eslint flags the
 * unused names. Dropping a controller from here silently disables that
 * whole feature; nothing would notice the omission.
 *
 * Long-running loops are started explicitly rather than self-arming in
 * their constructors, so this file is the complete list of what runs on a
 * timer. Six of them, in construction order: the position validator, the
 * injury watchdog, the anti-cheat scanner, the addiction sweep, the
 * bleeding driver, and the radio possession sweep.
 */
import { Logger } from '@/Util/Logger.js';
import { LoadServerConfig } from '@/Infrastructure/Config/ServerConfig.js';
import { CreateSequelize } from '@/Data/Database.js';
import { Account } from '@/Data/Models/Account.js';
import { Character } from '@/Data/Models/Character.js';
import { CharacterOutfit } from '@/Data/Models/CharacterOutfit.js';
import { Inventory as InventoryModel } from '@/Data/Models/Inventory.js';
import { InventoryItem } from '@/Data/Models/InventoryItem.js';
import { InventoryMutationLog } from '@/Data/Models/InventoryMutationLog.js';
import { GroundDrop } from '@/Data/Models/GroundDrop.js';
import { WeaponDischargeLog } from '@/Data/Models/WeaponDischargeLog.js';
import { ItemNameRequest } from '@/Data/Models/ItemNameRequest.js';
import { AnticheatViolation } from '@/Data/Models/AnticheatViolation.js';
import { CharacterAddiction } from '@/Data/Models/CharacterAddiction.js';
import { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import { CharacterOutfitRepository } from '@/Data/Repositories/CharacterOutfitRepository.js';
import { InventoryRepository } from '@/Data/Repositories/InventoryRepository.js';
import { InventoryMutationLogRepository } from '@/Data/Repositories/InventoryMutationLogRepository.js';
import { GroundDropRepository } from '@/Data/Repositories/GroundDropRepository.js';
import { WeaponDischargeLogRepository } from '@/Data/Repositories/WeaponDischargeLogRepository.js';
import { ItemNameRequestRepository } from '@/Data/Repositories/ItemNameRequestRepository.js';
import { AnticheatViolationRepository } from '@/Data/Repositories/AnticheatViolationRepository.js';
import { CharacterAddictionRepository } from '@/Data/Repositories/CharacterAddictionRepository.js';
import { PhoneLogRepository } from '@/Data/Repositories/PhoneLogRepository.js';
import { QueueService } from '@/Infrastructure/Queue/QueueService.js';
import { HttpRouter } from '@/Infrastructure/HTTP/HttpRouter.js';
import { PlayerStateService } from '@/Services/PlayerStateService.js';
import { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import { DiscordService } from '@/Services/DiscordService.js';
import { DiscordWebhookService } from '@/Services/DiscordWebhookService.js';
import { AnticheatService } from '@/Services/AnticheatService.js';
import { AnticheatScannerService } from '@/Services/AnticheatScannerService.js';
import { NoClipService } from '@/Services/NoClipService.js';
import { AccountService } from '@/Services/AccountService.js';
import { AccountSessionService } from '@/Services/AccountSessionService.js';
import { ForensicIDService } from '@/Services/ForensicIDService.js';
import { CharacterService } from '@/Services/CharacterService.js';
import { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import { PositionValidatorService } from '@/Services/PositionValidatorService.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import { ChatService } from '@/Services/ChatService.js';
import { ChatRateLimiter } from '@/Services/ChatRateLimiter.js';
import { ProximityBroadcaster } from '@/Services/ProximityBroadcaster.js';
import { PrivateMessageStore } from '@/Services/PrivateMessageStore.js';
import { InjuryService } from '@/Services/InjuryService.js';
import { BleedingService } from '@/Services/BleedingService.js';
import { AsyncLock } from '@/Services/AsyncLock.js';
import { IdentifierService } from '@/Services/IdentifierService.js';
import { InventoryService } from '@/Services/InventoryService.js';
import { CashService } from '@/Services/CashService.js';
import { AlcoholService } from '@/Services/AlcoholService.js';
import { AddictionService } from '@/Services/AddictionService.js';
import { RadioService } from '@/Services/RadioService.js';
import { PhoneService } from '@/Services/PhoneService.js';
import { PhoneCallService } from '@/Services/PhoneCallService.js';
import { NametagActionService } from '@/Services/NametagActionService.js';
import { ProximityNetBroadcaster } from '@/Services/ProximityNetBroadcaster.js';
import { AccountSettingsService } from '@/Services/AccountSettingsService.js';
import { PlayerSessionService } from '@/Services/PlayerSessionService.js';
import * as CoreCommands from '@/Commands/CoreCommands.js';
import * as SessionCommands from '@/Commands/SessionCommands.js';
import * as SpeechCommands from '@/Commands/SpeechCommands.js';
import * as DirectedSpeechCommands from '@/Commands/DirectedSpeechCommands.js';
import * as RoleplayActionCommands from '@/Commands/RoleplayActionCommands.js';
import * as NametagActionCommands from '@/Commands/NametagActionCommands.js';
import * as PrivateMessageCommands from '@/Commands/PrivateMessageCommands.js';
import * as LookupCommands from '@/Commands/LookupCommands.js';
import * as VehicleChatCommands from '@/Commands/VehicleChatCommands.js';
import * as GlobalOocCommand from '@/Commands/GlobalOocCommand.js';
import * as ChatUtilityCommands from '@/Commands/ChatUtilityCommands.js';
import * as AdminDutyCommands from '@/Commands/AdminDutyCommands.js';
import * as RandomCommands from '@/Commands/RandomCommands.js';
import * as InjuryCommands from '@/Commands/InjuryCommands.js';
import * as NoClipCommand from '@/Commands/NoClipCommand.js';
import * as AnticheatCommands from '@/Commands/AnticheatCommands.js';
import * as InventoryCommands from '@/Commands/InventoryCommands.js';
import * as AdminInventoryCommands from '@/Commands/AdminInventoryCommands.js';
import * as RadioCommands from '@/Commands/RadioCommands.js';
import * as PhoneCommands from '@/Commands/PhoneCommands.js';
import * as AdminPhoneCommands from '@/Commands/AdminPhoneCommands.js';
import { ConnectionController } from '@/Controllers/ConnectionController.js';
import { AccountController } from '@/Controllers/AccountController.js';
import { AuthController } from '@/Controllers/AuthController.js';
import { CharacterController } from '@/Controllers/CharacterController.js';
import { ChatController } from '@/Controllers/ChatController.js';
import { SettingsController } from '@/Controllers/SettingsController.js';
import { InjuryController } from '@/Controllers/InjuryController.js';
import { InventoryController } from '@/Controllers/InventoryController.js';
import { AnticheatEventController } from '@/Controllers/AnticheatEventController.js';
import { AnticheatController } from '@/Controllers/AnticheatController.js';

declare function RegisterCommand(
  Name: string,
  Handler: (Source: number, Args: string[], Raw: string) => void,
  Restricted: boolean,
): void;

const Log = Logger.New('Bootstrap');

Log.Info('Backend booting...');

const Config = LoadServerConfig();
Log.Info(`Config loaded (db=${Config.DBHost}:${Config.DBPort}/${Config.DBName}, guild=${Config.DiscordGuildID})`);

const Database = CreateSequelize(Config);
Database.addModels([
  Account,
  Character,
  CharacterOutfit,
  InventoryModel,
  InventoryItem,
  InventoryMutationLog,
  GroundDrop,
  WeaponDischargeLog,
  ItemNameRequest,
  AnticheatViolation,
  CharacterAddiction,
]);
Log.Info(
  'Sequelize ready (Account, Character, CharacterOutfit, Inventory, InventoryItem, ' +
    'InventoryMutationLog, GroundDrop, WeaponDischargeLog, ItemNameRequest, ' +
    'AnticheatViolation, CharacterAddiction models registered)',
);

const Accounts = new AccountRepository();
const Characters = new CharacterRepository();
const Outfits = new CharacterOutfitRepository();
const InventoryRepo = new InventoryRepository();
const MutationLogRepo = new InventoryMutationLogRepository();
const GroundDropRepo = new GroundDropRepository();
const DischargeLogRepo = new WeaponDischargeLogRepository();
const NameRequestRepo = new ItemNameRequestRepository();
const ViolationRepo = new AnticheatViolationRepository();
const AddictionRepo = new CharacterAddictionRepository();
const PhoneLogRepo = new PhoneLogRepository();

const State = new PlayerStateService();
const Routing = new RoutingBucketService();
const Queue = new QueueService();
const Sessions = new AccountSessionService();
const Discord = new DiscordService(Config);
const AccountSvc = new AccountService(Accounts);
const Forensic = new ForensicIDService();
const Runtimes = new CharacterRuntimeService();
const Validator = new PositionValidatorService();
Validator.Start();

const Commands = new CommandRegistry(State, Accounts);
CoreCommands.Register(Commands);
Log.Info(`Command registry ready - ${Commands.Size} command(s) registered`);

const Chat = new ChatService(State);
const ChatRateLimit = new ChatRateLimiter();
const Settings = new AccountSettingsService(Accounts);

// Anti-cheat pipeline. Constructed once the chat surface exists (staff
// alerts route through it); the position validator was already started
// above, so its violation sink attaches late rather than via constructor.
const Webhook = new DiscordWebhookService(Config);
const Anticheat = new AnticheatService(State, ViolationRepo, Webhook, Chat, Config);
Validator.SetViolationSink(Anticheat.HandlePositionViolation);

// Server-owned /noclip state. Holds the on/off bit plus the validator
// suspend and anti-cheat sanction in lockstep, so the session
// transitions (and playerDropped) can tear all three down together and
// a flight state can never leak across a character switch.
const NoClip = new NoClipService(Validator, Anticheat);

// Server-console smoke broadcaster. Restricted=true gates the slash path
// behind an ace; the source check belt-and-suspenders against any other
// console-routed invocation (source=0 is the FXServer console).
RegisterCommand(
  'chat:broadcast',
  (Source: number, Args: string[]): void => {
    if (Source !== 0) return;
    if (Args.length === 0) {
      Log.Info('chat:broadcast usage: chat:broadcast <message>');
      return;
    }
    Chat.BroadcastToSpawned(Args.join(' '));
  },
  true,
);

// IC/OOC chat surface. Broadcaster + PmStore are the two services the
// speech / action / pm / lookup clusters share; they have no inter-
// dependencies on the controllers below so they wire in here, right
// after Chat exists.
const Broadcaster = new ProximityBroadcaster(State, Runtimes, Chat);
const PmStore = new PrivateMessageStore();
// The /ame float channel (overhead action lines). Constructed ahead
// of InjuryService and the inventory cluster because both narrate
// their actions through it instead of chat - item interactions and
// involuntary tells (injury transitions, /helpup, withdrawal) alike.
const NametagActions = new NametagActionService(Broadcaster);
// InjuryService sits alongside the chat broadcaster: it still uses
// Broadcaster for display-name resolution and OOC toasts, while its
// IC action lines float via NametagActions. The IC-channel commands
// consult Runtimes via AssertHealthy so an incapacitated character
// can not speak. Constructed before the IC command registrations so
// the gate is in place from the first /say onwards.
const Injury = new InjuryService(
  State,
  Runtimes,
  Characters,
  Broadcaster,
  Chat,
  Validator,
  NametagActions,
);
// Server-side critical-HP watchdog (GetEntityHealth is apiset-server):
// backstops the client's HealthCritical emit against loss/suppression.
Injury.Start();

// Inventory cluster. Constructed after the chat / broadcaster surface
// (decision 7 - mutation narrations need both) and before
// CharacterService (decision 33's starter cash + ApplyOnSpawn paths).
// AsyncLock + IdentifierService are leaf services; InventoryService
// is the chokepoint for every mutation; CashService is the thin
// dollars-vs-cents wrapper around the `cash` item type.
const InventoryLock = new AsyncLock();
const Identifiers = new IdentifierService(InventoryRepo, GroundDropRepo);
const NetBroadcaster = new ProximityNetBroadcaster(State);
const Inventory = new InventoryService(
  InventoryRepo,
  MutationLogRepo,
  Identifiers,
  InventoryLock,
  State,
  Runtimes,
  Chat,
  Broadcaster,
  Database,
  GroundDropRepo,
  DischargeLogRepo,
  NetBroadcaster,
  NameRequestRepo,
  Anticheat,
  NametagActions,
);
const Cash = new CashService(Inventory, InventoryRepo, State);
// Blood-alcohol bookkeeping (lazy-decay Widmark model). Lives beside
// the cash facade rather than inside InventoryService because it
// needs the character repository; the drink hand-off happens in the
// command layer, same pattern as the bleeding relief.
const Alcohol = new AlcoholService(State, Characters, InventoryLock);
// Addiction ledger + withdrawal loop. Doses arrive from the command
// layer (drugs per use, alcohol per drink); the sweep arms after the
// scanner below so its drains register as sanctioned.
const Addiction = new AddictionService(State, Runtimes, NametagActions, AddictionRepo, InventoryLock);
const CharacterSvc = new CharacterService(
  Characters,
  Outfits,
  Forensic,
  Database,
  Cash,
);

// Per-player anti-cheat sweep: sits after the inventory cluster because
// its held-weapon check reads Inventory's equipped-weapon bag.
const Scanner = new AnticheatScannerService(State, Anticheat, Inventory);
Scanner.Start();
// InjuryService was constructed before the scanner existed, so its heal
// sink attaches late (same pattern as the validator's violation sink):
// every heal flow pre-emptively closes the target's GodModeHealth hit
// window instead of waiting on the in-sweep heal guard.
Injury.SetHealSink((Source) => Scanner.ClearHitWindow(Source));
// Same late-attach pattern for the inventory's consumable regen
// ticker: every sanctioned per-second HP rise registers against any
// open GodModeHealth hit window so the scanner attributes it instead
// of closing on a phantom heal.
Inventory.SetHpAdjustmentSink((Source, HpDelta) => Scanner.NoteServerHpAdjustment(Source, HpDelta));
// Server-authoritative armour movement (stimulant grants + comedown
// drains) shifts the GodModeHealth baseline directly - it lands in
// the server's own read, so there is no instruction to reconcile.
Inventory.SetArmourFactSink((Source, Delta) => Scanner.NoteServerCombinedFact(Source, Delta));
// Withdrawal drains are sanctioned client-instructed drops too.
Addiction.SetHpAdjustmentSink((Source, HpDelta) => Scanner.NoteServerHpAdjustment(Source, HpDelta));
Addiction.Start();

// Bleeding state machine. Trails the scanner because every sanctioned
// HP drain must shift the GodModeHealth baseline through it, and trails
// the inventory cluster because blood-splat evidence rides the ground-
// drop surface. Started alongside InjuryService's watchdog: the drip /
// drain / stumble scheduler and the splat TTL sweep arm here.
const Bleeding = new BleedingService(State, Runtimes, Characters, Inventory, Scanner, Chat);
Bleeding.Start();

// Handheld text-radio comms. Stateless beyond the per-character runtime
// it reads/writes through Runtimes; no client surface. The one tick is
// the possession sweep, which powers a radio down once its handset
// leaves the owner's inventory.
const Radio = new RadioService(Chat, State, Broadcaster, Runtimes, Inventory);
Radio.Start();

// Text phone. SMS / voicemail / contacts ride PhoneService; the live
// two-party call relay rides PhoneCallService (constructed in the call
// slice). Both read/write handset state through Inventory and the
// per-character active-phone pointer through Runtimes.
const Phone = new PhoneService(Chat, State, Runtimes, Inventory, PhoneLogRepo, Characters);
// Live two-party call relay + per-minute billing. Constructed before the
// speech commands so the /say relay hook can take it; evicted on
// disconnect / character switch by the character lifecycle.
const PhoneCall = new PhoneCallService(Chat, State, Runtimes, Inventory, PhoneLogRepo, Phone);

SpeechCommands.Register(Commands, Broadcaster, Runtimes, PhoneCall);
DirectedSpeechCommands.Register(Commands, Chat, State, Broadcaster, Accounts, Runtimes);
RoleplayActionCommands.Register(Commands, Broadcaster, Runtimes);
NametagActionCommands.Register(Commands, Broadcaster, Runtimes, NametagActions);
PrivateMessageCommands.Register(Commands, Chat, State, Broadcaster, PmStore, Accounts);
LookupCommands.Register(Commands, State, Broadcaster);
VehicleChatCommands.Register(Commands, Chat, State, Broadcaster, Runtimes);
GlobalOocCommand.Register(Commands, Chat, Broadcaster);
ChatUtilityCommands.Register(Commands, Chat, Settings);
AdminDutyCommands.Register(Commands, State, Accounts, Broadcaster, Inventory, Chat, Bleeding);
RandomCommands.Register(Commands, Broadcaster);
InjuryCommands.Register(Commands, Injury, State, Broadcaster, Chat, Accounts);
NoClipCommand.Register(Commands, NoClip);
AnticheatCommands.Register(Commands, Anticheat, ViolationRepo, State, Chat, DischargeLogRepo);
InventoryCommands.Register(Commands, Inventory, Cash, State, Broadcaster, Bleeding, Alcohol, Addiction, NametagActions, Chat, Runtimes);
RadioCommands.Register(Commands, Radio, Runtimes);
PhoneCommands.Register(Commands, Phone, PhoneCall);
AdminPhoneCommands.Register(Commands, Phone, Inventory, State, Characters);
AdminInventoryCommands.Register(
  Commands,
  Inventory,
  Cash,
  State,
  InventoryRepo,
  MutationLogRepo,
  DischargeLogRepo,
  Accounts,
  Characters,
  Chat,
);
Log.Info(`IC/OOC commands registered - ${Commands.Size} command(s) total`);

const Http = new HttpRouter();

// ChatController is instantiated BEFORE CharacterController because
// CharacterController calls Chat.PushCommandListToSource(Src) right after
// emitting CharacterSpawned. Construction order no longer sequences
// disconnect teardown - that lives in PlayerSessionService's
// playerDropped dispatcher below.
const _Chat = new ChatController(State, Commands, Chat, ChatRateLimit, Accounts, Runtimes);
const _Character = new CharacterController(
  State,
  Routing,
  CharacterSvc,
  Runtimes,
  Validator,
  Characters,
  _Chat,
  Injury,
  Inventory,
  Bleeding,
  PhoneCall,
);
const _Connection = new ConnectionController(Queue);
const _Account = new AccountController(State, Routing, Discord, AccountSvc, Chat, Config);
const _Auth = new AuthController(State, Sessions, Accounts, Characters, Discord);
const _Settings = new SettingsController(State, Settings);
const _Injury = new InjuryController(State, Injury);
const _Inventory = new InventoryController(State, Inventory, Runtimes, Scanner, Bleeding);
// Net game-event ingestion (anti-cheat phase 2): instantiated after the
// inventory controller so its weaponDamageEvent sanity hook registers
// alongside the forensic hook already attached above.
const _AnticheatEvents = new AnticheatEventController(State, Anticheat, Inventory);
// Client-monitor ingest + heartbeat watchdog (anti-cheat phase 3): trails
// the game-event controller so the tier-3 surface registers right after it.
const _Anticheat = new AnticheatController(State, Anticheat);

// PlayerSessionService bundles the mid-session "exit world" transitions
// (/changecharacter, /logout) AND owns the Backend's single
// playerDropped registration: every per-Source teardown target is
// injected here and evicted in the explicit order documented on its
// HandleDropped dispatcher. Constructed after every evictee so they all
// exist by the time the handler registers. SessionCommands depends on
// both the registry and the service, so its registration trails this
// instantiation.
const Session = new PlayerSessionService(
  State,
  Routing,
  Sessions,
  Chat,
  _Character,
  NoClip,
  Anticheat,
  Injury,
  Bleeding,
  Inventory,
  Scanner,
  _AnticheatEvents,
  _Anticheat,
  _Chat,
  PmStore,
  Queue,
  NametagActions,
  PhoneCall,
  Addiction,
  Broadcaster,
);
SessionCommands.Register(Commands, Session);
Log.Info(`Session commands registered - ${Commands.Size} command(s) total`);

void _Connection;
void _Account;
void _Auth;
void _Character;
void _Chat;
void _Settings;
void Session;
void _Injury;
void _Inventory;
void _AnticheatEvents;
void _Anticheat;

Http.Mount();

Log.Info('Backend ready.');
