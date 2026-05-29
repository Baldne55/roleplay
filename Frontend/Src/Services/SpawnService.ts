import type { CharacterSpawnPayload } from '@Shared/Constants/Character.js';
import type { CameraSpec, Vec3 } from '@Shared/Constants/AuthSkybox.js';
import { Logger } from '@/Util/Logger.js';
import type { PedDressingService } from '@/Services/PedDressingService.js';

declare function PlayerPedId(): number;
declare function DoesEntityExist(Entity: number): boolean;
declare function RequestCollisionAtCoord(X: number, Y: number, Z: number): void;
declare function SetEntityCoordsNoOffset(
  Entity: number,
  X: number,
  Y: number,
  Z: number,
  Alive: boolean,
  DeadFlag: boolean,
  Ragdoll: boolean,
): void;
declare function SetEntityHeading(Entity: number, Heading: number): void;
declare function FreezeEntityPosition(Entity: number, Freeze: boolean): void;
declare function SetEntityInvincible(Entity: number, Invincible: boolean): void;
declare function SetEntityVisible(Entity: number, Visible: boolean, _Unused: boolean): void;
declare function NetworkSetEntityInvisibleToNetwork(Entity: number, Invisible: boolean): void;
declare function SetEntityHealth(Entity: number, Health: number): void;
declare function SetPedArmour(Ped: number, Amount: number): void;
declare function DisplayRadar(Toggle: boolean): void;
declare function DisplayHud(Toggle: boolean): void;
declare function ShutdownLoadingScreen(): void;
declare function ShutdownLoadingScreenNui(): void;
declare function DoScreenFadeOut(Duration: number): void;
declare function DoScreenFadeIn(Duration: number): void;
declare function IsScreenFadedOut(): boolean;
declare function SetGameplayCamRelativeHeading(Heading: number): void;
declare function SetGameplayCamRelativePitch(Pitch: number, Easing: number): void;
declare function CreateCamWithParams(
  CamName: string,
  X: number,
  Y: number,
  Z: number,
  RX: number,
  RY: number,
  RZ: number,
  Fov: number,
  IsActive: boolean,
  RotOrder: number,
): number;
declare function SetCamActive(Cam: number, Active: boolean): void;
declare function RenderScriptCams(
  Render: boolean,
  Ease: boolean,
  Time: number,
  IgnoreScriptCam: boolean,
  IgnoreCinematicCam: boolean,
): void;
declare function DestroyCam(Cam: number, ThisScriptCheck: boolean): void;
declare function ClearPedTasksImmediately(Ped: number): void;

/**
 * Client-side ped + camera control for the pre-auth shell + spawn-into-
 * world handoff.
 *
 *   PrepareAuthShell({ SpawnCoord, Camera }):
 *     1. Wait for PlayerPedId() to become a valid entity (briefly after
 *        scene-load it can be 0 / unhandled).
 *     2. Request collision at the spawn coord so the ped doesn't fall
 *        through the world on teleport.
 *     3. Teleport the ped, freeze, invincible, hide locally + on the
 *        network (so nobody - including us - sees the ped while the
 *        cinematic cam is rendering downtown).
 *     4. Build a fixed scripted camera and render it.
 *     5. Hide the radar + HUD.
 *
 *   TearDownAuthShell():
 *     Reverses (4)+(5)+(3)'s visibility, leaves the ped frozen / at-coord
 *     for the next phase (spawn-into-world).
 *
 *   SpawnIntoWorld(Payload):
 *     Convergence point for the post-Select + post-Create flows.
 *     1. Tear down the cinematic shell.
 *     2. Hand the ped over to PedDressingService for model swap +
 *        appearance + outfit application.
 *     3. Teleport to the persisted coord, restore visibility / HUD,
 *        unfreeze, drop invincibility, set HP / armour.
 *     The server-side routing-bucket switch (auth-isolated -> world)
 *     happens in parallel; no client call needed.
 */
export class SpawnService {
  private readonly Log = Logger.New('Spawn');
  private CameraHandle: number | null = null;
  // Cached so we can re-enter the shell after the character creator
  // closes - the panorama needs the same coord + camera params.
  private LastSpawnCoord: Vec3 | null = null;
  private LastCamera: CameraSpec | null = null;
  private Dressing: PedDressingService | null = null;

  /**
   * Pull the dressing service in post-construction so the SpawnService
   * stays simple to instantiate (it's referenced by the creator's
   * constructor, which is in turn referenced by the dressing service's
   * indirect callers; the late wiring avoids circular bootstrap order).
   */
  AttachDressing(Dressing: PedDressingService): void {
    this.Dressing = Dressing;
  }

  async PrepareAuthShell(SpawnCoord: Vec3, Camera: CameraSpec): Promise<void> {
    this.LastSpawnCoord = SpawnCoord;
    this.LastCamera = Camera;

    const Ped = await this.WaitForPed();

    RequestCollisionAtCoord(SpawnCoord.X, SpawnCoord.Y, SpawnCoord.Z);
    SetEntityCoordsNoOffset(Ped, SpawnCoord.X, SpawnCoord.Y, SpawnCoord.Z, false, false, false);
    FreezeEntityPosition(Ped, true);
    SetEntityInvincible(Ped, true);
    SetEntityVisible(Ped, false, false);
    NetworkSetEntityInvisibleToNetwork(Ped, true);

    this.MountCinematicCamera(Camera);

    DisplayRadar(false);
    DisplayHud(false);

    // The auth shell IS our "ready" state - tell FiveM to dismiss the
    // built-in loadscreen + the "Awaiting scripts" placeholder. Without
    // these the loadscreen sits indefinitely waiting for some script
    // to mark itself done.
    ShutdownLoadingScreen();
    ShutdownLoadingScreenNui();

    this.Log.Debug(`Auth shell ready - ped=${Ped} bucket-isolated`);
  }

