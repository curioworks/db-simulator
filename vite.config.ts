import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps asset URLs relative so the build works on GitHub Pages
// regardless of the repo name / subpath it is served from.
export default defineConfig({
  base: './',
  plugins: [react()],
});
