// vite.env.ts
// Fail-fast validation for the environment variables a NeuroActive production build
// requires. Invoked from vite.config.ts only when `command === 'build'` (never for
// `vite`/`vite dev`), against exactly the same env Vite itself loads via loadEnv — so
// this checks precisely what will end up inlined into import.meta.env, not a guess at it.
export const REQUIRED_PRODUCTION_ENV_VARS = [
  'VITE_FIREBASE_APPCHECK_SITE_KEY',
  'VITE_FIREBASE_VAPID_KEY',
] as const;

// Never logs or throws a value — only the names of whichever of the above are absent or
// blank (undefined, or empty after trimming whitespace).
export function validateRequiredEnv(env: Record<string, string | undefined>): void {
  const missing = REQUIRED_PRODUCTION_ENV_VARS.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Production build is missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in .env.local (gitignored) or the deploying environment before running a production build.'
    );
  }
}
