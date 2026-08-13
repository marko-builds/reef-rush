# Reef Rush

A 25 second HTML5 playable ad demo. Original code and art.

**Play it:** https://marko-builds.github.io/reef-rush/

Match fish to blocks, break the gold ring, take the treasure. One level, portrait, tuned for a
20 to 30 second first try.

## Why it exists

I built this as a public, openable demo of playable-ad craft: the packaging constraints ad
networks actually enforce, applied to a real small game rather than a slide.

- **MRAID boot gate.** Waits for `ready` and `isViewable()` before the game clock starts;
  falls back to instant start in a plain browser.
- **Single file.** The whole ad is one HTML file (about 3.6MB of a 5MB budget). Sprites are
  inlined as data URIs by a small build script.
- **Zero network at runtime.** No fetches, no CDN, no fonts, no audio files.
- **Sound with no sound files.** The audio is fully synthesized in WebAudio, created only on
  the first tap (playables run muted until a gesture), with a mute toggle.
- **Lint-clean.** Passes [adpreflight](https://github.com/marko-builds/adpreflight), my
  open-source playable-ad linter, on the Unity Ads and Google rule packs.

## Mechanics

Fish ride a conveyor around a 9x9 board and shoot the blocks that match their color. The level
adds a mine (clears its neighborhood with a screen shake), seaweed-wrapped blocks (first hit
tears the wrap), and one golden fish that pierces through any color.

## Run it locally

```
npm install
npm run dev
```

Build the hosted bundle and the single-file ad:

```
npm run build
node scripts/build-single.mjs
```

`dist-single/index.html` is the complete ad. The `verify-*.mjs` scripts are headless checks;
`verify-winnability.mjs` proves the level is winnable across seeded runs.

## Stack

Three.js, Vite, and plain JavaScript. All art is my own (AI-generated sprites from my prompts
plus hand-authored SVG), and all audio is synthesized in code.
