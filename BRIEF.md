# Reef Rush — playable-ad conversion brief

**Deadline context:** needed as an openable hosted link before Friday 2026-08-14 10:30 CEST
(job interview). Deliverable priority: (1) a working hosted build, (2) single-file + adpreflight
pass as stretch. Do NOT sacrifice (1) chasing (2).

**What this dir is:** a copy of `projects/pixelflow-claude-code-env/reef/styled_fof_version/`
(Three.js + Vite conveyor color-shooter, 5-level web game). It becomes **Reef Rush**, a ~25-second
single-level playable ad. The source dirs under `pixelflow-claude-code-env/` and
`fof-claude-code-env/` are READ-ONLY reference — never edit them.

**IP status (resolved 2026-08-12):** all code and art are Marko's own (sprites AI-generated from
his own prompts, see `fof-claude-code-env/.../prompts/IMAGE-GEN-LIBRARY.md`; SVGs hand-authored).
The names "Fish of Fortune", "FoF", "Pixel Flow" are OTHER games' brands and must not appear in
anything shipped. No NDA on the source work.

## Phase 1 — de-brand (shipped surfaces)

- `index.html`: `<title>` → `Reef Rush`, the `<h1>Fish of Fortune</h1>` title screen → `Reef Rush`.
- Storage keys: `fof-spin-carry`, `fof-title-shown`, `fof-run-coins` → `rr-*` equivalents.
- Grep the SHIPPED artifact (built output) for `fof`, `fortune`, `pixel flow`, `FoF` — must be
  zero hits (case-insensitive). Code comments in src/ should also be cleaned since the repo may
  go public: reword comments that name FoF/Pixel Flow to neutral language ("the reference
  anticipation pattern" etc.). Don't rewrite comment content beyond the brand names.

## Phase 2 — the mini level + ad flow

- Replace the 5-level sequence with ONE authored level in `src/level.js` (the format is data-driven
  9x9 pattern strings; `.` = empty, `A`=C1 coral, `D`=C4 gold, `M`=mine):

  ```
  .........
  .........
  ...DDD...
  ...D.D...
  ...DMD...
  .A.....A.
  .........
  .........
  .........
  ```

  Center `.` pocket holds the TREASURE (level 5's existing mechanic). Gold ring guards it, one
  MINE in the ring for the blast moment, two coral accents teach color matching. **Tune freely**
  (pattern, pig ammo, conveyor speed, queue weighting) to hit a 20-30 second first-try win; the
  gameplay LOGIC stays untouched. Colors: this level uses C1 + C4 only.
- Win → treasure reveal + coin burst (existing) → **end card**: "Reef Rush" title, one line
  ("A 25 second reef puzzle. Original code and art."), a CTA button. CTA calls `mraid.open(URL)`
  when mraid exists, else `window.open`. URL: `https://markostankovic.org` (honest demo framing,
  no fake store listing). Lose (lockup) → "So close" + replay button + same CTA.
- First-load hint: a pulsing pointer/hand over the tappable queue row + one line ("Tap a fish
  that matches an open block"), dismissed on first tap. Use existing UI panel language.
- Kill the 6-segment fortune wheel spin bonus entirely (it is the FoF-specific mechanic and eats
  size) — `src/spin.js`, `src/carryover.js` and their call sites. Keep coins.
- **No em/en dashes or arrows in any user-visible string** (end card, hints). Plain sentences.

## Phase 3 — MRAID boot contract

- Boot gate: if `typeof mraid === 'undefined'` → start immediately (GitHub Pages / browser case).
  If mraid exists and `getState() === 'loading'` → wait for `ready` event, then check
  `isViewable()` / `viewableChange` before starting the game clock. This is the exact check
  adpreflight enforces — it must be real, not cosmetic.
- No network calls at runtime in the packaged build: no runtime `fetch()` of manifest/sprites
  (Phase 4 inlines them). No external fonts, no CDN.

## Phase 4 — asset diet + packaging

- Needed sprites only (~14): cube_c1, cube_c4, cube_m, pig_c1, pig_c4, treasure, coin, shot,
  particle, belt_segment, belt-angled-segment, slot, corals, kelp, bubble + the 3 bg fish if
  size allows. Downscale PNGs to 256px max dimension (code rasters at `RASTER_PX = 256` anyway;
  corals.png can go to ~1024 wide since it's a band). Drop ALL audio (playables run muted);
  strip the audio bus to a no-op.
- Multi-file `vite build` first → that's the hosted deliverable. THEN single-file: inline the JS
  bundle and convert the asset loader to read from an inlined base64 data-URI map instead of
  runtime fetch (this is a rewrite of `src/assets.js` — budget it as the hard task). Target:
  under 5MB extracted, one HTML file, zero network.

## Phase 5 — verification (all must show output, not claims)

1. `npx vite build` exits 0; `dist/` served locally renders and is winnable by a human.
2. Adapt `verify-winnability.mjs` to the single level and run it green (if adaptation costs more
   than an hour, hand-playtest and say so plainly).
3. Run adpreflight against the single-file build: `cd ../adpreflight && <its documented command>`
   — read its README for invocation and rule packs (Unity Ads + Google). Report the verdict
   verbatim, including size numbers. If it fails, fix and re-run; if a rule can't be met, report
   which and why rather than gaming it.
4. Case-insensitive grep of dist output for `fof|fortune|pixel` → zero hits.
5. `git init` + initial commit in this dir when phases 1-2 build green (this is a new independent
   repo; do not commit from the monolith root).

## Do NOT

- Publish anything (no gh repo create, no Pages) — Marko gates that.
- Touch the source assignment dirs.
- Add frameworks, TypeScript, or restructure beyond what the phases need.
- Mark any phase done without the Phase 5 evidence for it.
