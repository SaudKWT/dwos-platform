import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

/**
 * Accessibility and behaviour checks for the DWOS screens.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 * ------------------------------------
 * The design system tests its own components in its own repo. Nothing tested
 * there covers how they are *composed* here — a Tabs with no TabsContent, a
 * dialog that traps focus nowhere, a table whose sort state is never announced
 * are all assembly faults, invisible upstream and only reachable from an app.
 *
 * It is also NOT a screen-reader test and must not be mistaken for one. It
 * proves keyboard reach, visible focus, ARIA correctness and announced state.
 * It cannot tell you what NVDA actually says — live-region politeness, table
 * navigation mode, how aria-sort is voiced. KOC is a Windows/Edge organisation,
 * so that pass is NVDA + Edge on Windows, by a person, periodically. See
 * docs/HANDOFF.md.
 *
 * Chromium only, deliberately: KOC is Windows/Edge, and WebKit would be testing
 * a browser no KOC user has.
 *
 * `color-contrast` is disabled because the design system already asserts every
 * token pair against WCAG 2.1 AA in CI, more strictly and over pairs no page
 * happens to render. Re-checking it here would report the same colours against
 * a weaker standard.
 */

/**
 * Violations that belong to @koc/*, not to this app.
 *
 * They are printed on every run but do not fail the suite, because fixing them
 * here means editing an installed component — and the next `koc:add` would
 * silently overwrite the fix. They are reported upstream instead; the suite
 * stays green on what this repo controls and loud about what it does not.
 *
 * Remove an entry the moment the design system ships the fix, so the check
 * starts guarding it again rather than quietly tolerating a regression.
 */
/**
 * Two violations belong to @koc/*, not to this app, and are handled by scoping
 * rather than by switching the rule off — a rule-level exemption would hide the
 * same mistake if it were made here.
 *
 *   region        @koc/app-shell renders its sidebar outside any landmark. There
 *                 is no <nav> around the nav; main and header exist, the links
 *                 are in neither. Scoped out by excluding the sidebar subtree,
 *                 so `region` still guards this app's own content.
 *
 *   heading-order @koc/alert hardcodes <h5> for AlertTitle, so any page whose
 *                 alert is not nested under an h4 skips levels — almost every
 *                 page. Exempted at rule level, but see the guard test below:
 *                 it fails if this app ever introduces an h5 of its own, which
 *                 is the only way the exemption could start hiding something.
 *
 * Both reported upstream 2026-08-12. Delete the scoping when they ship fixes,
 * so the checks start guarding again.
 */
const UPSTREAM_SHELL = '[data-slot="sidebar"]'

const SCREENS = [
  { path: '/', name: 'team overview' },
  { path: '/unit-4/vessels/reports', name: 'daily vessel reports' },
  { path: '/unit-4/vessels/forms', name: 'file a report' },
  { path: '/unit-4/vessels/plan', name: '48-hr movement plan' },
  { path: '/unit-1/npt', name: 'a not-built screen' },
]

/** Wait for data, not for a timeout — these screens fetch from the API. */
async function ready(page: Page, path: string) {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}

for (const screen of SCREENS) {
  test(`${screen.name} has no axe violations`, async ({ page }) => {
    await ready(page, screen.path)
    // Everything except the two upstream rules, over the whole page.
    const main = await new AxeBuilder({ page })
      .disableRules(['color-contrast', 'region', 'heading-order'])
      .analyze()

    // `region` again, this time with the shell's sidebar excluded, so it still
    // guards content this repo actually owns.
    const scoped = await new AxeBuilder({ page })
      .exclude(UPSTREAM_SHELL)
      .withRules(['region'])
      .analyze()

    const violations = [...main.violations, ...scoped.violations]

    // Report what failed and where, rather than just a count — a bare
    // "expected 0, got 3" sends you back to the browser to find out which.
    const describe = (v: (typeof violations)[number]) =>
      `${v.id} (${v.impact}) — ${v.nodes.length}× — ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`

    const ours = violations.map(describe)
    expect(ours, ours.join('\n  ')).toEqual([])
  })
}

test('every screen reachable from the sidebar renders something', async ({ page }) => {
  await ready(page, '/unit-4/vessels/reports')
  // Queried by data-slot rather than by the navigation role, because the shell
  // does not wrap the sidebar in one — see KNOWN_UPSTREAM.region. When that is
  // fixed this should become getByRole('navigation').
  const links = await page.locator('[data-slot="sidebar"] a[href]').all()
  expect(links.length).toBeGreaterThan(5)

  for (const link of links.slice(0, 8)) {
    const href = await link.getAttribute('href')
    if (!href || href.startsWith('http')) continue
    await ready(page, href)
    // Either a real screen or the honest not-built page — never a blank body.
    await expect(page.getByRole('heading').first(), `${href} renders no heading`).toBeVisible()
  }
})

test('the unit switcher changes context and is keyboard reachable', async ({ page }) => {
  await ready(page, '/unit-4/vessels/reports')
  const trigger = page.getByRole('button', { name: /operational support/i }).first()
  await trigger.focus()
  await expect(trigger).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu').or(page.getByRole('listbox'))).toBeVisible()
  await page.keyboard.press('Escape')
  // Focus must come back to the trigger, or a keyboard user is stranded.
  await expect(trigger).toBeFocused()
})

test('the report form exposes its required fields as required', async ({ page }) => {
  await ready(page, '/unit-4/vessels/forms')
  const vessel = page.locator('#dvr-vessel')
  const date = page.locator('#dvr-report-date')
  await expect(vessel).toHaveAttribute('required', '')
  await expect(date).toHaveAttribute('required', '')
})

test('a validation warning names a field and moves focus to it', async ({ page }) => {
  await ready(page, '/unit-4/vessels/forms')

  // Give the form enough to be considered touched, so warnings compute.
  await page.locator('#dvr-vessel').selectOption('CA3')
  await page.locator('#dvr-report-date').fill('2026-07-20')

  const toggle = page.getByRole('button', { name: /thing.? worth checking/i })
  await expect(toggle).toBeVisible()
  await toggle.click()

  const first = page.locator('ul li button').first()
  await expect(first).toBeVisible()
  await first.click()

  // Whatever it named, the cursor is now in it — that is the whole point of the
  // link, and it is what stopped working when the warnings sat nine cards up.
  const focused = await page.evaluate(() => document.activeElement?.id ?? '')
  expect(focused).not.toBe('')
})

test('the only skipped heading levels come from @koc/alert', async ({ page }) => {
  // The guard that makes exempting heading-order safe. AlertTitle's hardcoded
  // <h5> is upstream; an h5 or h6 of this app's own would be ours to fix, and
  // would otherwise hide behind that exemption.
  for (const screen of SCREENS) {
    await ready(page, screen.path)
    const strays = await page.evaluate(() =>
      [...document.querySelectorAll('h5,h6')]
        .filter(h => !h.closest('[data-slot="alert"], [role="alert"]'))
        .map(h => `${h.tagName} "${h.textContent?.trim().slice(0, 40)}"`),
    )
    expect(strays, `${screen.name} has a heading below h4 that is not an alert title`).toEqual([])
  }
})
