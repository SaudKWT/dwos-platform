import * as React from "react";
import { ChevronRight, ChevronsUpDown, Check, PanelLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ALL_UNITS,
  groupsForUnit,
  unitDisplayName,
  type NavGroup,
  type NavItem,
  type TeamConfig,
} from "@/lib/org";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NotificationMenu, type NotificationItem } from "@/components/ui/notification-menu";
import { initials, type UserMenuItem } from "@/components/ui/user-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * AppShell — the standard KOC team dashboard frame.
 *
 * One dashboard is one **team**. The unit is a context you switch, not a nav
 * section you scroll past: seven units × five apps is thirty-five permanent
 * items, thirty-four of which are irrelevant to any given user. See lib/org.ts
 * for the full reasoning.
 *
 * The shell holds three zones, and which zone an app lands in is decided by its
 * scope rather than by whoever adds it:
 *
 *   1. Unit switcher (header)  — which unit's work you are looking at
 *   2. Unit nav (content)      — that unit's workflows and apps
 *   3. Team-wide (content)     — invoicing, GIS, shared reporting. Never filtered.
 *
 * Building a dashboard for another KOC team means writing a TeamConfig. No JSX,
 * no new component, no fork. That is the whole point — there are on the order of
 * a few hundred teams, and a hand-built sidebar each is how a standard dies.
 */

export interface AppShellUser {
  name: string;
  role?: string;
}

export interface AppShellProps {
  team: TeamConfig;
  /** Controlled unit selection. Omit to let the shell manage it. */
  unitId?: string;
  defaultUnitId?: string;
  onUnitChange?: (unitId: string) => void;
  /** `id` of the currently open NavItem, for the active state. */
  activeItemId?: string;
  user?: AppShellUser;
  /**
   * How a nav destination becomes a link.
   *
   * KOC teams are not on one router — some will be on React Router, some on
   * Next, some on plain anchors inside an existing SharePoint shell. Baking in
   * any one of those makes the shell unusable for the other two, so routing is
   * the consumer's to supply and a plain `<a>` is the default.
   */
  /** Must return an element (an `<a>`, or your router's Link) — it becomes
   *  the rendered control via Base UI's render prop. */
  renderLink?: (item: NavItem, children: React.ReactNode) => React.ReactElement;
  /**
   * Operational alerts. Omit to hide the bell entirely — an empty notification
   * icon that never does anything is worse than no icon.
   */
  notifications?: NotificationItem[];
  onNotificationSelect?: (item: NotificationItem) => void;
  onMarkAllRead?: () => void;
  /**
   * Account menu groups. Each array is a group, rendered with a separator —
   * put sign out in its own so it is not one pixel below Settings.
   */
  userMenu?: UserMenuItem[][];
  /**
   * When the figures on screen were last refreshed, shown in the top bar.
   *
   * Opt-in like `notifications`: omitted, nothing renders. A freshness stamp
   * nobody wired to a real refresh is worse than none, because it is believed.
   * Pass a Date to have it formatted, or a string to control the wording.
   */
  asOf?: Date | string;
  children?: React.ReactNode;
}

const defaultRenderLink: NonNullable<AppShellProps["renderLink"]> = (item, children) => (
  <a href={item.href}>{children}</a>
);

