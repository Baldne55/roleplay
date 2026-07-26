import { ChatFormatter } from '@Shared/Chat/Index.js';
import { NetEvents, type NetEventPayloads } from '@Shared/Events/NetEvents.js';
import type { CommandContext, CommandResult } from '@/Services/CommandTypes.js';
import type { CommandRegistry } from '@/Services/CommandRegistry.js';
import type { AnticheatService } from '@/Services/AnticheatService.js';
import type { AnticheatViolationRepository } from '@/Data/Repositories/AnticheatViolationRepository.js';
import type { WeaponDischargeLogRepository } from '@/Data/Repositories/WeaponDischargeLogRepository.js';
import type { PlayerStateService } from '@/Services/PlayerStateService.js';
import type { ChatService } from '@/Services/ChatService.js';
import type { AnticheatViolation } from '@/Data/Models/AnticheatViolation.js';
import type { WeaponDischargeLog } from '@/Data/Models/WeaponDischargeLog.js';
import { StaffMeets } from '@/Services/StaffLevelRanking.js';

/* eslint-disable @typescript-eslint/naming-convention -- CitizenFX engine surface: names fixed by the runtime */
declare function emitNet(EventName: string, Target: number, ...Args: unknown[]): void;
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * `/ac` - anti-cheat lookup surface (read-only, Moderator+, on duty).
 *
 *   /ac recent [count]      latest persisted violations, all players
 *   /ac player <id> [count] persisted violations for a connected player
 *   /ac stats <id>          hit-pattern statistics for a connected player
 *   /ac status              enforcement mode + live session scores
 *   /ac test <case>         Founder-only pipeline self-tests (no cheat
 *                           tooling required); cases run on the issuer
 *
 * Mirrors the `/aitem` dispatcher shape: one parent command, a typed
 * subcommand table, bare `/ac` prints the grouped help block. The
 * parent gate is Moderator; `test` re-checks Founder via StaffMeets,
 * the `/aitem` blast-radius pattern.
 */

/**
 * A `/ac` subcommand body. Receives the args after the subcommand name.
 * Always async even for the synchronous cases (`status`, `test`), which
 * wrap their results in Promise.resolve - a uniform signature keeps the
 * dispatcher a single `return Sub.Handler(...)` with no branching.
 */
type SubHandler = (Ctx: CommandContext, SubArgs: string[]) => Promise<CommandResult>;

/**
 * One `/ac` subcommand. No per-entry tier gate here, unlike `/aitem` -
 * the whole cluster sits behind a single staff gate on the parent because
 * every subcommand is read-only or a self-targeted drill.
 */
interface SubCommand {
  readonly Name: string;
  readonly Params: string;
  readonly Description: string;
  readonly Handler: SubHandler;
}

/** Rows returned by `recent` / `player` when no count is given. */
const DefaultCount = 10;
/**
 * Ceiling on a requested row count. Each row is its own chat line, so an
 * unbounded `/ac recent 5000` would flood the issuer's scrollback and
 * push everything else out of the 100-message buffer.
 */
const MaxCount = 25;
/**
 * Hit-pattern sample window for `/ac stats` - aggregation happens in the
 * handler over this many newest rows, not in SQL. Kept well above
 * MaxCount because these rows are counted, not printed.
 */
const StatsSampleSize = 200;
/**
 * How many component / weapon buckets `/ac stats` prints. Three is enough
 * to show a concentration (an aimbot spikes one component) without the
 * long tail of single-hit buckets burying it.
 */
const StatsTopBuckets = 3;

/**
 * Wire the `/ac` dispatcher - the staff window onto the anti-cheat layer.
 *
 * Two data sources behind it: the violations table (what was recorded)
 * and the service's in-memory session scores (what the scorer currently
 * believes). They disagree by design - score accrues before it crosses a
 * threshold worth storing.
 */
