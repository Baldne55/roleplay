import {
  CreatorCameraBaseByGender,
  CreatorCameraFov,
  CreatorPedCoord,
  type AppearanceData,
  type Gender,
  type PreviewCamera,
} from '@Shared/Constants/Character.js';
import { ClothingCategories, DefaultOutfitData, type OutfitData } from '@Shared/Constants/Outfit.js';
import { NUIEvents, type NUIEventPayloads } from '@Shared/Events/NUIEvents.js';
import { Logger } from '@/Util/Logger.js';
import type { NuiService } from '@/Services/NuiService.js';
import type { PedDressingService } from '@/Services/PedDressingService.js';
import type { SpawnService } from '@/Services/SpawnService.js';

declare function PlayerPedId(): number;
declare function GetNumberOfPedDrawableVariations(Ped: number, Slot: number): number;
declare function GetNumberOfPedTextureVariations(
  Ped: number,
  Slot: number,
  Drawable: number,
): number;
declare function GetNumberOfPedPropDrawableVariations(Ped: number, Slot: number): number;
declare function GetNumberOfPedPropTextureVariations(
  Ped: number,
  Slot: number,
  Drawable: number,
): number;
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
declare function SetEntityVisible(Entity: number, Visible: boolean, _Unused: boolean): void;
declare function NetworkSetEntityInvisibleToNetwork(Entity: number, Invisible: boolean): void;
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
declare function GetOffsetFromEntityInWorldCoords(
  Entity: number,
  OffsetX: number,
  OffsetY: number,
  OffsetZ: number,
): [number, number, number];
declare function PointCamAtEntity(
  Cam: number,
  Entity: number,
  XOffset: number,
  YOffset: number,
  ZOffset: number,
  IsRelative: boolean,
): void;
declare function StopCamPointing(Cam: number): void;
declare function SetCamCoord(Cam: number, X: number, Y: number, Z: number): void;
declare function ClearPedTasksImmediately(Ped: number): void;
declare function SetPedDefaultComponentVariation(Ped: number): void;

/**
 * Live-ped manipulation for the character-creation wizard. The UI POSTs
 * incremental update events; we re-apply the full AppearanceData each
 * time via PedDressingService. Native calls are local-only - the ped is
 * hidden from the network throughout (other players in the same routing
 * bucket would otherwise see a flickering avatar).
 *
 * Coordinates + camera math inherited from roleplay_ragemp
 * (Coords.cs + Manager.js):
 *
 *   Ped:    (402.8349, -996.5052, -99.00023) heading 178.0954 -
 *           interior shell below the world, isolated + lit cleanly.
 *   Camera: ped-relative offset via GetOffsetFromEntityInWorldCoords,
 *           base (Offset / Depth / Height) gendered per
 *           CreatorCameraBaseByGender, then the four sliders modulate.
 */
export class CharacterCreatorService {
  private readonly Log = Logger.New('Creator');
  private CameraHandle: number | null = null;

  constructor(
    private readonly Spawn: SpawnService,
    private readonly Nui: NuiService,
    private readonly Dressing: PedDressingService,
  ) {}

  async StartPreview(Gender: Gender): Promise<void> {
    await this.Dressing.LoadAndSetModel(Gender);

    const Ped = PlayerPedId();

    RequestCollisionAtCoord(CreatorPedCoord.X, CreatorPedCoord.Y, CreatorPedCoord.Z);
    SetEntityCoordsNoOffset(
      Ped,
      CreatorPedCoord.X,
      CreatorPedCoord.Y,
      CreatorPedCoord.Z,
      false,
      false,
      false,
    );
    SetEntityHeading(Ped, CreatorPedCoord.Heading);
    FreezeEntityPosition(Ped, true);
    SetEntityVisible(Ped, true, false);
    NetworkSetEntityInvisibleToNetwork(Ped, true);

    this.Dressing.ResetForFreshFreemodePed(Ped);

    // Apply the wizard's default outfit (drawable 0 / texture 0 across
    // every component, every prop unequipped). This replaces the legacy
    // hardcoded underwear strip; the player now picks their starting
    // outfit on the final wizard pages and the same apply path runs for
    // both the live preview and the persisted starter outfit.
    this.Dressing.ApplyOutfit(DefaultOutfitData());

    // Drop any active task so we don't inherit a walking / aiming /
    // ragdoll pose from gameplay. FreezeEntityPosition (set above) keeps
    // the ped locked in place; the default idle anim still plays but
    // doesn't move them around.
    ClearPedTasksImmediately(Ped);

    this.MountCamera({ Rotation: 0, Zoom: 0, Height: 0, Slide: 0 });

    // Walk the GTA native variation counters and push the per-category
    // drawable + texture bounds to the UI. Slider Max values come from
    // this message; without it the wizard would only walk drawable 0
    // because the static SliderDef placeholder Max is 0.
    this.PushOutfitBounds(Ped);

    this.Log.Info(`Preview started - gender=${Gender} ped=${Ped}`);
  }

  ApplyAppearance(Data: AppearanceData): void {
    this.Dressing.ApplyAppearance(Data);
  }

  ApplyOutfit(Data: OutfitData): void {
    this.Dressing.ApplyOutfit(Data);
  }

