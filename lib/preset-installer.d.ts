import type { Context } from '@deepseek-ai/cordis';
/**
 * Automatically install the packaged `preset/background-shell/` directory into
 * `$DSH_HOME/.agent-presets/background-shell/` on plugin initialization.
 * Idempotent: if the target preset directory already exists, it is left untouched.
 */
export declare function installPackagedPreset(ctx: Context, presetId?: string): Promise<boolean>;
//# sourceMappingURL=preset-installer.d.ts.map