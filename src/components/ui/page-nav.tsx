"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";

/**
 * PageNav — horizontal navigation *inside* an application.
 *
 * Not a replacement for AppShell's sidebar, and the distinction is the whole
 * reason this exists separately. The sidebar answers "which app am I in"; this
 * answers "which part of this app am I in". A KOC unit app with several related
 * screens — reports, wells, materials, performance — needs the second without
 * acquiring a second global navigation.
 *
 * Adapted from shadcn-space's topbar-05 desktop nav, with its sidebar coupling
 * removed: the original calls `useSidebar()` and throws outside a provider,
 * which makes it unusable anywhere except inside its own shell.
 *
 * Groups open a dropdown; plain items are direct links. One level only — a
 * second level of nesting inside a horizontal bar is a menu system, and at that
 * point the screen wants a sidebar instead.
 */

export interface PageNavItem {
  label: string;
  href: string;
  icon?: LucideIcon;
  description?: string;
}

export interface PageNavGroup {
  label: string;
  icon?: LucideIcon;
  /** A direct link when omitted; a dropdown when present. */
  items?: PageNavItem[];
  href?: string;
}

export interface PageNavProps {
  groups: PageNavGroup[];
  /** `href` of the current screen, for the active state. */
  activeHref?: string;
  /** Routing is the consumer's — same contract as AppShell. */
  renderLink?: (item: { href: string }, children: React.ReactNode) => React.ReactNode;
  className?: string;
}

const defaultRenderLink: NonNullable<PageNavProps["renderLink"]> = (item, children) => (
  <a href={item.href}>{children}</a>
);

export function PageNav({
  groups,
  activeHref,
  renderLink = defaultRenderLink,
  className,
}: PageNavProps) {
  return (
    <NavigationMenu className={cn("max-w-none justify-start", className)}>
      <NavigationMenuList className="gap-1">
        {groups.map((group) => {
          const Icon = group.icon;

          // Direct link — no dropdown to open.
          if (!group.items?.length) {
            const active = group.href === activeHref;
            return (
              <NavigationMenuItem key={group.label}>
                <NavigationMenuLink
                  asChild
                  active={active}
                  className={cn(
                    "flex-row items-center gap-2 rounded-md px-3 py-2 text-sm",
                    active && "bg-accent text-accent-foreground",
                  )}
                >
                  {renderLink({ href: group.href ?? "#" }, (
                    <>
                      {Icon && <Icon aria-hidden className="size-4" />}
                      <span>{group.label}</span>
                    </>
                  ))}
                </NavigationMenuLink>
              </NavigationMenuItem>
            );
          }

          // A group is "current" when any of its children is — otherwise the
          // active screen disappears the moment it lives one level down.
          const hasActive = group.items.some((i) => i.href === activeHref);

          return (
            <NavigationMenuItem key={group.label}>
              <NavigationMenuTrigger
                className={cn(
                  "gap-2 bg-transparent",
                  hasActive && "bg-accent text-accent-foreground",
                )}
              >
                {Icon && <Icon aria-hidden className="size-4" />}
                {group.label}
              </NavigationMenuTrigger>

              <NavigationMenuContent className="min-w-56 p-1">
                <ul className="grid gap-0.5">
                  {group.items.map((item) => {
                    const ItemIcon = item.icon;
                    const active = item.href === activeHref;
                    return (
                      <li key={item.href}>
                        <NavigationMenuLink
                          asChild
                          active={active}
                          className={cn(
                            "flex-row items-center gap-2 rounded-md px-2 py-2 text-sm",
                            active && "bg-accent text-accent-foreground",
                          )}
                        >
                          {renderLink(item, (
                            <>
                              {ItemIcon && (
                                <ItemIcon aria-hidden className="size-4 shrink-0" />
                              )}
                              <span className="grid">
                                <span>{item.label}</span>
                                {item.description && (
                                  <span className="text-xs text-muted-foreground">
                                    {item.description}
                                  </span>
                                )}
                              </span>
                            </>
                          ))}
                        </NavigationMenuLink>
                      </li>
                    );
                  })}
                </ul>
              </NavigationMenuContent>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>
    </NavigationMenu>
  );
}
