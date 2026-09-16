import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { validateRequiredEnv } from './vite.env'

export default defineConfig(({ command, mode }) => {
  // Production-build-only fail-fast: `vite build` must not silently ship without these,
  // the way it did before. `vite`/`vite dev` (command === 'serve') is untouched — local
  // dev keeps working with either var absent, same as always.
  if (command === 'build') {
    validateRequiredEnv(loadEnv(mode, process.cwd(), 'VITE_'))
  }

  return {
    plugins: [react(), tailwindcss()],
  }
})
