import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CharacterSummary } from '@Shared/Constants/Character';

/**
 * Selector store. Holds the per-account character list plus the in-flight
 * load + select state. Kept separate from UseCharacterStore so the
 * wizard's reactive ped/preview state doesn't bleed into a view that
 * only reads display fields.
 *
 *   LoadList():
 *     Sends an NUI POST that the Frontend forwards to the server as a
 *     CharacterList net event. The actual list payload arrives async
 *     via CharacterListLoaded -> ReceiveList. Short-circuits if a
 *     load is already in flight.
 *
 *   Select(ID):
 *     Sends an NUI POST. The server replies via CharacterSpawned (UI
 *     receives CharacterSpawning) on success or CharacterSelectFailure
 *     (UI receives CharacterSelectFailed -> HandleFailure) on rejection.
 */
/**
 * Fetch state for the character list. 'Failed' is recoverable - the
 * selector offers a retry - so it is distinct from an empty 'Loaded',
 * which legitimately means the account owns no characters.
 */
export type ListStatus = 'Idle' | 'Loading' | 'Loaded' | 'Failed';

/**
 * The character roster and the in-flight selection, per the flow in the
 * file header above. Holds no appearance data - that lives in the
 * Character store; this one only ever deals in summaries.
 */
export const UseCharacterListStore = defineStore('CharacterList', () => {
  const Characters = ref<CharacterSummary[]>([]);
  const Status = ref<ListStatus>('Idle');
  const Reason = ref<string | null>(null);
  const SelectingID = ref<string | null>(null);

  const HasCharacters = computed<boolean>(() => Characters.value.length > 0);

  async function LoadList(): Promise<void> {
    if (Status.value === 'Loading') return;
    Status.value = 'Loading';
    Reason.value = null;
    try {
      await fetch('https://roleplay/CharacterList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (Err: unknown) {
      Status.value = 'Failed';
      Reason.value = `Could not contact the server: ${String(Err)}`;
    }
  }

  function ReceiveList(Next: CharacterSummary[]): void {
    Characters.value = Next;
    Status.value = 'Loaded';
    Reason.value = null;
  }

  async function Select(ID: string): Promise<void> {
    if (SelectingID.value !== null) return;
    SelectingID.value = ID;
    Reason.value = null;
    try {
      await fetch('https://roleplay/CharacterSelect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ CharacterID: ID }),
      });
    } catch (Err: unknown) {
      SelectingID.value = null;
      Reason.value = `Could not contact the server: ${String(Err)}`;
    }
  }

  function HandleFailure(Why: string): void {
    SelectingID.value = null;
    Reason.value = Why;
  }

  function Reset(): void {
    Characters.value = [];
    Status.value = 'Idle';
    Reason.value = null;
    SelectingID.value = null;
  }

  return {
    Characters,
    Status,
    Reason,
    SelectingID,
    HasCharacters,
    LoadList,
    ReceiveList,
    Select,
    HandleFailure,
    Reset,
  };
});
