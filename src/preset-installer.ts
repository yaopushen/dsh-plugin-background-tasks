import { cp, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Resolve DSH home following @deepseek-ai conventions:
 * $DSH_HOME (non-empty) else ~/.dsh.
 */
function resolveDshHome(env = process.env): string {
  const custom = env.DSH_HOME
  if (custom && custom.trim().length > 0) {
    return resolve(custom.startsWith('~/') ? join(homedir(), custom.slice(2)) : custom)
  }
  return join(homedir(), '.dsh')
}

/**
 * Automatically install the packaged `preset/background-shell/` directory into
 * `$DSH_HOME/.agent-presets/background-shell/` on plugin initialization.
 * Idempotent: if the target preset directory already exists, it is left untouched.
 */
export async function installPackagedPreset(ctx: Context, presetId = 'background-shell'): Promise<boolean> {
  const targetDir = join(resolveDshHome(), '.agent-presets', presetId)
  const sourceDir = fileURLToPath(new URL('../preset/background-shell', import.meta.url))
  const log = ctx.logger('background-tasks')

  try {
    const existing = await stat(targetDir)
    if (existing.isDirectory()) {
      return true
    }
  } catch {
    // Target does not exist, proceed with copying
  }

  try {
    await mkdir(targetDir, { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true })
    log.info('installed agent preset "%s" to %s', presetId, targetDir)
    return true
  } catch (err) {
    log.warn(
      'failed to install agent preset "%s" to %s (%s); copy preset/background-shell/ manually',
      presetId,
      targetDir,
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}
