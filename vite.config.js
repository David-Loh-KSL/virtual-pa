import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['xlsx', 'mammoth']
  },
  build: {
    rollupOptions: {
      external: [],
    },
    commonjsOptions: {
      include: [/xlsx/, /mammoth/, /node_modules/]
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
