import * as React from "react";

import { cn } from "@/lib/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * PageHeader — the top of every KOC application screen.
 *
 * Not in the shadcn registry and not in any block worth copying: every dashboard
 * kit improvises one, which is exactly why forty KOC apps would improvise forty
 * slightly different ones. This fixes the arrangement so a user moving between
 * two KOC apps finds the title, the context and the actions in the same places.
 *
 * WHY THE TITLE IS AN <h1>
 * ------------------------
 * The app shell contributes no heading — a sidebar is navigation, not document
 * structure. If the page does not supply an h1 the screen has no top-level
 * heading at all, and screen-reader users lose the single most-used way to
 * orient on a page. Making it structural here means a team cannot ship a screen
 * without one by forgetting.
 *
 * WHY BREADCRUMBS ARE OPTIONAL AND SHALLOW
 * ----------------------------------------
 * KOC nests four levels deep, and the temptation is to render the whole chain.
 * But Directorate and Group are identity rather than navigation — a user does
 * not travel up to them from a screen — and the unit is already in the sidebar
 * switcher. So a breadcrumb here should carry only the path *within* the app:
 * the list you came from, and where you are now. Anything more repeats the
 * chrome and buries the one link that matters.
 */

export interface PageHeaderCrumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  title: string;
  /** One line explaining what this screen is for. Optional but usually earned. */
  description?: string;
  /** Path within the app. The last entry renders as the current page. */
  breadcrumbs?: PageHeaderCrumb[];
  /**
   * Primary and secondary actions. Kept to the right of the title so the
   * scan order is "where am I → what is this → what can I do".
   */
  actions?: React.ReactNode;
  /** Counters, freshness stamps, status. Rendered under the title. */
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("border-b border-border pb-4", className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb className="mb-2">
          <BreadcrumbList>
            {breadcrumbs.map((crumb, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <React.Fragment key={`${crumb.label}-${i}`}>
                  <BreadcrumbItem>
                    {last || !crumb.href ? (
                      <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink href={crumb.href}>{crumb.label}</BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {!last && <BreadcrumbSeparator />}
                </React.Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
          )}
          {meta && <div className="mt-2 flex flex-wrap items-center gap-3">{meta}</div>}
        </div>

        {/* `shrink-0` so a long title truncates rather than squeezing the actions
            into an unusable column — the primary action must stay clickable at
            any width. */}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
