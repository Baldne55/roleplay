import type { Deferrals } from './Deferrals.js';

/**
 * Connection queue contract.
 *
 * `Admit` is the only entry point from `playerConnecting`. It decides
 * synchronously whether there's a free slot (admit immediately) or whether
 * the player must wait in the queue (the returned promise resolves when
 * their slot opens). The caller awaits and then lets the player through;
 * the deferral object is owned by the queue while waiting.
 *
 * `Remove` is the cleanup hook from `playerDropped` (queued source matches
 * because Source is the temp-id we stored when queuing).
 *
 * `NotifyJoined` is called from `playerJoining` to free one in-flight slot.
 * We deliberately don't take a Source - the source in `playerJoining` is
 * the FINAL player ID (1, 2, ...) whereas the one we stored during
 * `playerConnecting` is the TEMP id (65535+N). They don't correlate, so we
 * treat in-flight as a FIFO counter, not a keyed map.
 */
export interface IQueueService {
  Admit(Source: number, Deferrals: Deferrals): Promise<void>;
  Remove(Source: number): void;
  NotifyJoined(): void;
  Size(): number;
}
