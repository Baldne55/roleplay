import type { StaffLevel } from '@/Data/Models/Account.js';

/**
 * Ordinal ranking for the StaffLevel enum. Higher = more authority.
 * The values are private to this module - call sites should use
 * StaffMeets, not compare numbers directly.
 */
const StaffLevelOrder: Record<StaffLevel, number> = {
  None: 0,
  Helper: 1,
  Moderator: 2,
  Administrator: 3,
  Founder: 4,
};

/**
 * True when an account at `Have` is at least as authoritative as
 * `Required`. Used by the command dispatcher to gate RequiredStaffLevel.
 */
export function StaffMeets(Have: StaffLevel, Required: StaffLevel): boolean {
  return StaffLevelOrder[Have] >= StaffLevelOrder[Required];
}
