import { PhoneLog, type PhoneLogKind } from '@/Data/Models/PhoneLog.js';

/**
 * Persistence for SMS / voicemail / call history. All rows are keyed by
 * the owning phone NUMBER (item serial), so a traded handset keeps its
 * log. SMS and voicemail each write two rows: the sender's `Out` (already
 * read) and the recipient's `In` (unread). The caller must authorize
 * reads against the set of numbers it currently holds - this repository
 * does no ownership check itself.
 */
export class PhoneLogRepository {
  /** Record a delivered SMS: sender Out (read), recipient In (unread). */
  async AppendSms(SenderNumber: string, RecipientNumber: string, Body: string): Promise<void> {
    await PhoneLog.bulkCreate([
      { OwnerNumber: SenderNumber, Kind: 'Sms', Direction: 'Out', PeerNumber: RecipientNumber, Body, IsRead: true },
      { OwnerNumber: RecipientNumber, Kind: 'Sms', Direction: 'In', PeerNumber: SenderNumber, Body, IsRead: false },
    ]);
  }

  /** Record a voicemail: sender Out (read), recipient In (unread). */
  async AppendVoicemail(SenderNumber: string, RecipientNumber: string, Body: string): Promise<void> {
    await PhoneLog.bulkCreate([
      { OwnerNumber: SenderNumber, Kind: 'Voicemail', Direction: 'Out', PeerNumber: RecipientNumber, Body, IsRead: true },
      { OwnerNumber: RecipientNumber, Kind: 'Voicemail', Direction: 'In', PeerNumber: SenderNumber, Body, IsRead: false },
    ]);
  }

  /**
   * Record a finished call: caller Out, callee In (answered) or Missed
   * (unanswered). Call rows are read-only history (no unread badge), so
   * both are stored read.
   */
  async AppendCall(
    CallerNumber: string,
    CalleeNumber: string,
    DurationSec: number,
    Answered: boolean,
  ): Promise<void> {
    await PhoneLog.bulkCreate([
      {
        OwnerNumber: CallerNumber,
        Kind: 'Call',
        Direction: 'Out',
        PeerNumber: CalleeNumber,
        DurationSec,
        IsRead: true,
      },
      {
        OwnerNumber: CalleeNumber,
        Kind: 'Call',
        Direction: Answered ? 'In' : 'Missed',
        PeerNumber: CallerNumber,
        DurationSec: Answered ? DurationSec : 0,
        IsRead: true,
      },
    ]);
  }

  /** Most-recent-first rows of one kind for one number. The `ID` tiebreaker
   * keeps same-second rows in true insertion order (created_at is DATETIME
   * with second precision, so created_at alone is non-deterministic). */
  ListByOwner(OwnerNumber: string, Kind: PhoneLogKind, Limit: number): Promise<PhoneLog[]> {
    return PhoneLog.findAll({
      where: { OwnerNumber, Kind },
      order: [
        ['CreatedAt', 'DESC'],
        ['ID', 'DESC'],
      ],
      limit: Limit,
    });
  }

  /** Most-recent-first INBOUND rows of one kind (e.g. the voicemail inbox).
   * Filters direction in SQL so the limit counts only inbound rows and an
   * outbound flood cannot push real inbound rows out of the window. */
  ListInbound(OwnerNumber: string, Kind: PhoneLogKind, Limit: number): Promise<PhoneLog[]> {
    return PhoneLog.findAll({
      where: { OwnerNumber, Kind, Direction: 'In' },
      order: [
        ['CreatedAt', 'DESC'],
        ['ID', 'DESC'],
      ],
      limit: Limit,
    });
  }

  /** Fetch a single row by id (the caller authorizes ownership). */
  FindById(ID: string): Promise<PhoneLog | null> {
    return PhoneLog.findByPk(ID);
  }

  /** Flag one row read. */
  async MarkRead(ID: string): Promise<void> {
    await PhoneLog.update({ IsRead: true }, { where: { ID } });
  }

  /** Flag the given rows read (used to mark only the rows actually shown). */
  async MarkReadMany(IDs: readonly string[]): Promise<void> {
    if (IDs.length === 0) return;
    await PhoneLog.update({ IsRead: true }, { where: { ID: IDs as string[] } });
  }

  /** Count unread inbound rows of one kind for one number. */
  CountUnread(OwnerNumber: string, Kind: PhoneLogKind): Promise<number> {
    return PhoneLog.count({ where: { OwnerNumber, Kind, Direction: 'In', IsRead: false } });
  }
}
