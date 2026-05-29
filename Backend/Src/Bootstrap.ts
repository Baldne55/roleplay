import { Logger } from '@/Util/Logger.js';
import { LoadServerConfig } from '@/Infrastructure/Config/ServerConfig.js';
import { CreateSequelize } from '@/Data/Database.js';
import { Account } from '@/Data/Models/Account.js';
import { Character } from '@/Data/Models/Character.js';
import { CharacterOutfit } from '@/Data/Models/CharacterOutfit.js';
import { AccountRepository } from '@/Data/Repositories/AccountRepository.js';
import { CharacterRepository } from '@/Data/Repositories/CharacterRepository.js';
import { CharacterOutfitRepository } from '@/Data/Repositories/CharacterOutfitRepository.js';
import { QueueService } from '@/Infrastructure/Queue/QueueService.js';
import { HttpRouter } from '@/Infrastructure/HTTP/HttpRouter.js';
import { PlayerStateService } from '@/Services/PlayerStateService.js';
import { RoutingBucketService } from '@/Services/RoutingBucketService.js';
import { DiscordService } from '@/Services/DiscordService.js';
import { AccountService } from '@/Services/AccountService.js';
import { AccountSessionService } from '@/Services/AccountSessionService.js';
import { ForensicIDService } from '@/Services/ForensicIDService.js';
import { CharacterService } from '@/Services/CharacterService.js';
import { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import { PositionValidatorService } from '@/Services/PositionValidatorService.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import { ChatService } from '@/Services/ChatService.js';
import { ChatRateLimiter } from '@/Services/ChatRateLimiter.js';
import { AccountSettingsService } from '@/Services/AccountSettingsService.js';
import { PlayerSessionService } from '@/Services/PlayerSessionService.js';
import * as CoreCommands from '@/Commands/CoreCommands.js';
import * as SessionCommands from '@/Commands/SessionCommands.js';
import { ConnectionController } from '@/Controllers/ConnectionController.js';
import { AccountController } from '@/Controllers/AccountController.js';
import { AuthController } from '@/Controllers/AuthController.js';
import { CharacterController } from '@/Controllers/CharacterController.js';
import { ChatController } from '@/Controllers/ChatController.js';
import { SettingsController } from '@/Controllers/SettingsController.js';

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
Database.addModels([Account, Character, CharacterOutfit]);
Log.Info('Sequelize ready (Account, Character, CharacterOutfit models registered)');

const Accounts = new AccountRepository();
const Characters = new CharacterRepository();
const Outfits = new CharacterOutfitRepository();

const State = new PlayerStateService();
const Routing = new RoutingBucketService();
const Queue = new QueueService();
const Sessions = new AccountSessionService();
const Discord = new DiscordService(Config);
const AccountSvc = new AccountService(Accounts);
const Forensic = new ForensicIDService();
const CharacterSvc = new CharacterService(Characters, Outfits, Forensic, Database);
const Runtimes = new CharacterRuntimeService();
const Validator = new PositionValidatorService();
Validator.Start();

const Commands = new CommandRegistry(State, Accounts);
CoreCommands.Register(Commands);
Log.Info(`Command registry ready - ${Commands.Size} command(s) registered`);

const Chat = new ChatService(State);
const ChatRateLimit = new ChatRateLimiter();
const Settings = new AccountSettingsService(Accounts);

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

const Http = new HttpRouter();

// ChatController is instantiated BEFORE CharacterController because
// CharacterController calls Chat.PushCommandListToSource(Src) right after
// emitting CharacterSpawned. Chat's own playerDropped handler only
// touches the rate-limit + registry-cooldown maps, so the ordering rule
// for CharacterController's persistence-snapshot path (must run before
// AccountController clears State) is unaffected.
const _Chat = new ChatController(State, Commands, Chat, ChatRateLimit, Accounts);
const _Character = new CharacterController(
  State,
  Routing,
  CharacterSvc,
  Runtimes,
  Validator,
  Characters,
  _Chat,
);
const _Connection = new ConnectionController(Queue);
const _Account = new AccountController(State, Routing, Discord, AccountSvc, Chat, Config);
const _Auth = new AuthController(State, Sessions, Accounts, Characters, Discord);
const _Settings = new SettingsController(State, Settings);

// PlayerSessionService bundles the mid-session "exit world" transitions
// (/changecharacter, /logout). Registers AFTER CharacterController so it
// can borrow the persist-and-detach path. SessionCommands depends on
// both the registry and the service, so its registration trails this
// instantiation.
const Session = new PlayerSessionService(State, Routing, Sessions, Chat, _Character);
SessionCommands.Register(Commands, Session);
Log.Info(`Session commands registered - ${Commands.Size} command(s) total`);

void _Connection;
void _Account;
void _Auth;
void _Character;
void _Chat;
void _Settings;
void Session;

Http.Mount();

Log.Info('Backend ready.');