  /**
   * Discover per-category drawable + texture counts off the freshly-loaded
   * freemode ped and push them to the UI. Sent once on StartPreview; the
   * UI seeds each outfit slider's runtime Max from this map.
   *
   * Drawable Max = count - 1 (count of 0 means "no drawables" - we still
   * publish DrawableMax = -1 for components so the slider clamps cleanly;
   * Props naturally tolerate -1 via the "no prop" sentinel).
   */
  private PushOutfitBounds(Ped: number): void {
    const Categories: Record<
      string,
      { DrawableMax: number; TextureMaxByDrawable: number[] }
    > = {};
    for (const Category of ClothingCategories) {
      const IsProp = Category.Type === 'Prop';
      const DrawableCount = IsProp
        ? GetNumberOfPedPropDrawableVariations(Ped, Category.Index)
        : GetNumberOfPedDrawableVariations(Ped, Category.Index);
      const DrawableMax = Math.max(IsProp ? -1 : 0, DrawableCount - 1);
      const TextureMaxByDrawable: number[] = [];
      for (let I = 0; I <= DrawableMax; I += 1) {
        const TextureCount = IsProp
          ? GetNumberOfPedPropTextureVariations(Ped, Category.Index, I)
          : GetNumberOfPedTextureVariations(Ped, Category.Index, I);
        TextureMaxByDrawable[I] = Math.max(0, TextureCount - 1);
      }
      Categories[Category.Id] = { DrawableMax, TextureMaxByDrawable };
    }
    const Payload: Omit<NUIEventPayloads[typeof NUIEvents.OutfitBounds], 'Type'> = {
      Categories,
    };
    this.Nui.Send(NUIEvents.OutfitBounds, Payload);
  }

  ApplyCamera(Spec: PreviewCamera): void {
    if (this.CameraHandle === null) return;
    const Gender = this.Dressing.GetCurrentGender();
    if (Gender === null) return;
    const Ped = PlayerPedId();
    const Base = CreatorCameraBaseByGender[Gender];

    // Ped-relative offset (ragemp formula). Depth = forward distance;
    // Zoom slider pulls camera in/out along Depth. Slide nudges across
    // X for face / off-centre framing. Rotation orbits the camera
    // around the ped via the rotation slider; we apply it AFTER the
    // base offset so the orbit is around the ped, not the world.
    const Depth = Base.Depth - Spec.Zoom;
    const Radians = (Spec.Rotation * Math.PI) / 180;
    const RotatedX = Math.sin(Radians) * Depth + (Base.Offset + Spec.Slide);
    const RotatedY = Math.cos(Radians) * Depth;
    const Z = Base.Height + Spec.Height;

    const [WX, WY, WZ] = GetOffsetFromEntityInWorldCoords(Ped, RotatedX, RotatedY, Z);
    SetCamCoord(this.CameraHandle, WX, WY, WZ);
    PointCamAtEntity(this.CameraHandle, Ped, 0, 0, Z, true);
  }

  /**
   * Clean up the creator-owned scripted camera + ped tasks in preparation
   * for a spawn-into-world handoff. Unlike StopPreview, does NOT call
   * RestoreAuthShell - the spawn pipeline is taking over and will move
   * the ped to its world coord. Safe to call when no preview is active.
   */
  DismissForSpawn(): void {
    if (this.CameraHandle !== null) {
      StopCamPointing(this.CameraHandle);
      DestroyCam(this.CameraHandle, false);
      this.CameraHandle = null;
    }
  }

  StopPreview(): void {
    const Ped = PlayerPedId();
    // Clean up the creator-specific state but leave ped position +
    // camera teardown to the auth shell - RestoreAuthShell below
    // teleports the ped back to the panorama coord and re-mounts the
    // cinematic camera. Restoring default clothing here means the ped
    // isn't in boxers if the auth shell ever exposes it.
    ClearPedTasksImmediately(Ped);
    SetPedDefaultComponentVariation(Ped);
    if (this.CameraHandle !== null) {
      StopCamPointing(this.CameraHandle);
      DestroyCam(this.CameraHandle, false);
      this.CameraHandle = null;
    }
    // Hand the ped back to the auth shell - panorama camera, hidden
    // ped, frozen at the auth spawn coord. The cinematic re-mount
    // inside RestoreAuthShell calls RenderScriptCams(true) so the
    // creator's RenderScriptCams toggle isn't needed here.
    void this.Spawn.RestoreAuthShell();
    this.Log.Info('Preview stopped, auth shell restored');
  }

  private MountCamera(Initial: PreviewCamera): void {
    if (this.CameraHandle !== null) {
      DestroyCam(this.CameraHandle, false);
    }
    const Handle = CreateCamWithParams(
      'DEFAULT_SCRIPTED_CAMERA',
      CreatorPedCoord.X,
      CreatorPedCoord.Y,
      CreatorPedCoord.Z + 1,
      0,
      0,
      0,
      CreatorCameraFov,
      true,
      2,
    );
    SetCamActive(Handle, true);
    RenderScriptCams(true, false, 0, true, false);
    this.CameraHandle = Handle;
    this.ApplyCamera(Initial);
  }
}
