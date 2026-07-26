import { ChatColor, ChatFormatter } from '@Shared/Chat/Index.js';
import type { CommandContext, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { PhoneActionResult, PhoneService } from '@/Services/PhoneService.js';
import type { PhoneCallService } from '@/Services/PhoneCallService.js';

/**
 * Player-facing phone cluster, a nested-subcommand dispatcher in the
 * spirit of /item but two levels deep (e.g. /phone sms send ...). Bare
 * /phone shows the status card; /phone help lists the categories. Every
 * leaf maps a service result onto a CommandResult through Resolve.
 *
 * Four categories nest under /phone: sms, vm, contact, call. All four are
 * registered here - the call leaves differ only in that they delegate to
 * PhoneCallService (live-call state machine) rather than PhoneService,
 * because a call has a peer and a duration where a text does not.
 */

/**
 * A node's body. Args are the tokens AFTER this node's own name, which
 * is what lets a category handler pass its remainder straight back into
 * DispatchSub. Sync or async: leaves that only parse can return a
 * CommandResult directly, while anything touching a service returns a
 * promise.
 */
type SubHandler = (Ctx: CommandContext, Args: string[]) => CommandResult | Promise<CommandResult>;

/**
 * One node in the phone command tree. Because the tree is two levels
 * deep, a `Handler` here may itself be another DispatchSub call rather
 * than a leaf - the shape is identical either way.
 */
interface SubCommand {
  readonly Name: string;
  readonly Params: string;
  readonly Description: string;
  readonly Handler: SubHandler;
}

/**
 * Wire `/phone` and its `/ph` alias into the registry.
 *
 * The subcommand tables are built here as plain arrays and closed over by
 * the dispatcher, which is what allows the nesting: an entry's handler
 * can recurse into DispatchSub with a child table.
 */
export function Register(
  Registry: CommandRegistry,
  Phone: PhoneService,
  Call: PhoneCallService,
): void {
  const SmsSubs: SubCommand[] = [
    {
      Name: 'send',
      Params: '<number|contact> <message>',
      Description: 'Send a text message.',
      Handler: (Ctx, Args) => HandleSend(Args, 'phone sms send', (T, B) => Phone.SendSms(Ctx.Source, T, B)),
    },
    {
      Name: 'log',
      Params: '[count]',
      Description: 'Show your recent text messages.',
      Handler: (Ctx, Args) => Resolve(Phone.ListSmsLog(Ctx.Source, ParseCount(Args[0]))),
    },
  ];

  const VmSubs: SubCommand[] = [
    {
      Name: 'send',
      Params: '<number|contact> <message>',
      Description: 'Leave a voicemail.',
      Handler: (Ctx, Args) =>
        HandleSend(Args, 'phone vm send', (T, B) => Phone.SendVoicemail(Ctx.Source, T, B)),
    },
    {
      Name: 'inbox',
      Params: '',
      Description: 'List your voicemails.',
      Handler: (Ctx) => Resolve(Phone.ListVoicemailInbox(Ctx.Source)),
    },
    {
      Name: 'read',
      Params: '<id>',
      Description: 'Read a voicemail by its number.',
      Handler: (Ctx, Args) => {
        const Id = Args[0];
        if (Id === undefined || !/^\d+$/.test(Id)) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone vm read <id>' };
        }
        return Resolve(Phone.ReadVoicemail(Ctx.Source, Id));
      },
    },
  ];

  const ContactSubs: SubCommand[] = [
    {
      Name: 'add',
      Params: '<number> <name>',
      Description: 'Save a contact.',
      Handler: (Ctx, Args) => {
        const Number = Args[0];
        if (Number === undefined || Args.length < 2) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone contact add <number> <name>' };
        }
        return Resolve(Phone.AddContact(Ctx.Source, Number, Args.slice(1).join(' ')));
      },
    },
    {
      Name: 'remove',
      Params: '<name|number>',
      Description: 'Delete a contact.',
      Handler: (Ctx, Args) => {
        const Token = Args.join(' ').trim();
        if (Token.length === 0) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone contact remove <name|number>' };
        }
        return Resolve(Phone.RemoveContact(Ctx.Source, Token));
      },
    },
    {
      Name: 'list',
      Params: '',
      Description: 'List your saved contacts.',
      Handler: (Ctx) => Resolve(Phone.ListContacts(Ctx.Source)),
    },
  ];

  const CallSubs: SubCommand[] = [
    {
      Name: 'dial',
      Params: '<number|contact>',
      Description: 'Call a contact or number.',
      Handler: (Ctx, Args) => {
        const Target = Args[0];
        if (Target === undefined) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone call dial <number|contact>' };
        }
        return Resolve(Call.StartCall(Ctx.Source, Target));
      },
    },
    {
      Name: 'answer',
      Params: '',
      Description: 'Answer an incoming call.',
      Handler: (Ctx) => Resolve(Call.Answer(Ctx.Source)),
    },
    {
      Name: 'hangup',
      Params: '',
      Description: 'Hang up the current call.',
      Handler: (Ctx) => Resolve(Call.Hangup(Ctx.Source)),
    },
    {
      Name: 'log',
      Params: '[count]',
      Description: 'Show your recent calls.',
      Handler: (Ctx, Args) => Resolve(Call.ListLog(Ctx.Source, ParseCount(Args[0]))),
    },
  ];

  const PhoneSubs: SubCommand[] = [
    {
      Name: 'status',
      Params: '',
      Description: 'Show your phone status.',
      Handler: (Ctx) => Resolve(Phone.Describe(Ctx.Source)),
    },
    {
      Name: 'power',
      Params: '<on|off>',
      Description: 'Switch your phone on or off.',
      Handler: (Ctx, Args) => {
        const Arg = (Args[0] ?? '').toLowerCase();
        if (Arg !== 'on' && Arg !== 'off') {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone power <on|off>' };
        }
        return Resolve(Phone.SetPower(Ctx.Source, Arg === 'on'));
      },
    },
    {
      Name: 'main',
      Params: '<number>',
      Description: 'Choose which carried phone is active.',
      Handler: (Ctx, Args) => {
        const Number = Args[0];
        if (Number === undefined) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /phone main <number>' };
        }
        return Resolve(Phone.SetMainPhone(Ctx.Source, Number));
      },
    },
    {
      Name: 'sms',
      Params: '<send|log> ...',
      Description: 'Text messages.',
      Handler: (Ctx, Args) => DispatchSub(Args, SmsSubs, 'phone sms', Ctx),
    },
    {
      Name: 'vm',
      Params: '<send|inbox|read> ...',
      Description: 'Voicemail.',
      Handler: (Ctx, Args) => DispatchSub(Args, VmSubs, 'phone vm', Ctx),
    },
    {
      Name: 'contact',
      Params: '<add|remove|list> ...',
      Description: 'Contacts.',
      Handler: (Ctx, Args) => DispatchSub(Args, ContactSubs, 'phone contact', Ctx),
    },
    {
      Name: 'call',
      Params: '<dial|answer|hangup|log> ...',
      Description: 'Calls.',
      Handler: (Ctx, Args) => DispatchSub(Args, CallSubs, 'phone call', Ctx),
    },
  ];

  Registry.Add({
    Name: 'phone',
    Aliases: ['ph'],
    Description: 'Use your phone. Type /phone for status, or /phone help for actions.',
    Params: '[subcommand] [...]',
    Category: 'Comms',
    RequireCharacter: true,
    Run: (Ctx): CommandResult | Promise<CommandResult> => {
      // Bare /phone is the status card (home screen); help/? lists actions.
      if ((Ctx.Args[0] ?? '') === '') return Resolve(Phone.Describe(Ctx.Source));
      return DispatchSub(Ctx.Args, PhoneSubs, 'phone', Ctx);
    },
  });
}

