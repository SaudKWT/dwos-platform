"use client";

import * as React from "react";
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_includesString,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type ColumnFiltersState,
  type RowData,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  Search,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * DataTable — the standard KOC table.
 *
 * WHY THIS IS BUILT AND NOT INSTALLED
 * -----------------------------------
 * There is no data table in the shadcn registry. `@shadcn/data-table` is named
 * as a registry dependency but is not published; the only match is
 * `data-table-demo`, typed `registry:example`, which the CLI will not install.
 * shadcn's data table is documentation showing how to wire TanStack Table to
 * the Table primitives — every project composes its own.
 *
 * The `dashboard-01` block does ship one, at 814 lines, and most of that is
 * demo scaffolding: drag-and-drop row reordering (@dnd-kit, four packages), a
 * drawer-based row viewer with an embedded chart, toast notifications for fake
 * saves, and a zod schema for the sample data. Twelve dependencies for one
 * table, including a second icon library. What was worth keeping is the TanStack
 * v9 wiring and the pagination layout; the rest is not a table, it is a demo.
 *
 * WHAT THIS ADDS OVER BOTH
 * ------------------------
 * 1. A loading state. Dashboards fetch; the reference assumes data has arrived.
 * 2. Empty and no-results as *different* states. "No wells in Unit 3" and "No
 *    wells match your filter" need different words and different recovery — one
 *    is a fact about the data, the other is a fact about the filter. The
 *    reference collapses both into "No results."
 * 3. Numeric alignment carried by column metadata rather than by memory. The
 *    README notes that tabular figures are applied automatically but "the
 *    alignment is the part you have to bring" — so it is declared once on the
 *    column, not re-remembered in every cell renderer.
 * 4. Real pagination: row counts, page size, first/last.
 *
 * Columns stay genuine TanStack ColumnDefs. This wraps the engine, it does not
 * replace it — custom sort functions, faceted filters and virtualisation all
 * remain available.
 */

/**
 * The feature set every KOC table registers.
 *
 * TanStack v9 tree-shakes anything not registered here, and a column helper is
 * typed against the exact feature set, so consumers must build columns with the
 * same one. That is why this is exported rather than kept private.
 */
export const kocTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    text: sortFn_text,
    basic: sortFn_basic,
  },
});

/** Build columns for a KOC table. Typed against `kocTableFeatures`. */
export function kocColumnHelper<T extends RowData>() {
  return createColumnHelper<typeof kocTableFeatures, T>();
}

/**
 * KOC-specific column metadata, set via TanStack's own `meta` field.
 *
 * `numeric: true` right-aligns the column and its header together. A column of
 * production volumes left-aligned shimmies by digit count and cannot be scanned;
 * tabular figures alone do not fix that, because the figures are only half of
 * it. Declaring it on the column means a cell renderer cannot forget.
 */
export interface KocColumnMeta {
  numeric?: boolean;
  /** Hide from the column-visibility menu and from narrow viewports. */
  secondary?: boolean;
}

function metaOf(column: { columnDef: { meta?: unknown } }): KocColumnMeta {
  return (column.columnDef.meta ?? {}) as KocColumnMeta;
}

export interface DataTableEmptyState {
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export interface DataTableProps<T extends RowData> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: any[];
  data: T[];
  /** Renders skeleton rows instead of content. */
  loading?: boolean;
  /** How many skeleton rows to show while loading. */
  loadingRows?: number;
  /** Shown when there is genuinely no data — not when a filter excluded it. */
  empty?: DataTableEmptyState;
  /** Column id the search box filters on. Omit to hide the search box. */
  filterColumn?: string;
  filterPlaceholder?: string;
  pageSize?: number;
  /** Accessible name for the table. Required — screen readers announce it. */
  caption: string;
  className?: string;
}