  /**
   * Re-apply the auth-shell state using the params from the most recent
   * `PrepareAuthShell` call. Used by the character creator when the
   * player goes back to the Details screen so the panorama camera +
   * hidden ped pose come back.
   */
  async RestoreAuthShell(): Promise<void> {
    if (this.LastSpawnCoord === null || this.LastCamera === null) {
      this.Log.Warn('RestoreAuthShell called before any PrepareAuthShell; no-op.');
      return;
    }
    await this.PrepareAuthShell(this.LastSpawnCoord, this.LastCamera);
  }

  TearDownAuthShell(): void {
    if (this.CameraHandle !== null) {
      RenderScriptCams(false, false, 0, true, false);
      DestroyCam(this.CameraHandle, false);
      this.CameraHandle = null;
    }

    // HUD + minimap stay OFF through spawn. PrepareAuthShell disables
    // them on connect; we deliberately do NOT restore here so the player
    // lands in the world with no chrome. A future settings / accessibility
    // surface can re-enable them when one ships.

    const Ped = PlayerPedId();
    SetEntityVisible(Ped, true, false);
    NetworkSetEntityInvisibleToNetwork(Ped, false);
  }

  /**
   * Place the player into the world for the selected character. Called
   * by the Frontend CharacterController on CharacterSpawned, which fires
   * both from CharacterSelect (returning player) and CharacterCreate
   * (auto-spawn the freshly created character).
   *
   * Visual flow: fade-out -> dress + teleport while screen is black ->
   * tear down the scripted camera (auth-shell or creator) -> re-anchor
   * the gameplay cam to the freshly placed ped -> fade-in. Releasing the
   * scripted cam BEFORE the teleport would briefly show the auth /
   * creator coord through the gameplay cam during the model swap.
   */
  async SpawnIntoWorld(Payload: CharacterSpawnPayload): Promise<void> {
    if (this.Dressing === null) {
      throw new Error('SpawnService.SpawnIntoWorld called before AttachDressing');
    }

    DoScreenFadeOut(400);
    await this.WaitForScreenFadedOut();

    await this.Dressing.LoadAndSetModel(Payload.Gender);
    const Ped = PlayerPedId();
    this.Dressing.ResetForFreshFreemodePed(Ped);
    this.Dressing.ApplyAppearance(Payload.AppearanceData);
    this.Dressing.ApplyOutfit(Payload.Outfit);

    RequestCollisionAtCoord(Payload.Coord.X, Payload.Coord.Y, Payload.Coord.Z);
    SetEntityCoordsNoOffset(
      Ped,
      Payload.Coord.X,
      Payload.Coord.Y,
      Payload.Coord.Z,
      false,
      false,
      false,
    );
    SetEntityHeading(Ped, Payload.Heading);
    ClearPedTasksImmediately(Ped);
    FreezeEntityPosition(Ped, false);
    SetEntityInvincible(Ped, false);
    SetEntityVisible(Ped, true, false);
    NetworkSetEntityInvisibleToNetwork(Ped, false);

    // SetEntityHealth uses 0-200; our HP column tops out at 100 so add
    // 100 for the GTA "max health" baseline. AP maps 1:1 onto armour.
    SetEntityHealth(Ped, Math.max(0, Math.min(100, Payload.HP)) + 100);
    SetPedArmour(Ped, Math.max(0, Math.min(100, Payload.AP)));

    // Now drop any remaining scripted camera (auth or creator) and hand
    // back to the gameplay cam, then re-anchor heading + pitch so the
    // cam isn't carrying a stale relative angle from the previous pose.
    this.TearDownAuthShell();
    SetGameplayCamRelativeHeading(0);
    SetGameplayCamRelativePitch(0, 1);

    DoScreenFadeIn(400);

    this.Log.Debug(
      `Spawned character=${Payload.CharacterID} at ` +
        `(${Payload.Coord.X.toFixed(1)}, ${Payload.Coord.Y.toFixed(1)}, ${Payload.Coord.Z.toFixed(1)}) ` +
        `world=${Payload.World}`,
    );
  }

  private WaitForScreenFadedOut(): Promise<void> {
    return new Promise((Resolve) => {
      const Poll = (): void => {
        if (IsScreenFadedOut()) {
          Resolve();
          return;
        }
        setTimeout(Poll, 50);
      };
      Poll();
    });
  }

  private MountCinematicCamera(Camera: CameraSpec): void {
    if (this.CameraHandle !== null) {
      DestroyCam(this.CameraHandle, false);
    }
    const Handle = CreateCamWithParams(
      'DEFAULT_SCRIPTED_CAMERA',
      Camera.Position.X,
      Camera.Position.Y,
      Camera.Position.Z,
      Camera.Rotation.X,
      Camera.Rotation.Y,
      Camera.Rotation.Z,
      Camera.Fov,
      true,
      2,
    );
    SetCamActive(Handle, true);
    RenderScriptCams(true, false, 0, true, false);
    this.CameraHandle = Handle;
  }

  private WaitForPed(): Promise<number> {
    return new Promise((Resolve) => {
      const Poll = (): void => {
        const Ped = PlayerPedId();
        if (Ped !== 0 && DoesEntityExist(Ped)) {
          Resolve(Ped);
          return;
        }
        setTimeout(Poll, 100);
      };
      Poll();
    });
  }
}
