/**
 * Host glue for the e2e mount lane (minimal): DSH 0.1.1-rc.x prints a bare
 * origin URL, so no token exchange is needed — just the page URL from
 * `DSH_E2E_URL` (set by scripts/e2e-mount.sh).
 */
const envUrl = process.env.DSH_E2E_URL
if (!envUrl) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted (see scripts/e2e-mount.sh)')
}

export const PAGE_URL: string = envUrl