export function Register(
  Registry: CommandRegistry,
  Anticheat: AnticheatService,
  Violations: AnticheatViolationRepository,
  State: PlayerStateService,
  Chat: ChatService,
  DischargeLog: WeaponDischargeLogRepository,
): void {
  const Subs: SubCommand[] = [
    {
      Name: 'recent',
      Params: '[count]',
      Description: 'Latest violations across all players.',
      Handler: async (Ctx, Sub) => {
        const Count = ParseCount(Sub[0]);
        const Rows = await Violations.Recent(Count);
        RenderRows(Chat, Ctx.Source, `ANTICHEAT - LAST ${Count}`, Rows);
        return { Outcome: 'Ok' };
      },
    },
    {
      Name: 'player',
      Params: '<player_id> [count]',
      Description: 'Violations for a connected player (by Source).',
      Handler: async (Ctx, Sub) => {
        const Target = Number(Sub[0]);
        if (!Number.isInteger(Target) || Target <= 0) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /ac player <player_id> [count]' };
        }
        const TargetState = State.Get(Target);
        if (TargetState === null) {
          return { Outcome: 'Ok', Reply: ChatFormatter.Error(`No connected player with ID ${Target}.`) };
        }
        if (TargetState.AccountID === null) {
          return { Outcome: 'Ok', Reply: ChatFormatter.Info('That player has not authenticated yet.') };
        }
        const Count = ParseCount(Sub[1]);
        const Rows = await Violations.FindByAccount(TargetState.AccountID, Count);
        RenderRows(Chat, Ctx.Source, `ANTICHEAT - PLAYER ${Target}`, Rows);
        const Live = Anticheat.GetSessionScores(Target);
        if (Live.length > 0) {
          const Summary = Live.map((S) => `${S.Type} ${S.Score}`).join(', ');
          Chat.SendTo(Ctx.Source, ChatFormatter.Label('SESSION', Summary));
        }
        return { Outcome: 'Ok' };
      },
    },
    {
      Name: 'stats',
      Params: '<player_id>',
      Description: 'Hit-pattern statistics for a connected player.',
      Handler: async (Ctx, Sub) => {
        const Target = Number(Sub[0]);
        if (!Number.isInteger(Target) || Target <= 0) {
          return { Outcome: 'BadArgs', Reason: 'Usage: /ac stats <player_id>' };
        }
        const TargetState = State.Get(Target);
        if (TargetState === null) {
          return { Outcome: 'Ok', Reply: ChatFormatter.Error(`No connected player with ID ${Target}.`) };
        }
        if (TargetState.CharacterID === null) {
          return { Outcome: 'Ok', Reply: ChatFormatter.Info('That player has not spawned into a character.') };
        }
        const Rows = await DischargeLog.ListByShooter(TargetState.CharacterID, StatsSampleSize);
        RenderStats(Chat, Ctx.Source, Target, Rows);
        return { Outcome: 'Ok' };
      },
    },
    {
      Name: 'test',
      Params: '<bagwrite|report|silence>',
      Description: 'Founder-only pipeline self-tests, run on yourself.',
      Handler: (Ctx, Sub) => {
        // Blast-radius re-check: the parent gate is Moderator, but the
        // test harness simulates cheat-shaped behaviour and bypasses
        // the staff exemption - Founder only.
        if (Ctx.Account === null || !StaffMeets(Ctx.Account.StaffLevel, 'Founder')) {
          return Promise.resolve<CommandResult>({ Outcome: 'PermissionDenied' });
        }
        const Case = (Sub[0] ?? '').toLowerCase();
        if (Case === 'bagwrite') {
          const Payload: NetEventPayloads[typeof NetEvents.AnticheatTestDirective] = { Case: 'BagWrite' };
          emitNet(NetEvents.AnticheatTestDirective, Ctx.Source, Payload);
          return Promise.resolve<CommandResult>({
            Outcome: 'Ok',
            Reply: ChatFormatter.Info(
              'Canary dispatched. A StateBag warn with a non-zero reserved value in the server console ' +
                'confirms the client-origin signal; no warn within a few seconds means client bag writes ' +
                'do not replicate on this build.',
            ),
          });
        }
        if (Case === 'report') {
          Anticheat.InjectTestReport(Ctx.Source);
          return Promise.resolve<CommandResult>({
            Outcome: 'Ok',
            Reply: ChatFormatter.Info(
              'Synthetic report injected (evidence marked Test). Check /ac recent for the row; ' +
                'a second injection this session crosses the alert threshold and exercises the ' +
                'staff alert and the Discord webhook.',
            ),
          });
        }
        if (Case === 'silence') {
          const Payload: NetEventPayloads[typeof NetEvents.AnticheatTestDirective] = { Case: 'MonitorSilence' };
          emitNet(NetEvents.AnticheatTestDirective, Ctx.Source, Payload);
          return Promise.resolve<CommandResult>({
            Outcome: 'Ok',
            Reply: ChatFormatter.Info(
              'Monitor silenced for sixty seconds. Expect a MonitorSilent entry in the server console ' +
                'within forty-five seconds (logged as exempt while you are on duty), then automatic recovery.',
            ),
          });
        }
        return Promise.resolve<CommandResult>({
          Outcome: 'BadArgs',
          Reason: 'Usage: /ac test <bagwrite|report|silence>',
        });
      },
    },
    {
      Name: 'status',
      Params: '',
      Description: 'Enforcement mode and live session scores.',
      Handler: (Ctx) => {
        Chat.SendTo(Ctx.Source, ChatFormatter.Header('ANTICHEAT STATUS'));
        Chat.SendTo(Ctx.Source, ChatFormatter.Label('MODE', Anticheat.EnforcementMode));
        let Flagged = 0;
        for (const Source of State.GetAllSources()) {
          const Scores = FormatSessionScores(Anticheat, Source);
          if (Scores.length === 0) continue;
          Flagged += 1;
          Chat.SendTo(Ctx.Source, ChatFormatter.Label(`PLAYER ${Source}`, Scores));
        }
        if (Flagged === 0) {
          Chat.SendTo(Ctx.Source, ChatFormatter.Info('No session scores recorded.'));
        }
        Chat.SendTo(Ctx.Source, ChatFormatter.Footer());
        return Promise.resolve<CommandResult>({ Outcome: 'Ok' });
      },
    },
  ];

  Registry.Add({
    Name: 'ac',
    Description: 'Anti-cheat violation lookup.',
    Params: '<subcommand> [...]',
    Category: 'Admin',
    RequiredStaffLevel: 'Moderator',
    Run: async (Ctx): Promise<CommandResult> => {
      const SubName = (Ctx.Args[0] ?? '').toLowerCase();
      if (SubName.length === 0 || SubName === 'help' || SubName === '?') {
        SendHelp(Chat, Ctx.Source, Subs);
        return { Outcome: 'Ok' };
      }
      const Sub = Subs.find((S) => S.Name === SubName);
      if (Sub === undefined) {
        return {
          Outcome: 'Ok',
          Reply: ChatFormatter.Error(`Unknown subcommand. See ${ChatFormatter.Cmd('/ac')} for the list.`),
        };
      }
      return Sub.Handler(Ctx, Ctx.Args.slice(1));
    },
  });
}

