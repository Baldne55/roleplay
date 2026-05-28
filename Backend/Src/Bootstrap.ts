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
import { ConnectionController } from '@/Controllers/ConnectionController.js';
import { AccountController } from '@/Controllers/AccountController.js';
import { AuthController } from '@/Controllers/AuthController.js';
import { CharacterController } from '@/Controllers/CharacterController.js';

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

const Http = new HttpRouter();

// CharacterController is instantiated BEFORE AccountController so its
// playerDropped handler registers (and runs) first. The persistence
// path needs to read the runtime cache + snapshot natives BEFORE
// anyone else's disconnect handler can clear shared state.
const _Character = new CharacterController(
  State,
  Routing,
  CharacterSvc,
  Runtimes,
  Validator,
  Characters,
);
const _Connection = new ConnectionController(Queue);
const _Account = new AccountController(State, Routing, Discord, AccountSvc, Config);
const _Auth = new AuthController(State, Sessions, Accounts, Characters, Discord);
void _Connection;
void _Account;
void _Auth;
void _Character;

Http.Mount();

Log.Info('Backend ready.');
