import type { LucideIcon } from "lucide-react";

/** A destination — a workflow, a web app, a report. */
export interface NavItem {
  /** Stable id. Used for the active-item check and for routing. */
  id: string;
  label: string;
  href: string;
  icon?: LucideIcon;
  /** Optional count badge — open items, pending approvals. */
  badge?: number | string;
  /** Nested destinations. One level only; deeper than that is a menu, not nav. */
  children?: NavItem[];
}

/** A named grouping of items inside a unit's nav. */
export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/**
 * A unit inside a team, with the apps scoped to it.
 *
 * Two names, deliberately, because they are read in different places for
 * different reasons.
 *
 * `label` is KOC's official designation — "Unit 1". It is what appears on a
 * form, in an email, in someone's job title, so the switcher list has to show it
 * or people cannot match what they see to what they were told.
 *
 * `name` is what the unit actually covers — "Deep", "Offshore".
 * That is what belongs in the sidebar header, because the header answers "where
 * am I?" and "Unit 1" answers nothing. A number is a good identifier and a bad
 * label; showing the number where the answer should be is how internal tools end
 * up needing a glossary.
 */
export interface Unit {
  id: string;
  /** KOC's official designation, e.g. "Unit 1". Shown in the switcher list. */
  label: string;
  /** What the unit covers, e.g. "Deep". Shown in the header. Falls back to `label`. */
  name?: string;
  groups: NavGroup[];
}

/** What to show when identifying the unit you are currently in. */
export function unitDisplayName(unit: Unit): string {
  return unit.name ?? unit.label;
}

/** The sentinel unit id meaning "show every unit's work at once". */
export const ALL_UNITS = "__all__";

/**
 * A team dashboard's full configuration.
 *
 * `directorate` and `group` are identity, not navigation — a user does not
 * navigate up to the directorate from here, they need to know which one they are
 * in. They render as context in the header, not as links.
 */
export interface TeamConfig {
  id: string;
  /** The team's full name. */
  name: string;
  /** What fits in a sidebar header — an abbreviated team name. */
  shortName: string;
  /** The parent directorate. Identity, not a link. */
  directorate: string;
  /** The parent group. Identity, not a link. */
  group: string;
  units: Unit[];
  /**
   * Apps that belong to the whole team regardless of unit — invoicing, GIS,
   * shared reporting. Always visible, never filtered by the unit switcher.
   */
  teamWide: NavGroup[];
}

/** Every nav item in a unit, flattened — for search and active-route matching. */
export function unitItems(unit: Unit): NavItem[] {
  return unit.groups.flatMap((g) => g.items.flatMap(flatten));
}

/** Every nav item a team exposes, across all units plus team-wide. */
export function teamItems(team: TeamConfig): NavItem[] {
  return [
    ...team.units.flatMap(unitItems),
    ...team.teamWide.flatMap((g) => g.items.flatMap(flatten)),
  ];
}

function flatten(item: NavItem): NavItem[] {
  return [item, ...(item.children?.flatMap(flatten) ?? [])];
}

/**
 * The groups to render for a given unit selection.
 *
 * With `ALL_UNITS`, each unit's groups are returned prefixed with the unit name,
 * so a team lead sees "Unit 3 · Well Reports" rather than four identically
 * labelled "Well Reports" entries with no way to tell them apart.
 */
export function groupsForUnit(team: TeamConfig, unitId: string): NavGroup[] {
  if (unitId !== ALL_UNITS) {
    return team.units.find((u) => u.id === unitId)?.groups ?? [];
  }

  return team.units.flatMap((unit) =>
    unit.groups.map((g) => ({
      ...g,
      id: `${unit.id}:${g.id}`,
      label: `${unit.label} · ${g.label}`,
    })),
  );
}