/**
 * Clamp a row-count argument into [1, MaxCount], falling back to
 * DefaultCount for anything missing or nonsensical.
 *
 * Never errors on bad input: an admin chasing a live cheater should get
 * a listing, not a usage lecture, so a typo silently yields the default.
 * The ceiling exists because each row is its own chat line.
 */
function ParseCount(Raw: string | undefined): number {
  const Parsed = Number(Raw);
  if (!Number.isInteger(Parsed) || Parsed <= 0) return DefaultCount;
  return Math.min(Parsed, MaxCount);
}

/** Print the `/ac` subcommand index, one chat line per entry. */
function SendHelp(Chat: ChatService, Source: number, Subs: SubCommand[]): void {
  Chat.SendTo(Source, ChatFormatter.Header('ANTICHEAT COMMANDS'));
  for (const Sub of Subs) {
    Chat.SendTo(
      Source,
      ChatFormatter.Label(Sub.Name.toUpperCase(), `/ac ${Sub.Name} ${Sub.Params}`.trimEnd() + ` - ${Sub.Description}`),
    );
  }
  Chat.SendTo(Source, ChatFormatter.Footer());
}

/**
 * Print violation rows one line each: id, timestamp, detection type,
 * tier, running session score, the action taken, and both identities.
 *
 * `action=` is the important column when reading a listing - with
 * enforcement in the default observe mode, rows accumulate showing
 * `observe`, meaning the detection fired but nobody was kicked. A wall of
 * violations is therefore not evidence that enforcement is working.
 *
 * Emitted as separate SendTo calls rather than one joined block so a long
 * listing cannot exceed a single message's length budget.
 */
function RenderRows(Chat: ChatService, Source: number, Title: string, Rows: AnticheatViolation[]): void {
  Chat.SendTo(Source, ChatFormatter.Header(Title));
  if (Rows.length === 0) {
    Chat.SendTo(Source, ChatFormatter.Info('No violations recorded.'));
  }
  for (const Row of Rows) {
    const Stamp = FormatStamp(Row.OccurredAt);
    Chat.SendTo(
      Source,
      ChatFormatter.Label(
        `#${Row.ID}`,
        `${Stamp} ${Row.DetectionType} t${Row.Tier} score=${Row.SessionScore} ` +
          `action=${Row.Action} acct=${Row.AccountID ?? '-'} char=${Row.CharacterID ?? '-'}`,
      ),
    );
  }
  Chat.SendTo(Source, ChatFormatter.Footer());
}