export function AppShell({
  team,
  unitId,
  defaultUnitId,
  onUnitChange,
  activeItemId,
  user,
  renderLink = defaultRenderLink,
  notifications,
  onNotificationSelect,
  onMarkAllRead,
  userMenu,
  asOf,
  children,
}: AppShellProps) {
  const [internalUnit, setInternalUnit] = React.useState(
    defaultUnitId ?? team.units[0]?.id ?? ALL_UNITS,
  );
  const currentUnit = unitId ?? internalUnit;

  const selectUnit = (id: string) => {
    if (unitId === undefined) setInternalUnit(id);
    onUnitChange?.(id);
  };

  const unitGroups = groupsForUnit(team, currentUnit);
  const activeUnit = team.units.find((u) => u.id === currentUnit);
  // The header shows what the unit *covers*, not its number — "Deep" rather than
  // "Unit 3". The number stays in the switcher list, where it is needed to match
  // against forms and job titles.
  const unitLabel =
    currentUnit === ALL_UNITS
      ? "All units"
      : activeUnit
        ? unitDisplayName(activeUnit)
        : "—";

  return (
    <SidebarProvider>
      {/*
       * `role="navigation"` with a label, on the sidebar itself.
       *
       * The shell produced `main` and two `header`s, and the sidebar — every nav
       * link, every group label, the unit switcher, the user menu — sat in none
       * of them. axe reported 19 `region` nodes on a typical DWOS screen.
       *
       * Two consequences, and the second is the one that wastes an afternoon.
       * Screen-reader users lose landmark navigation to the primary nav, which
       * is how you reach it without tabbing the page. And
       * `getByRole('navigation')` finds the BREADCRUMB, because that was the
       * only nav on the page — a consumer writing the obvious test gets three
       * links and concludes their sidebar is broken.
       *
       * The label is not optional: PageHeader's breadcrumb is also a nav, and
       * two unlabelled navigation landmarks are worse than one.
       *
       * Reported from the DWOS app. It could not be found from the docs site,
       * where the shell is embedded inside a page that already has a `main`.
       */}
      <Sidebar
        collapsible="icon"
        role="navigation"
        aria-label={`${team.shortName} navigation`}
      >
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      /* The switcher is the one place the brand appears at full
                         strength in the chrome — it is also the control that
                         tells you what you are looking at, so it earns the
                         emphasis. */
                      className="data-popup-open:bg-sidebar-accent"
                    />
                  }
                >
                    <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                      <PanelLeft className="size-4" />
                    </div>
                    {/* `min-w-0` is what makes `truncate` work on the children.
                        A grid item's default `min-width: auto` refuses to shrink
                        below its content, so without it the text pushes the row
                        wider instead of ellipsing and the chevron gets shoved
                        out. `title` keeps the full name reachable when it does
                        truncate. */}
                    <div className="grid min-w-0 flex-1 text-left leading-tight">
                      <span className="truncate text-sm font-semibold" title={team.name}>
                        {team.shortName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {unitLabel}
                      </span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4" />
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  className="w-[var(--anchor-width)] min-w-64"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                >
                  {/* Directorate and group are identity, not navigation — you do
                      not travel up to them from a team dashboard, you just need
                      to know which one you are in. */}
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {team.directorate} · {team.group}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />

                  {team.units.map((unit) => (
                    <DropdownMenuItem
                      key={unit.id}
                      onClick={() => selectUnit(unit.id)}
                      className="gap-2"
                    >
                      {/* The list keeps KOC's numbering as the primary line —
                          that is the designation people are given — with the
                          coverage underneath so the number is decodable. */}
                      <div className="grid min-w-0 flex-1">
                        <span>{unit.label}</span>
                        {unit.name && (
                          <span className="truncate text-xs text-muted-foreground">
                            {unit.name}
                          </span>
                        )}
                      </div>
                      {unit.id === currentUnit && <Check className="size-4" />}
                    </DropdownMenuItem>
                  ))}

                  <DropdownMenuSeparator />
                  {/* Team leads genuinely need to see across units. Without this
                      they would be switching seven times to answer one question. */}
                  <DropdownMenuItem onClick={() => selectUnit(ALL_UNITS)} className="gap-2">
                    <span className="flex-1">All units</span>
                    {currentUnit === ALL_UNITS && <Check className="size-4" />}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {unitGroups.map((group) => (
            <NavSection
              key={group.id}
              group={group}
              activeItemId={activeItemId}
              renderLink={renderLink}
            />
          ))}

          {/* Team-wide sits below the unit nav and never changes with the
              switcher, so "does this belong to my unit or the team?" is answered
              by where it is rather than by asking someone. */}
          {team.teamWide.map((group) => (
            <NavSection
              key={group.id}
              group={group}
              activeItemId={activeItemId}
              renderLink={renderLink}
            />
          ))}
        </SidebarContent>

        {user && (
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <AccountMenu user={user} groups={userMenu} />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        {/*
         * WHAT THE TOP BAR IS FOR.
         *
         * It held the team's full name, which is the least volatile fact on the
         * screen — it cannot change without the whole app changing. That strip
         * is also the only chrome that survives the rail collapsing, so spending
         * it on something constant wastes the one place that keeps working when
         * the nav is gone.
         *
         * Breadcrumbs were the obvious candidate and are rejected. PageHeader
         * already renders them per screen, so putting them here means either two
         * `nav` landmarks 40px apart, or removing a documented prop from
         * @koc/page-header — a published registry item whose consumers keep the
         * source they pulled and would get a prop that silently does nothing.
         *
         * What earns the space is what CHANGES and is not visible elsewhere:
         *
         *   scope     which unit's numbers you are reading. Derived from the
         *             same state the switcher sets, so it cannot disagree with
         *             it. Text, never a button — a second control that sets the
         *             unit erodes the switcher's authority.
         *   asOf      when the figures were last refreshed. Opt-in, because a
         *             stale-time nobody wired up is worse than none.
         *
         * The middle stays deliberately empty: it is where a command palette
         * goes, and reserving it now avoids a second redesign. Not built —
         * searching five screens is theatre; the useful version searches records
         * and needs a data source only the consumer has.
         */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />

          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{unitLabel}</span>
            {asOf && (
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                · {typeof asOf === "string" ? asOf : `as of ${asOf.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`}
              </span>
            )}
          </div>

          {/* Reserved: command palette. */}
          <div className="flex-1" />

          {/* Notifications stay here. They are about operational events rather
              than about you, they must be reachable from any screen, and the
              account menu that used to sit beside them now lives in the sidebar
              footer where it is next to who you are. */}
          {notifications && (
            <NotificationMenu
              items={notifications}
              onSelect={onNotificationSelect}
              onMarkAllRead={onMarkAllRead}
            />
          )}
        </header>
        <div className="flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The account menu, in the sidebar footer.
 *
 * It was a UserMenu in the top-right, and the comment justifying that said the
 * rail collapses to 32px so the menu had to stay in the header. That premise was
 * simply wrong: SIDEBAR_WIDTH_ICON is 3rem — 48px — and SidebarFooter carries no
 * collapse rule, so it stays visible. An `lg` SidebarMenuButton collapses to
 * exactly 32px inside that 48px rail through the sidebar's own size overrides,
 * with no extra CSS. The constraint that moved it away never existed.
 *
 * It also replaces a real defect. The footer previously rendered a
 * SidebarMenuButton — a genuine <button> — with no handler: focusable, in the
 * tab order, doing nothing. Anyone who tabbed to it got silence.
 *
 * TWO TRAPS, both of which fail silently:
 *
 *   1. NO `tooltip` PROP. With one, SidebarMenuButton returns a Tooltip root
 *      rather than a bare button. Under Radix's slot that silently broke the
 *      menu (props cloned onto a non-DOM component); Base's render prop
 *      forwards props through to the real button, but the account menu still
 *      omits the tooltip: the footer never collapses to icons, so a tooltip
 *      here would be noise announced to every screen reader for no benefit.
 *   2. NOT the UserMenu component. It renders a Button, which has neither
 *      overflow-hidden nor any of the sidebar's icon-rail size overrides, so it
 *      overflows the collapsed rail. The markup here is the sidebar's own.
 *
 * `side="right"` on the content is what makes it usable from the collapsed rail:
 * a menu opening upward from a 48px column would be clipped by the viewport edge.
 */
function AccountMenu({
  user,
  groups,
}: {
  user: AppShellUser;
  groups?: UserMenuItem[][];
}) {
  const { isMobile } = useSidebar();

  const identity = (
    <>
      <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
        {initials(user.name)}
      </div>
      <div className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-medium">{user.name}</span>
        {user.role && (
          <span className="truncate text-xs text-muted-foreground">{user.role}</span>
        )}
      </div>
    </>
  );

  // No menu supplied — render the identity, but NOT as a button. A control that
  // does nothing is worse than no control, and that is what shipped before.
  if (!groups?.length) {
    return (
      <div
        data-slot="sidebar-menu-button"
        className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!"
      >
        {identity}
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            aria-label={`Account menu for ${user.name}`}
            className="data-popup-open:bg-sidebar-accent"
          />
        }
      >
        {identity}
        <ChevronsUpDown className="ml-auto size-4 shrink-0" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-[var(--anchor-width)] min-w-56"
        side={isMobile ? "bottom" : "right"}
        align="end"
        sideOffset={4}
      >
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-muted text-xs font-medium">
            {initials(user.name)}
          </div>
          <div className="grid min-w-0 flex-1 leading-tight">
            <span className="truncate text-sm font-medium">{user.name}</span>
            {user.role && (
              <span className="truncate text-xs text-muted-foreground">{user.role}</span>
            )}
          </div>
        </DropdownMenuLabel>

        {groups.map((group, gi) => (
          <React.Fragment key={gi}>
            <DropdownMenuSeparator />
            {group.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onClick={() => item.onSelect?.()}
                className={cn("gap-2", item.destructive && "text-destructive")}
              >
                {item.icon && <item.icon className="size-4" />}
                {item.label}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavSection({
  group,
  activeItemId,
  renderLink,
}: {
  group: NavGroup;
  activeItemId?: string;
  renderLink: NonNullable<AppShellProps["renderLink"]>;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
      <SidebarMenu>
        {group.items.map((item) =>
          item.children?.length ? (
            <CollapsibleNavItem
              key={item.id}
              item={item}
              activeItemId={activeItemId}
              renderLink={renderLink}
            />
          ) : (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                isActive={item.id === activeItemId}
                tooltip={item.label}
                render={renderLink(
                  item,
                  <>
                    {item.icon && <item.icon />}
                    <span>{item.label}</span>
                  </>,
                )}
              />
              {/*
               * The badge is a SIBLING of the button, not a child of it, and it
               * has to be SidebarMenuBadge rather than a span.
               *
               * A hand-rolled `<span className="ml-auto">` inside the button
               * breaks two things at once. The sidebar styles the label with
               * `[&>span:last-child]:truncate` — an inline badge becomes the last
               * span, so the badge gets truncated and the label loses its
               * truncation, wraps, and spills out of the collapsed 32px rail.
               * And a plain span has no collapse rule, so it stays visible in the
               * icon rail with nothing to attach to.
               *
               * SidebarMenuBadge is absolutely positioned and carries
               * `group-data-[collapsible=icon]:hidden`, so it disappears with the
               * label and never enters the button's flex row at all.
               */}
              {item.badge !== undefined && (
                <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function CollapsibleNavItem({
  item,
  activeItemId,
  renderLink,
}: {
  item: NavItem;
  activeItemId?: string;
  renderLink: NonNullable<AppShellProps["renderLink"]>;
}) {
  // Open the branch containing the active item, so a deep link does not land you
  // on a page whose nav entry is hidden inside a collapsed group.
  const containsActive = item.children?.some((c) => c.id === activeItemId) ?? false;

  return (
    <Collapsible
      render={<SidebarMenuItem />}
      defaultOpen={containsActive}
      className="group/collapsible"
    >
        <CollapsibleTrigger render={<SidebarMenuButton tooltip={item.label} />}>
          {item.icon && <item.icon />}
          <span>{item.label}</span>
          <ChevronRight
            className={cn(
              "ml-auto transition-transform duration-fast ease-out",
              "group-data-open/collapsible:rotate-90",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.children?.map((child) => (
              <SidebarMenuSubItem key={child.id}>
                <SidebarMenuSubButton
                  isActive={child.id === activeItemId}
                  render={renderLink(child, <span>{child.label}</span>)}
                />
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
    </Collapsible>
  );
}
