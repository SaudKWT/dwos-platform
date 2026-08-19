"use client";

import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CircleAlert,
  Info,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * NotificationMenu — alerts, not announcements.
 *
 * Extracted from shadcn-space's topbar-05 rather than importing the topbar,
 * which arrives welded to its own sidebar. Two things changed in the lift.
 *
 * IT TAKES DATA.
 * The original hardcodes its list and a literal "5 New" badge, so the count and
 * the contents can disagree — which is the one thing a notification badge must
 * never do, because an unread count nobody can clear trains people to ignore it.
 * The count here is derived from the items, so it cannot drift.
 *
 * IT CARRIES SEVERITY.
 * On a KOC dashboard a notification is usually an operational alert — an NPT
 * threshold crossed, a report overdue, a well status changed. "Critical" and
 * "for information" cannot look the same, and severity is not conveyed by
 * colour alone: each level has its own icon, so it survives greyscale and
 * deuteranopia. Same rule `StatusBadge` follows.
 */

export type NotificationSeverity = "critical" | "warning" | "info";

const SEVERITY: Record<NotificationSeverity, { icon: LucideIcon; cls: string; label: string }> = {
  critical: { icon: CircleAlert, cls: "text-destructive", label: "Critical" },
  warning: { icon: AlertTriangle, cls: "text-warning", label: "Warning" },
  info: { icon: Info, cls: "text-info", label: "Information" },
};

export interface NotificationItem {
  id: string;
  title: string;
  description?: string;
  severity?: NotificationSeverity;
  /** Pre-formatted and relative, e.g. "12 min ago". Formatting is the app's job. */
  timestamp?: string;
  read?: boolean;
  href?: string;
}

export interface NotificationMenuProps {
  items: NotificationItem[];
  onSelect?: (item: NotificationItem) => void;
  onMarkAllRead?: () => void;
  /** Shown when there is nothing. An empty bell with no words looks broken. */
  emptyMessage?: string;
  align?: "start" | "end";
  className?: string;
}

export function NotificationMenu({
  items,
  onSelect,
  onMarkAllRead,
  emptyMessage = "No notifications",
  align = "end",
  className,
}: NotificationMenuProps) {
  // Derived, never passed in — see above.
  const unread = items.filter((i) => !i.read).length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn("relative", className)}
            // The count belongs in the accessible name. A screen-reader user
            // hearing only "Notifications" has no idea whether to open it.
            aria-label={
              unread > 0 ? `Notifications, ${unread} unread` : "Notifications, none unread"
            }
          />
        }
      >
          <Bell aria-hidden className="size-4" />
          {unread > 0 && (
            <Badge
              variant="destructive"
              shape="count"
              aria-hidden
              className="absolute -right-1 -top-1 h-4 min-w-4 px-1 text-[10px]"
            >
              {unread > 99 ? "99+" : unread}
            </Badge>
          )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align={align} className="w-88 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-sm font-medium">Notifications</span>
          {unread > 0 && onMarkAllRead && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onMarkAllRead}>
              <CheckCheck aria-hidden className="mr-1.5 size-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {items.map((item) => {
              const spec = SEVERITY[item.severity ?? "info"];
              const Icon = spec.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(item)}
                    className={cn(
                      "flex w-full gap-3 px-3 py-2.5 text-left transition-colors duration-fast ease-out",
                      "hover:bg-accent hover:text-accent-foreground",
                      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      !item.read && "bg-accent/40",
                    )}
                  >
                    <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", spec.cls)} />
                    <span className="grid flex-1 gap-0.5">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-medium">{item.title}</span>
                        {/* The severity word, not just the icon colour. */}
                        <span className="sr-only">{spec.label}</span>
                        {!item.read && (
                          <span
                            aria-label="Unread"
                            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                          />
                        )}
                      </span>
                      {item.description && (
                        <span className="text-xs text-muted-foreground">{item.description}</span>
                      )}
                      {item.timestamp && (
                        <span className="text-2xs text-muted-foreground">{item.timestamp}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
