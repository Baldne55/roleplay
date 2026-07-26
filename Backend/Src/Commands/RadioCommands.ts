import { RadioSlotCount } from '@Shared/Constants/Radio.js';
import type { CommandBeforeRun, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { CharacterRuntimeService } from '@/Services/CharacterRuntimeService.js';
import type { RadioActionResult, RadioService } from '@/Services/RadioService.js';
import { AssertHealthy, ChainBeforeRun } from '@/Commands/Shared/AssertHealthy.js';

/**
 * Handheld text-radio commands.
 *
 *   /r (alias /radio)          - transmit on the main slot.
 *   /r1../rN <message>         - transmit on a numbered slot.
 *   /setmainradioslot (/setmainradio) - pick which slot is the main one.
 *   /setfrequency (/setfreq)   - tune the next free slot.
 *   /partradio (/part)         - clear a slot.
 *   /muteradio <slot>          - mute / unmute a slot's inbound.
 *   /setradio (/setr) [on|off] - show status, or power on/off.
 *
 * All logic lives in RadioService; these handlers only parse arguments
 * and map the service result onto a CommandResult. Transmit commands
 * carry the AssertHealthy guard (an incapacitated player cannot key a
 * radio); the tuning / power commands stay usable while downed.
 */
export function Register(
  Registry: CommandRegistry,
  Radio: RadioService,
  Runtimes: CharacterRuntimeService,
): void {
  // /r transmits on the main slot (null = follow the main-slot pointer).
  Registry.Add({
    Name: 'r',
    Aliases: ['radio'],
    Description: 'Transmit on your main radio slot.',
    Params: '<message>',
    Category: 'Comms',
    RequireCharacter: true,
    BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody('r')),
    Run: (Ctx): CommandResult => {
      const Body = Ctx.Args.join(' ').trim();
      return Resolve(Radio.Transmit(Ctx.Source, null, Body));
    },
  });

  // /r1../rN transmit on a specific numbered slot.
  for (let Slot = 1; Slot <= RadioSlotCount; Slot += 1) {
    const Name = `r${Slot}`;
    Registry.Add({
      Name,
      Description: `Transmit on radio slot ${Slot}.`,
      Params: '<message>',
      Category: 'Comms',
      RequireCharacter: true,
      BeforeRun: ChainBeforeRun(AssertHealthy(Runtimes), AssertNonEmptyBody(Name)),
      Run: (Ctx): CommandResult => {
        const Body = Ctx.Args.join(' ').trim();
        return Resolve(Radio.Transmit(Ctx.Source, Slot, Body));
      },
    });
  }

  Registry.Add({
    Name: 'setmainradioslot',
    Aliases: ['setmainradio'],
    Description: 'Choose which radio slot your main /r transmits on.',
    Params: '<slot>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Slot = ParseSlot(Ctx.Args[0]);
      if (Slot === null) return { Outcome: 'BadArgs', Reason: SlotUsage('setmainradioslot') };
      return Resolve(Radio.SetMainSlot(Ctx.Source, Slot));
    },
  });

  Registry.Add({
    Name: 'setfrequency',
    Aliases: ['setfreq'],
    Description: 'Tune the next free radio slot to a frequency.',
    Params: '<frequency>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Frequency = ParseFrequency(Ctx.Args[0]);
      if (Frequency === null) return { Outcome: 'BadArgs', Reason: 'Usage: /setfrequency <frequency>' };
      return Resolve(Radio.TuneIn(Ctx.Source, Frequency));
    },
  });

  Registry.Add({
    Name: 'partradio',
    Aliases: ['part'],
    Description: 'Clear a radio slot.',
    Params: '<slot>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Slot = ParseSlot(Ctx.Args[0]);
      if (Slot === null) return { Outcome: 'BadArgs', Reason: SlotUsage('partradio') };
      return Resolve(Radio.TuneOut(Ctx.Source, Slot));
    },
  });

  Registry.Add({
    Name: 'muteradio',
    Description: 'Mute or unmute a radio slot.',
    Params: '<slot>',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult => {
      const Slot = ParseSlot(Ctx.Args[0]);
      if (Slot === null) return { Outcome: 'BadArgs', Reason: SlotUsage('muteradio') };
      return Resolve(Radio.ToggleMute(Ctx.Source, Slot));
    },
  });

  Registry.Add({
    Name: 'setradio',
    Aliases: ['setr'],
    Description: 'Show your radio status, or power it on or off.',
    Params: '[on|off]',
    Category: 'Comms',
    RequireCharacter: true,
    Run: async (Ctx): Promise<CommandResult> => {
      const Arg = (Ctx.Args[0] ?? '').toLowerCase();
      if (Arg === '') return Resolve(Radio.Describe(Ctx.Source));
      if (Arg !== 'on' && Arg !== 'off') {
        return { Outcome: 'BadArgs', Reason: 'Usage: /setradio [on|off]' };
      }
      return Resolve(await Radio.SetPower(Ctx.Source, Arg === 'on'));
    },
  });
}

/** Map a RadioService result onto a CommandResult. */
function Resolve(Result: RadioActionResult): CommandResult {
  if (!Result.Ok) return { Outcome: 'BadArgs', Reason: Result.Reason };
  return Result.Message !== undefined ? { Outcome: 'Ok', Reply: Result.Message } : { Outcome: 'Ok' };
}

/** Reject empty transmit bodies with a usage hint. */
function AssertNonEmptyBody(Name: string): CommandBeforeRun {
  return (Ctx) => {
    if (Ctx.Args.join(' ').trim().length === 0) {
      return { Ok: false, Reason: `Usage: /${Name} <message>` };
    }
    return { Ok: true };
  };
}

/** Positive integer frequency; the service range-validates the value. */
function ParseFrequency(Arg: string | undefined): number | null {
  if (Arg === undefined) return null;
  if (!/^\d+$/.test(Arg)) return null;
  const N = Number.parseInt(Arg, 10);
  return Number.isFinite(N) ? N : null;
}

/** Slot number in [1, RadioSlotCount]. */
function ParseSlot(Arg: string | undefined): number | null {
  if (Arg === undefined) return null;
  if (!/^\d+$/.test(Arg)) return null;
  const N = Number.parseInt(Arg, 10);
  if (!Number.isInteger(N) || N < 1 || N > RadioSlotCount) return null;
  return N;
}

/**
 * Usage hint naming the live slot range, so the bound stays correct if
 * RadioSlotCount changes.
 */
function SlotUsage(Cmd: string): string {
  return `Usage: /${Cmd} <slot> (1-${RadioSlotCount})`;
}
