import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    // elkjs ships as one prebuilt ~1.4 MB bundle that cannot be split further;
    // every other chunk stays under the default 500 kB.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Keep the large graph / chart libraries out of the app bundle so the
        // app code stays small and the vendor files cache across releases.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/elkjs/')) return 'elk';
          if (id.includes('/cytoscape')) return 'cytoscape';
          if (id.includes('/recharts/') || id.includes('/d3-') || id.includes('/victory-vendor/')) return 'charts';
          if (/\/(react|react-dom|scheduler)\//.test(id)) return 'react';
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 9173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
});
