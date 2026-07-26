import { Logger } from '@/Util/Logger.js';
import { NuiService } from '@/Services/NuiService.js';
import { SpawnService } from '@/Services/SpawnService.js';
import { PedDressingService } from '@/Services/PedDressingService.js';
import { CharacterCreatorService } from '@/Services/CharacterCreatorService.js';
import { AuthController } from '@/Controllers/AuthController.js';
import { CharacterController } from '@/Controllers/CharacterController.js';
import { ChatController } from '@/Controllers/ChatController.js';
import { NametagController } from '@/Controllers/NametagController.js';
import { SessionController } from '@/Controllers/SessionController.js';
import { SettingsController } from '@/Controllers/SettingsController.js';
import { InjuryController } from '@/Controllers/InjuryController.js';
import { BleedingController } from '@/Controllers/BleedingController.js';
import { NoClipController } from '@/Controllers/NoClipController.js';
import { InventoryController } from '@/Controllers/InventoryController.js';
import { AnticheatMonitorController } from '@/Controllers/AnticheatMonitorController.js';

/**
 * Client-side composition root. Runs once when the resource starts on a
 * joining player's game, mirroring Backend/Src/Bootstrap.ts on the other
 * side of the wire: construct the shared services first, then every
 * controller, wiring dependencies by hand rather than through a DI
 * container.
 *
 * Ordering matters in exactly one place - Dressing must be attached to
 * Spawn before CharacterCreatorService is built, since the creator drives
 * the preview ped through Spawn's dressing handle. Everything after that
 * is order-independent: controllers only talk to each other over net
 * events and NUI messages, never by direct reference.
 *
 * Unlike the server root there is no teardown path here. A client-side
 * resource stop tears the whole JS runtime down with it, so ticks and
 * event handlers registered below die with the process; nothing needs to
 * unregister them.
 */
const Log = Logger.New('Bootstrap');

Log.Info('Frontend booting...');

const Nui = new NuiService();
const Spawn = new SpawnService();
const Dressing = new PedDressingService();
Spawn.AttachDressing(Dressing);
const Creator = new CharacterCreatorService(Spawn, Nui, Dressing);

/*
 * Controllers are constructed purely for their side effects: each one
 * registers its onNet handlers, NUI callbacks and setTick loops from its
 * own constructor and is never referenced again. The bindings exist only
 * so the constructions read as a list rather than a wall of bare `new`
 * expressions, and the `void` statements below tell both the compiler and
 * eslint that the unused bindings are deliberate. Dropping a controller
 * from this list silently disables that entire client feature - there is
 * no registry that would notice the omission.
 */
const _Auth = new AuthController(Spawn, Nui);
const _Character = new CharacterController(Creator, Spawn, Nui);
const _Chat = new ChatController(Nui);
const _Nametag = new NametagController();
const _Session = new SessionController(Spawn, Nui);
const _Settings = new SettingsController(Nui);
const _Injury = new InjuryController();
const _Bleeding = new BleedingController();
const _NoClip = new NoClipController();
const _Inventory = new InventoryController();
const _AnticheatMonitor = new AnticheatMonitorController();
void _Auth;
void _Character;
void _Chat;
void _Nametag;
void _Session;
void _Settings;
void _Injury;
void _Bleeding;
void _NoClip;
void _Inventory;
void _AnticheatMonitor;

Log.Info('Frontend ready.');
