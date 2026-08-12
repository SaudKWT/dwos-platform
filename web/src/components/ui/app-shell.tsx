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
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { NotificationMenu, type NotificationItem } from "@/components/ui/notification-menu";
import { UserMenu, type UserMenuItem } from "@/components/ui/user-menu";
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
  renderLink?: (item: NavItem, children: React.ReactNode) => React.ReactNode;
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
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    /* The switcher is the one place the brand appears at full
                       strength in the chrome — it is also the control that tells
                       you what you are looking at, so it earns the emphasis. */
                    className="data-[state=open]:bg-sidebar-accent"
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
                  </SidebarMenuButton>
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
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
                      onSelect={() => selectUnit(unit.id)}
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
                  <DropdownMenuItem onSelect={() => selectUnit(ALL_UNITS)} className="gap-2">
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
                <SidebarMenuButton size="lg">
                  <div className="flex aspect-square size-8 items-center justify-center rounded-md bg-muted text-xs font-medium">
                    {initials(user.name)}
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{user.name}</span>
                    {user.role && (
                      <span className="truncate text-xs text-muted-foreground">
                        {user.role}
                      </span>
                    )}
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ml-1" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{team.name}</div>
          </div>

          {/* Notifications and the account menu live in the header, not the
              sidebar footer: they are about *you* rather than about where you
              are, and they need to stay reachable when the rail is collapsed to
              32px. Both are omitted entirely when not supplied — a bell that
              never rings is noise. */}
          {notifications && (
            <NotificationMenu
              items={notifications}
              onSelect={onNotificationSelect}
              onMarkAllRead={onMarkAllRead}
            />
          )}
          {user && userMenu && (
            <UserMenu
              variant="compact"
              user={{ name: user.name, role: user.role }}
              groups={userMenu}
            />
          )}
        </header>
        <div className="flex-1 overflow-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
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
                asChild
                isActive={item.id === activeItemId}
                tooltip={item.label}
              >
                {renderLink(
                  item,
                  <>
                    {item.icon && <item.icon />}
                    <span>{item.label}</span>
                  </>,
                )}
              </SidebarMenuButton>
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
    <Collapsible asChild defaultOpen={containsActive} className="group/collapsible">
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton tooltip={item.label}>
            {item.icon && <item.icon />}
            <span>{item.label}</span>
            <ChevronRight
              className={cn(
                "ml-auto transition-transform duration-fast ease-out",
                "group-data-[state=open]/collapsible:rotate-90",
              )}
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {item.children?.map((child) => (
              <SidebarMenuSubItem key={child.id}>
                <SidebarMenuSubButton asChild isActive={child.id === activeItemId}>
                  {renderLink(child, <span>{child.label}</span>)}
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}
