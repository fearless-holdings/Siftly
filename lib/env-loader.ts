import { loadEnvConfig } from '@next/env'

let envLoaded = false

/**
 * Ensure server-side modules can read env with Next.js precedence:
 * `.env.local` over `.env`, while preserving already-exported vars.
 */
export function ensureServerEnvLoaded(): void {
  if (envLoaded) return
  loadEnvConfig(process.cwd())
  envLoaded = true
}
