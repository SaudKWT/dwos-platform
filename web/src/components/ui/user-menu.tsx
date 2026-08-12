"use client";

import * as React from "react";
import { ChevronsUpDown, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * UserMenu — who you are signed in as, and what you can do about it.
 *
 * Extracted from shadcn-space's topbar-05 profile dropdown. The original
 * hardcodes its items (Profile, Billing, Team, Subscription…), which is a SaaS
 * menu and not a KOC one; a design system serving forty internal apps has to let
 * each supply its own, and none of them have billing.
 *
 * Groups are rendered with separators between them, so "account" and "sign out"
 * are visually distinct without every caller re-deciding the arrangement. The
 * sign-out item is deliberately its own group — a destructive-ish action sitting
 * one pixel below "Settings" is how people sign out by accident.
 */

export interface UserMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  href?: string;
  /** Renders in the destructive colour. Use for sign out. */
  destructive?: boolean;
}

export interface UserMenuUser {
  name: string;
  /** Role or unit — what distinguishes two people with the same name. */
  role?: string;
  email?: string;
  avatarUrl?: string;
}

export interface UserMenuProps {
  user: UserMenuUser;
  /** Each array renders as a group, separated. */
  groups: UserMenuItem[][];
  /** `full` shows name and role beside the avatar; `compact` is avatar only. */
  variant?: "full" | "compact";
  align?: "start" | "end";
  className?: string;
}

/** Two letters is the most that stays legible in a 32px circle. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function UserMenu({
  user,
  groups,
  variant = "full",
  align = "end",
  className,
}: UserMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            variant === "compact" ? "size-9 rounded-full p-0" : "h-auto gap-2 px-2 py-1.5",
            className,
          )}
          // The avatar is decorative; the name is the accessible name. Without
          // this a compact menu announces as an unlabelled button.
          aria-label={`Account menu for ${user.name}`}
        >
          <Avatar className="size-8">
            {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback className="text-xs">{initials(user.name)}</AvatarFallback>
          </Avatar>

          {variant === "full" && (
            <>
              <span className="grid min-w-0 flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{user.name}</span>
                {user.role && (
                  <span className="truncate text-xs text-muted-foreground">{user.role}</span>
                )}
              </span>
              <ChevronsUpDown aria-hidden className="size-4 shrink-0 opacity-50" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="grid gap-0.5">
            <span className="text-sm font-medium">{user.name}</span>
            {user.email && (
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            )}
            {user.role && !user.email && (
              <span className="truncate text-xs text-muted-foreground">{user.role}</span>
            )}
          </div>
        </DropdownMenuLabel>

        {groups.map((group, gi) => (
          <React.Fragment key={gi}>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {group.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem
                    key={item.id}
                    onSelect={item.onSelect}
                    variant={item.destructive ? "destructive" : "default"}
                    className="gap-2"
                  >
                    {Icon && <Icon aria-hidden className="size-4" />}
                    {item.label}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
