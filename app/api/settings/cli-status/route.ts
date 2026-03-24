import { NextResponse } from 'next/server'
import { getCliAuthStatus, getCliAvailability } from '@/lib/claude-cli-auth'
import { getCodexCliAuthStatus, getCodexCliAvailability } from '@/lib/openai-auth'
import { getSavedProvider, getProvider } from '@/lib/settings'

export async function GET(): Promise<NextResponse> {
  const oauthStatus = getCliAuthStatus()
  const codexStatus = getCodexCliAuthStatus()

  // Get both saved and effective providers
  const [savedProvider, effectiveProvider] = await Promise.all([
    getSavedProvider(),
    getProvider(),
  ])

  // Only check CLI subprocess availability if OAuth credentials exist
  const cliDirectAvailable = oauthStatus.available && !oauthStatus.expired
    ? await getCliAvailability()
    : false

  // Check Codex CLI availability
  const codexCliAvailable = codexStatus.available && !codexStatus.expired
    ? await getCodexCliAvailability()
    : false

  return NextResponse.json({
    provider: effectiveProvider,
    savedProvider: savedProvider ?? null,
    providerMode: savedProvider ? 'manual' : 'auto',
    claude: {
      available: oauthStatus.available,
      expired: oauthStatus.expired,
      subscriptionType: oauthStatus.subscriptionType,
      cliAvailable: cliDirectAvailable,
      mode: cliDirectAvailable ? 'cli' : oauthStatus.available ? 'oauth' : 'unavailable',
    },
    codex: {
      ...codexStatus,
      cliAvailable: codexCliAvailable,
    },
  })
}
