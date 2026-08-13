// vite.config.js — Reef Rush build config.
//
// modulePreload polyfill OFF: the game is ONE static-import bundle (no dynamic
// imports, nothing to preload), and the polyfill is the only piece of Vite
// runtime that contains a fetch() call — the packaged playable must contain no
// fetch token at all (the zero-network gate greps for it).
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    modulePreload: { polyfill: false },
  },
});