// ── Shared dispatcher (recurses on an explicit args array) ─────────────

/**
 * Route one level of the phone command tree.
 *
 * Takes an explicit `Args` array rather than reading `Ctx.Args`, which is
 * what makes it re-entrant: a category handler slices off its own name
 * and calls back in with the remainder, so `/phone sms send 555 hi`
 * resolves in two hops through the same function. `ParentLabel` carries
 * the path walked so far purely so help text and error messages can echo
 * the full command.
 */
function DispatchSub(
  Args: string[],
  Subs: readonly SubCommand[],
  ParentLabel: string,
  Ctx: CommandContext,
): CommandResult | Promise<CommandResult> {
  const Name = (Args[0] ?? '').toLowerCase();
  if (Name === '' || Name === 'help' || Name === '?') {
    return { Outcome: 'Ok', Reply: RenderHelp(ParentLabel, Subs) };
  }
  const Found = Subs.find((S) => S.Name === Name);
  if (Found === undefined) {
    return {
      Outcome: 'BadArgs',
      Reason: `Unknown subcommand "${Name}". Type /${ParentLabel} for the list.`,
    };
  }
  return Found.Handler(Ctx, Args.slice(1));
}

/**
 * Render one level's index. Signatures are prefixed with the accumulated
 * `ParentLabel`, so help printed from a nested category shows the full
 * `/phone sms send ...` path rather than a bare leaf name the player
 * cannot type on its own.
 */
function RenderHelp(ParentLabel: string, Subs: readonly SubCommand[]): string {
  const Lines: string[] = [ChatFormatter.Header(`/${ParentLabel} commands`, ChatColor.Header)];
  for (const Sub of Subs) {
    const Sig =
      Sub.Params.length > 0
        ? `/${ParentLabel} ${Sub.Name} ${Sub.Params}`
        : `/${ParentLabel} ${Sub.Name}`;
    Lines.push(`${Sig} - ${Sub.Description}`);
  }
  Lines.push(ChatFormatter.Footer(ChatColor.Header));
  return Lines.join('\n');
}

/** Map a PhoneService result onto a CommandResult. */
async function Resolve(Action: Promise<PhoneActionResult>): Promise<CommandResult> {
  const Result = await Action;
  if (!Result.Ok) return { Outcome: 'BadArgs', Reason: Result.Reason };
  return Result.Message !== undefined ? { Outcome: 'Ok', Reply: Result.Message } : { Outcome: 'Ok' };
}

/** Shared parse for the `<number|contact> <message>` send leaves. */
function HandleSend(
  Args: string[],
  Usage: string,
  Send: (Target: string, Body: string) => Promise<PhoneActionResult>,
): CommandResult | Promise<CommandResult> {
  const Target = Args[0];
  if (Target === undefined || Args.length < 2) {
    return { Outcome: 'BadArgs', Reason: `Usage: /${Usage} <number|contact> <message>` };
  }
  return Resolve(Send(Target, Args.slice(1).join(' ')));
}

/** A positive integer log count, or 0 to let the service apply its default. */
function ParseCount(Arg: string | undefined): number {
  if (Arg === undefined || !/^\d+$/.test(Arg)) return 0;
  return Number.parseInt(Arg, 10);
}
