/**
 * Headless-render mount lane: prove the npm-packed plugin mounts into a real
 * `dsh web` instance and its client bundle registers without crashing the
 * shell, and that the settings section renders as its own standalone tab in
 * the Settings panel (not nested inside the Plugins page).
 */
import { test, expect, type Page } from '@playwright/test'
import { PAGE_URL } from './host'

/** Dismiss the DSH first-run dialogs (Internal Testing Notice, Add API key, …). */
async function dismissDialogs(page: Page): Promise<void> {
  const dismissNames = ['Continue', 'Configure later', 'Skip', 'Later', 'Close', 'Got it']
  for (let i = 0; i < 6; i++) {
    const dialog = page.getByRole('dialog')
    if (await dialog.count() === 0) break
    let clicked = false
    for (const name of dismissNames) {
      const btn = dialog.getByRole('button', { name, exact: true })
      if (await btn.count() > 0 && await btn.first().isEnabled()) {
        await btn.first().click()
        clicked = true
        break
      }
    }
    if (!clicked) break
    await page.waitForTimeout(500)
  }
}

test('client bundle mounts without crashing the shell', async ({ page }) => {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(10_000)

  expect(pageErrors).toEqual([])
  await expect(page.locator('body')).not.toBeEmpty()

  const ours = consoleErrors.filter((line) => line.includes('auto-continue'))
  expect(ours).toEqual([])
})

test('settings section renders as a standalone tab', async ({ page }) => {
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(10_000)
  await dismissDialogs(page)

  // Open the settings panel (sidebar-foot trigger "Settings").
  await page.getByRole('button', { name: /Settings|设置/i }).first().click()

  // Navigate to the auto-continue section: its own nav entry, not a card
  // nested inside Plugins → Plugin configuration.
  await page.getByRole('button', { name: /Auto-continue|自动续跑/ }).click()

  // The auto-continue section renders with its own marker.
  await expect(page.locator('[data-dsh-auto-continue]')).toBeVisible({ timeout: 15_000 })
})
