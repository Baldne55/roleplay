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

const Log = Logger.New('Bootstrap');

Log.Info('Frontend booting...');

const Nui = new NuiService();
const Spawn = new SpawnService();
const Dressing = new PedDressingService();
Spawn.AttachDressing(Dressing);
const Creator = new CharacterCreatorService(Spawn, Nui, Dressing);
const _Auth = new AuthController(Spawn, Nui);
const _Character = new CharacterController(Creator, Spawn, Nui);
const _Chat = new ChatController(Nui);
const _Nametag = new NametagController();
const _Session = new SessionController(Spawn, Nui);
const _Settings = new SettingsController(Nui);
void _Auth;
void _Character;
void _Chat;
void _Nametag;
void _Session;
void _Settings;

Log.Info('Frontend ready.');
