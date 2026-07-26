import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function onNet<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function setTick(Callback: () => void): number;
declare function clearTick(Handle: number): void;
declare function PlayerPedId(): number;
declare function GetEntityCoords(
  Entity: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function SetEntityCoordsNoOffset(
  Entity: number,
  X: number,
  Y: number,
  Z: number,
  AliveFlag: boolean,
  DeadFlag: boolean,
  RagdollFlag: boolean,
): void;
declare function SetEntityCollision(Entity: number, UseCollision: boolean, KeepPhysics: boolean): void;
declare function FreezeEntityPosition(Entity: number, Freeze: boolean): void;
declare function SetEntityInvincible(Entity: number, Invincible: boolean): void;
declare function NetworkSetEntityInvisibleToNetwork(Entity: number, Invisible: boolean): void;
declare function GetGameplayCamRot(
  RotationOrder: number,
): { x: number; y: number; z: number } & [number, number, number];
declare function IsControlPressed(PadIndex: number, Control: number): boolean;
declare function IsDisabledControlPressed(PadIndex: number, Control: number): boolean;
declare function DisableControlAction(PadIndex: number, Control: number, Disable: boolean): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * Control-group index for keyboard/mouse. Every IsControlPressed and
 * DisableControlAction call here passes it - noclip is a staff tool and
 * is not wired for gamepad.
 */
const PadKeyboard = 0;

/** Base per-frame distance, metres. ~30 m/s at 60 fps. */
const BaseSpeed = 0.5;
/** Shift-boost multiplier on top of BaseSpeed. */
const BoostMultiplier = 4.0;

/**
 * Inputs read while noclipping. WASD moves camera-relative; Space/E and
 * Ctrl/Q move world-vertical; Shift boosts. The vertical keys are read
 * via IsDisabledControlPressed because we disable the underlying actions
 * (jump / duck / cover / pickup) on the same frame to suppress their
 * default animations + interactions on the frozen ped.
 */
const InputForward = 32; // W
const InputBack = 33; // S
const InputLeft = 34; // A
const InputRight = 35; // D
const InputUp = 22; // Space (also jump - disabled while active)
const InputDown = 36; // L-Ctrl (also duck - disabled while active)
const InputUpAlt = 38; // E (also pickup/interact - disabled while active)
const InputDownAlt = 44; // Q (also cover - disabled while active)
const InputBoost = 21; // L-Shift (sprint)

/**
 * Controls suppressed every frame while noclipping. Jump, duck, attack,
 * aim, detonate, throw grenade, enter vehicle, exit vehicle - anything
 * the player might fire by accident while flying that would queue an
 * animation or interaction on the otherwise-frozen ped.
 */
const SuppressedInputs: readonly number[] = [
  InputUp, // 22 jump (re-read via disabled-pressed)
  InputDown, // 36 duck (re-read via disabled-pressed)
  InputUpAlt, // 38 pickup/interact (re-read via disabled-pressed)
  InputDownAlt, // 44 cover (re-read via disabled-pressed)
  23, // enter vehicle
  24, // attack
  25, // aim
  47, // detonate
  58, // throw grenade
  75, // exit vehicle
];

/**
 * `/noclip` admin free-fly. Listens for `Roleplay:Net:Admin:NoClipToggle`
 * from the server (which owns the on/off bit) and toggles a local visual
 * + movement state on the local ped:
 *
 *   - NetworkSetEntityInvisibleToNetwork hides the ped from other
 *     clients while keeping it visible locally so the admin sees
 *     their own anchor.
 *   - SetEntityCollision off so geometry never interrupts the fly.
 *   - FreezeEntityPosition true so gravity does not pull the ped down
 *     between movement ticks.
 *   - SetEntityInvincible true so a stray bullet on the way in does
 *     not advance the injury state.
 *   - A setTick reads camera rotation + WASD/Space/Ctrl, computes a
 *     camera-relative direction vector, and teleports the ped via
 *     SetEntityCoordsNoOffset. Shift boosts the per-frame distance.
 *
 * SessionReturnToSelect / SessionReturnToAuth force a Disable() so an
 * admin who hits `/changecharacter` mid-noclip does not carry the
 * collision-off / invisible state into the next character.
 */
export class NoClipController {
  private readonly Log = Logger.New('NoClip');

  private IsActive = false;
  private TickHandle: number | null = null;

  constructor() {
    onNet(
      NetEvents.AdminNoClipToggle,
      (Payload: NetEventPayloads[typeof NetEvents.AdminNoClipToggle]): void => {
        if (Payload.On) this.Enable();
        else this.Disable();
      },
    );

    const Reset = (): void => {
      if (this.IsActive) this.Disable();
    };
    onNet(NetEvents.SessionReturnToSelect, Reset);
    onNet(NetEvents.SessionReturnToAuth, Reset);

    this.Log.Debug('Handlers registered (AdminNoClipToggle, SessionReturnTo*)');
  }

  /**
   * Enter noclip: detach collision, make the ped invisible, and start the
   * free-fly loop. Server-authorised before this runs - the client never
   * enables it on its own say-so.
   */
  private Enable(): void {
    if (this.IsActive) return;
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    this.IsActive = true;
    NetworkSetEntityInvisibleToNetwork(Ped, true);
    SetEntityCollision(Ped, false, false);
    FreezeEntityPosition(Ped, true);
    SetEntityInvincible(Ped, true);
    this.TickHandle = setTick((): void => {
      this.OnTick();
    });
    this.Log.Debug('Noclip enabled');
  }

  /** Leave noclip, restoring collision, visibility and normal control. */
  private Disable(): void {
    if (!this.IsActive) return;
    this.IsActive = false;
    if (this.TickHandle !== null) {
      clearTick(this.TickHandle);
      this.TickHandle = null;
    }
    const Ped = PlayerPedId();
    if (Ped === 0) return;
    NetworkSetEntityInvisibleToNetwork(Ped, false);
    SetEntityCollision(Ped, true, true);
    FreezeEntityPosition(Ped, false);
    SetEntityInvincible(Ped, false);
    this.Log.Debug('Noclip disabled');
  }

  /**
   * Per-frame free-fly: read movement input and translate the ped
   * directly, since normal physics is detached while noclipping.
   */
  private OnTick(): void {
    const Ped = PlayerPedId();
    if (Ped === 0) return;

    for (const Control of SuppressedInputs) {
      DisableControlAction(PadKeyboard, Control, true);
    }

    const Rot = GetGameplayCamRot(2);
    const Pitch = (Number(Rot[0]) * Math.PI) / 180;
    const Yaw = (Number(Rot[2]) * Math.PI) / 180;

    const ForwardX = -Math.sin(Yaw) * Math.cos(Pitch);
    const ForwardY = Math.cos(Yaw) * Math.cos(Pitch);
    const ForwardZ = Math.sin(Pitch);

    const RightX = Math.cos(Yaw);
    const RightY = Math.sin(Yaw);

    let MoveX = 0;
    let MoveY = 0;
    let MoveZ = 0;

    if (IsControlPressed(PadKeyboard, InputForward)) {
      MoveX += ForwardX;
      MoveY += ForwardY;
      MoveZ += ForwardZ;
    }
    if (IsControlPressed(PadKeyboard, InputBack)) {
      MoveX -= ForwardX;
      MoveY -= ForwardY;
      MoveZ -= ForwardZ;
    }
    if (IsControlPressed(PadKeyboard, InputLeft)) {
      MoveX -= RightX;
      MoveY -= RightY;
    }
    if (IsControlPressed(PadKeyboard, InputRight)) {
      MoveX += RightX;
      MoveY += RightY;
    }
    if (
      IsDisabledControlPressed(PadKeyboard, InputUp) ||
      IsDisabledControlPressed(PadKeyboard, InputUpAlt)
    ) {
      MoveZ += 1;
    }
    if (
      IsDisabledControlPressed(PadKeyboard, InputDown) ||
      IsDisabledControlPressed(PadKeyboard, InputDownAlt)
    ) {
      MoveZ -= 1;
    }

    if (MoveX === 0 && MoveY === 0 && MoveZ === 0) return;

    const Speed = IsControlPressed(PadKeyboard, InputBoost)
      ? BaseSpeed * BoostMultiplier
      : BaseSpeed;

    const Coords = GetEntityCoords(Ped);
    SetEntityCoordsNoOffset(
      Ped,
      Number(Coords[0]) + MoveX * Speed,
      Number(Coords[1]) + MoveY * Speed,
      Number(Coords[2]) + MoveZ * Speed,
      false,
      false,
      false,
    );
  }
}
