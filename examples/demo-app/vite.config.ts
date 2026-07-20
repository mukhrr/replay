import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { mockApi } from './mock-api.js';

export default defineConfig({
  plugins: [react(), mockApi()],
  server: {
    port: Number(process.env.PORT ?? 5173),
    // Integration tests address a fixed port; silently sliding to 5174 would
    // make them fail in a confusing way.
    strictPort: true,
  },
});
