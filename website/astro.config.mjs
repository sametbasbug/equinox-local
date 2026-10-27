import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://local.sametbasbug.dev',
  output: 'static',
  publicDir: './site',
  trailingSlash: 'always',
  build: { inlineStylesheets: 'never' },
  vite: { plugins: [tailwindcss()] },
  devToolbar: { enabled: false },
});
