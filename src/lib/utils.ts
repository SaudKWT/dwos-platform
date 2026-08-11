import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, resolving Tailwind conflicts last-wins.
 *
 * `clsx` handles conditionals; `twMerge` resolves the case where a caller passes
 * `className="bg-red-500"` to a component whose base is `bg-primary` — without
 * it both classes land in the DOM and the winner is decided by stylesheet order,
 * which is effectively random.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
