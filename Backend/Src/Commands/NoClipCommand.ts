import { ChatFormatter } from '@Shared/Chat/Index.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PositionValidatorService } from '@/Services/PositionValidatorService.js';
import { Logger } from '@/Util/Logger.js';

declare const source: number;
declare function on<T extends (...Args: never[]) => void>(EventName: string, Callback: T): void;
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;

/**
 * `/noclip` - admin-only free-fly toggle.
 *
 * The server owns the on/off bit per Source so a reconnect, a duplicate
 * `/noclip`, or a mid-noclip `/changecharacter` can not desync state.
 * The actual ped visibility / collision / position-freeze work lives
 * client-side in `Frontend/Src/Controllers/NoClipController.ts`; the
 * server just emits the resolved next state.
 *
 * Gated by the dispatcher: `RequiredStaffLevel: 'Administrator'` plus
 * the default duty check (omit `SkipDutyCheck`) so a Founder who is
 * not currently on duty receives `NotOnDuty` rather than the noclip
 * surface.
 */
export function Register(
  Registry: CommandRegistry,
  Validator: PositionValidatorService,
): void {
  const Log = Logger.New('NoClip');
  const Active = new Set<number>();

  on('playerDropped', (): void => {
    Active.delete(source);
  });

  Registry.Add({
    Name: 'noclip',
    Description: 'Toggle no-clip free-fly movement.',
    Category: 'Admin',
    RequireCharacter: true,
    RequiredStaffLevel: 'Administrator',
    Run: (Ctx): CommandResult => {
      const NowOn = !Active.has(Ctx.Source);
      if (NowOn) Active.add(Ctx.Source);
      else Active.delete(Ctx.Source);

      const Payload: NetEventPayloads[typeof NetEvents.AdminNoClipToggle] = {
        On: NowOn,
      };
      emitNet(NetEvents.AdminNoClipToggle, Ctx.Source, Payload);

      // Tell the anti-teleport validator to waive its delta check
      // while the admin is flying. Shift-boost noclip covers ~120 m/s
      // (240m per 2s tick), well over the 200m threshold; without this
      // every boosted flight floods the warn channel and pins the
      // "last sane" coord at the spot the admin took off from.
      if (NowOn) Validator.Suspend(Ctx.Source);
      else Validator.Resume(Ctx.Source);

      Log.Debug(`/noclip source=${Ctx.Source} -> ${NowOn ? 'on' : 'off'}`);

      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(NowOn ? 'Noclip enabled.' : 'Noclip disabled.'),
      };
    },
  });
}
