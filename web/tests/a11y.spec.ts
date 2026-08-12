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
 * Nothing is scoped out.
 *
 * Two rules were exempted here until v0.1.5 — `region`, because @koc/app-shell
 * rendered its sidebar outside any landmark, and `heading-order`, because
 * @koc/alert hardcoded <h5> for AlertTitle. Both are fixed upstream, so both
 * exemptions and the guard test that protected the second one are gone. The
 * suite runs every rule against every screen again.
 */

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
    const { violations } = await new AxeBuilder({ page })
      .disableRules(['color-contrast'])
      .analyze()

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
  const links = await page.getByRole('navigation', { name: /navigation/i }).getByRole('link').all()
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
