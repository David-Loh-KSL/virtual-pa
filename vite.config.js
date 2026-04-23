import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['xlsx', 'mammoth']
  },
  build: {
    commonjsOptions: {
      include: [/xlsx/, /mammoth/, /node_modules/]
    }
  },
  server: {
    proxy: {
      '/api/notion': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/api/claude': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
