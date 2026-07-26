import { ChatFormatter } from '@Shared/Chat/Index.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { NoClipService } from '@/Services/NoClipService.js';
import { Logger } from '@/Util/Logger.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * `/noclip` - admin-only free-fly toggle.
 *
 * The server owns the on/off bit per Source (in NoClipService) so a
 * reconnect, a duplicate `/noclip`, or a mid-noclip `/changecharacter`
 * can not desync state - the session transitions reset the service
 * alongside the validator-suspend and anti-cheat-sanction bookkeeping.
 * The actual ped visibility / collision / position-freeze work lives
 * client-side in `Frontend/Src/Controllers/NoClipController.ts`; the
 * server just emits the resolved next state.
 *
 * Gated by the dispatcher: `RequiredStaffLevel: 'Administrator'` plus
 * the default duty check (omit `SkipDutyCheck`) so a Founder who is
 * not currently on duty receives `NotOnDuty` rather than the noclip
 * surface.
 */
export function Register(Registry: CommandRegistry, NoClip: NoClipService): void {
  const Log = Logger.New('NoClipCommand');

  Registry.Add({
    Name: 'noclip',
    Description: 'Toggle no-clip free-fly movement.',
    Category: 'Admin',
    RequireCharacter: true,
    RequiredStaffLevel: 'Administrator',
    Run: (Ctx): CommandResult => {
      // NoClipService flips the on/off bit and keeps the validator
      // suspend + anti-cheat sanction in lockstep; the client applies
      // invincibility + collision-off + per-frame coord writes, all of
      // which read as cheats without that sanction.
      const NowOn = NoClip.Toggle(Ctx.Source);

      const Payload: NetEventPayloads[typeof NetEvents.AdminNoClipToggle] = {
        On: NowOn,
      };
      emitNet(NetEvents.AdminNoClipToggle, Ctx.Source, Payload);

      Log.Debug(`/noclip source=${Ctx.Source} -> ${NowOn ? 'on' : 'off'}`);

      return {
        Outcome: 'Ok',
        Reply: ChatFormatter.Info(NowOn ? 'Noclip enabled.' : 'Noclip disabled.'),
      };
    },
  });
}