export function DataTable<T extends RowData>({
  columns,
  data,
  loading = false,
  loadingRows = 8,
  empty,
  filterColumn,
  filterPlaceholder = "Search…",
  pageSize = 10,
  caption,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] =
    React.useState<ColumnVisibilityState>({});

  const table = useTable({
    features: kocTableFeatures,
    data,
    columns,
    initialState: { pagination: { pageIndex: 0, pageSize } },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    state: { sorting, columnFilters, columnVisibility },
  });

  const rows = table.getRowModel().rows;
  const filteredCount = table.getFilteredRowModel().rows.length;
  const visibleColumnCount = table.getVisibleFlatColumns().length;

  // The distinction the reference implementation misses. `data.length === 0`
  // means there is nothing to show; `filteredCount === 0` with data present
  // means the filter excluded it. Same empty table, completely different message
  // and completely different thing for the user to do next.
  const isEmpty = !loading && data.length === 0;
  const isFilteredEmpty = !loading && data.length > 0 && filteredCount === 0;

  return (
    <div className={cn("w-full", className)}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 pb-3">
        {filterColumn && (
          <div className="relative max-w-sm flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={filterPlaceholder}
              placeholder={filterPlaceholder}
              className="pl-8"
              disabled={loading}
              value={
                (table.getColumn(filterColumn)?.getFilterValue() as string) ?? ""
              }
              onChange={(e) =>
                table.getColumn(filterColumn)?.setFilterValue(e.target.value)
              }
            />
          </div>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto" disabled={loading}>
              Columns
              <ChevronDown aria-hidden className="ml-1.5 size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table
              .getAllColumns()
              .filter((c) => c.getCanHide())
              .map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  className="capitalize"
                  checked={column.getIsVisible()}
                  onCheckedChange={(v) => column.toggleVisibility(!!v)}
                >
                  {column.id}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────── */}
      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <caption className="sr-only">{caption}</caption>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const numeric = metaOf(header.column).numeric;
                  const sorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();

                  return (
                    <TableHead
                      key={header.id}
                      // Header alignment follows the cells. A right-aligned
                      // column with a left-aligned header reads as a mistake.
                      className={cn(numeric && "text-right")}
                      aria-sort={
                        !canSort
                          ? undefined
                          : sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                      }
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          // The negative margin cancels the ghost button's own
                          // padding so the header label sits on the same optical
                          // line as the cell text below it — pulled left for text
                          // columns, right for numeric ones. `ml-auto` would do
                          // nothing here: a <th> is not a flex container, so the
                          // right-alignment comes from `text-right` on the cell
                          // acting on this inline-flex button.
                          className={cn("h-7", numeric ? "-mr-2" : "-ml-2")}
                          onClick={() =>
                            header.column.toggleSorting(sorted === "asc")
                          }
                        >
                          <table.FlexRender header={header} />
                          {sorted === "asc" ? (
                            <ArrowUp aria-hidden className="size-3.5" />
                          ) : sorted === "desc" ? (
                            <ArrowDown aria-hidden className="size-3.5" />
                          ) : (
                            <ChevronsUpDown
                              aria-hidden
                              className="size-3.5 opacity-50"
                            />
                          )}
                        </Button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>

          <TableBody>
            {loading ? (
              // Skeleton rows rather than a spinner: the layout does not jump
              // when data lands, and the shape tells you what is coming.
              Array.from({ length: loadingRows }, (_, i) => (
                <TableRow key={`skeleton-${i}`}>
                  {Array.from({ length: visibleColumnCount }, (_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={cn(metaOf(cell.column).numeric && "text-right")}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={visibleColumnCount} className="h-32">
                  {/*
                   * The dashed outline is doing work, not decoration: it says
                   * "content belongs here and is absent", where a bare centred
                   * sentence reads as "this area is finished and blank". A
                   * solid border would claim the space is a real container.
                   */}
                  {isFilteredEmpty ? (
                    <div className="mx-auto flex max-w-md flex-col items-center rounded-lg border border-dashed border-input px-6 py-6 text-center">
                      <p className="text-sm font-medium">No matching rows</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        No results for the current filter.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-3"
                        onClick={() => table.resetColumnFilters()}
                      >
                        Clear filter
                      </Button>
                    </div>
                  ) : isEmpty && empty ? (
                    <div className="mx-auto flex max-w-md flex-col items-center rounded-lg border border-dashed border-input px-6 py-6 text-center">
                      <p className="text-sm font-medium">{empty.title}</p>
                      {empty.description && (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {empty.description}
                        </p>
                      )}
                      {empty.action && <div className="mt-3">{empty.action}</div>}
                    </div>
                  ) : (
                    <div className="mx-auto flex max-w-md flex-col items-center rounded-lg border border-dashed border-input px-6 py-6 text-center">
                      <p className="text-sm text-muted-foreground">No rows.</p>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Pagination ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-4 pt-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {loading
            ? "Loading…"
            : filteredCount === data.length
              ? `${data.length} row${data.length === 1 ? "" : "s"}`
              : `${filteredCount} of ${data.length} rows`}
        </p>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Label htmlFor="koc-rows-per-page" className="text-sm font-normal">
              Rows per page
            </Label>
            <Select
              value={`${table.state.pagination?.pageSize ?? pageSize}`}
              onValueChange={(v) => table.setPageSize(Number(v))}
            >
              <SelectTrigger size="sm" className="w-18" id="koc-rows-per-page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                {[10, 25, 50, 100].map((n) => (
                  <SelectItem key={n} value={`${n}`}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-sm tabular-nums">
            Page {(table.state.pagination?.pageIndex ?? 0) + 1} of{" "}
            {Math.max(1, table.getPageCount())}
          </p>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">First page</span>
              <ChevronsLeft aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <span className="sr-only">Previous page</span>
              <ChevronLeft aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Next page</span>
              <ChevronRight aria-hidden />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <span className="sr-only">Last page</span>
              <ChevronsRight aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
