import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      watch: {
        usePolling: env.LABMONITOR_USE_POLLING === 'true',
      },
      proxy: {
        '/api': env.LABMONITOR_API_TARGET || 'http://127.0.0.1:8000',
      },
    },
  }
})
