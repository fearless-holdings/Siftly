/**
 * Build an env object for spawn/execFile that ensures CLI binaries
 * (claude, codex) are discoverable even when the Next.js server
 * inherits a minimal PATH (e.g. launched from a GUI or launchd).
 */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/Applications/cmux.app/Contents/Resources/bin',
]

let _env: NodeJS.ProcessEnv | undefined

export function cliSpawnEnv(): NodeJS.ProcessEnv {
  if (_env) return _env

  const current = process.env.PATH ?? ''
  const dirs = current.split(':')
  const missing = EXTRA_PATH_DIRS.filter((d) => !dirs.includes(d))

  if (missing.length === 0) {
    _env = process.env
  } else {
    _env = { ...process.env, PATH: [...missing, current].join(':') }
  }
  return _env
}
