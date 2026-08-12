/**
 * Where this dashboard's org config meets the DWOS database.
 *
 * The nav is a `TeamConfig` (see ./dwos.ts) and the database is `schema0726`.
 * They describe the same organisation twice, so the join between them has to be
 * written down somewhere — otherwise it gets rediscovered, differently, in every
 * query someone writes.
 *
 * TWO TABLES CARRY IT
 * -------------------
 * `dbo.Entity` is the org hierarchy: `EntityCode`, `EntityName`, `EntityTypeID`
 * and a self-referencing `ParentEntityID`. Directorate → Group → Team → Unit is
 * four rows deep in that one table. A unit in this config is an Entity row.
 *
 * `TeamID` on `dbo.RigInfo` and `dbo.Workover` is how operational work is scoped
 * to one of those units. It is the column a unit-filtered query filters on, and
 * it is the reason the unit switcher is more than cosmetic.
 *
 * WHY THE IDS ARE NULL
 * --------------------
 * The schema file defines the tables; it carries no rows. Inventing plausible
 * integers here would be worse than leaving them empty — a wrong `TeamID` does
 * not error, it silently returns another unit's rigs. So each unit declares the
 * shape of its binding and leaves the value unresolved until someone reads it
 * off the live database:
 *
 *   SELECT e.ID, e.EntityCode, e.EntityName, e.ParentEntityID
 *   FROM dbo.Entity e
 *   JOIN dbo.EntityType t ON t.ID = e.EntityTypeID
 *   WHERE t.TypeName = 'Unit' AND e.IsActive = 1;
 *
 * `unitScopeReady()` reports whether that has happened, so a screen can show
 * "not scoped to this unit yet" instead of quietly showing everything.
 */

/** One unit's join to the database. */
export interface UnitBinding {
  /** `dbo.Entity.EntityCode` for this unit. Null until read off the database. */
  entityCode: string | null;
  /** `dbo.Entity.ID`, which is what `RigInfo.TeamID` / `Workover.TeamID` hold. */
  teamId: number | null;
}

/**
 * Keyed by the `Unit.id` used in the nav config. Every unit is present so the
 * map is exhaustive by inspection — a missing key and an unresolved value are
 * different problems, and only one of them is expected.
 */
export const UNIT_BINDINGS: Record<string, UnitBinding> = {
  "unit-1": { entityCode: null, teamId: null },
  "unit-2": { entityCode: null, teamId: null },
  "unit-3": { entityCode: null, teamId: null },
  "unit-4": { entityCode: null, teamId: null },
  "unit-5": { entityCode: null, teamId: null },
  "unit-6": { entityCode: null, teamId: null },
  "unit-7": { entityCode: null, teamId: null },
};

/** True once this unit can actually filter `RigInfo` / `Workover` rows. */
export function unitScopeReady(unitId: string): boolean {
  return UNIT_BINDINGS[unitId]?.teamId != null;
}

/**
 * The `TeamID` to filter on, or null when the binding is unresolved.
 *
 * Callers must treat null as "cannot scope" and say so, never as "no filter" —
 * an unscoped query on a unit screen shows the whole directorate's work and
 * looks entirely normal doing it.
 */
export function teamIdFor(unitId: string): number | null {
  return UNIT_BINDINGS[unitId]?.teamId ?? null;
}