/**
 * `/ac stats` - aggregate the newest discharge rows into a
 * hit-pattern block. Component ids stay raw numbers on purpose
 * (no bone-name mapping exists server-side); an aimbot reads as an
 * abnormal concentration on one id, whatever it is called.
 */
function RenderStats(Chat: ChatService, Source: number, Target: number, Rows: WeaponDischargeLog[]): void {
  Chat.SendTo(Source, ChatFormatter.Header(`ANTICHEAT - STATS PLAYER ${Target}`));
  if (Rows.length === 0) {
    Chat.SendTo(Source, ChatFormatter.Info('No discharges recorded for this character.'));
    Chat.SendTo(Source, ChatFormatter.Footer());
    return;
  }

  // One pass: span bounds + the component / victim / weapon buckets.
  let NewestMs = Number.NEGATIVE_INFINITY;
  let OldestMs = Number.POSITIVE_INFINITY;
  const ComponentCounts = new Map<number, number>();
  let NullComponents = 0;
  const VictimIDs = new Set<string>();
  let UnresolvedVictims = 0;
  const WeaponCounts = new Map<string, number>();
  for (const Row of Rows) {
    const Ms = Row.OccurredAt.getTime();
    if (Ms > NewestMs) NewestMs = Ms;
    if (Ms < OldestMs) OldestMs = Ms;
    if (Row.HitComponent === null) NullComponents += 1;
    else ComponentCounts.set(Row.HitComponent, (ComponentCounts.get(Row.HitComponent) ?? 0) + 1);
    if (Row.VictimCharacterID === null) UnresolvedVictims += 1;
    else VictimIDs.add(Row.VictimCharacterID);
    WeaponCounts.set(Row.WeaponTypeID, (WeaponCounts.get(Row.WeaponTypeID) ?? 0) + 1);
  }
  const SpanMinutes = (NewestMs - OldestMs) / 60_000;

  Chat.SendTo(
    Source,
    ChatFormatter.Label('SAMPLE', `${Rows.length} hits spanning ${SpanMinutes.toFixed(1)} min`),
  );
  if (Rows.length === 1) {
    Chat.SendTo(Source, ChatFormatter.Label('RATE', '1 hit'));
  } else if (SpanMinutes <= 0) {
    Chat.SendTo(Source, ChatFormatter.Label('RATE', `${Rows.length} hits (zero-length span)`));
  } else {
    Chat.SendTo(Source, ChatFormatter.Label('RATE', `${(Rows.length / SpanMinutes).toFixed(2)} hits/min`));
  }

  const Components = Array.from(ComponentCounts.entries())
    .sort((A, B) => B[1] - A[1])
    .slice(0, StatsTopBuckets)
    .map(([Value, Count]) => `${Value}: ${Count} (${((Count / Rows.length) * 100).toFixed(0)}%)`);
  if (NullComponents > 0) Components.push(`null: ${NullComponents}`);
  Chat.SendTo(Source, ChatFormatter.Label('COMPONENTS', Components.join(', ')));

  const VictimParts = [`${VictimIDs.size} distinct characters`];
  if (UnresolvedVictims > 0) VictimParts.push(`${UnresolvedVictims} NPC/unresolved`);
  Chat.SendTo(Source, ChatFormatter.Label('VICTIMS', VictimParts.join(', ')));

  const Weapons = Array.from(WeaponCounts.entries())
    .sort((A, B) => B[1] - A[1])
    .slice(0, StatsTopBuckets)
    .map(([TypeID, Count]) => `${TypeID}: ${Count}`)
    .join(', ');
  Chat.SendTo(Source, ChatFormatter.Label('WEAPONS', Weapons));

  Chat.SendTo(Source, ChatFormatter.Footer());
}

/**
 * `MM-DD HH:MM` in server-local time. Deliberately short and year-less:
 * these listings are read while an incident is live, and the column
 * competes for width with the detection payload on the same line.
 */
function FormatStamp(At: Date): string {
  const Pad = (N: number): string => String(N).padStart(2, '0');
  return `${Pad(At.getMonth() + 1)}-${Pad(At.getDate())} ${Pad(At.getHours())}:${Pad(At.getMinutes())}`;
}

/**
 * Flatten a player's live per-detection scores into one line.
 *
 * Reads in-memory session state rather than the violations table, so it
 * shows what the scorer currently believes about a player right now -
 * including score that has accrued without yet crossing a threshold and
 * therefore has no stored row behind it.
 */
function FormatSessionScores(Anticheat: AnticheatService, Source: number): string {
  return Anticheat.GetSessionScores(Source)
    .map((S) => `${S.Type} ${S.Score}`)
    .join(', ');
}
