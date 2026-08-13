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

---

# Round 2 — sound + depth + juice (decided with Marko 2026-08-13)

Round 1 shipped and verified (6 commits, adpreflight pass, 3.44MB single-file). Marko playtested
and picked the "recommended package": restore sound, add seaweed wraps, one scripted golden fish,
a juice pass on the two peak moments, retune to keep a 20-30s first-try win. ONE build, sound
gesture-gated in both the hosted and packaged artifacts. Same Do-NOTs as Round 1; copying files
OUT of the read-only source dirs is allowed.

## Phase R2-A — restore the synthesized audio bus

**Red-teamed 2026-08-13; the fixes below are load-bearing.**

- Replace the no-op `src/audio.js` with the source bus
  (`../pixelflow-claude-code-env/reef/styled_fof_version/src/audio.js`, 384 lines), then REWIRE
  (not delete) the mp3 file layer — the packaged build must make zero network requests. The trap:
  `onMineBoom/onDewrap/onGoldenLaunch/onGoldenPierce/onTreasure` exist ONLY as fallback closures
  inside `_playFile(id, fallback)` (source audio.js:340-367), and the ambient bed starts ONLY via
  the file-load fallback chain (`startAmbient` → `_wantAmbient` → `_afterLoad` → `_startAmbient`).
  So: promote each fallback closure to the method body, rewire `startAmbient()` to call
  `_startAmbient()` directly, THEN remove the fetch/decode layer. Keep every synthesized voice:
  ambient bed, per-color pops, dewrap, mine boom, park/vacate, treasure, lose, launch plips.
- `main.js` already calls every bus method and resumes on first canvas `pointerdown` (main.js:565),
  so the gesture gate exists: AudioContext is created/resumed ONLY inside `resume()` (never at
  module load — the source already does this right, keep it that way).
- Re-add a small mute toggle button (the existing `toggleMute()`), top corner — the corners are
  free (`#hud` sits at top:58px). Gotchas: `#ui` is `pointer-events:none` (index.html:22), so the
  button needs its own `pointer-events:auto`; and clicking mute BEFORE touching the canvas won't
  have created the AudioContext, so the mute handler must also call `audio.resume()`. Icon or
  plain text label, no dashes/arrows.
- De-brand any comments the copied file carries (Round 1 Phase 1 rule applies).

## Phase R2-B — seaweed wraps on the two coral accents

- Level: add `wraps` for the two 'A' cells (pattern row index 5 → world row 3, cols 1 and 7 —
  coords verified against `expandPattern`).
- Asset diet: copy `seaweed.png` from the source sprites into `public/assets/sprites/` (256px max
  downscale) + add the `manifest.json` entry. That is ALL — `build-single.mjs` derives its inline
  map from `manifest.sprites` automatically. board.js already renders `wrapped`; pigs.update
  already dewraps; the winnability harness already counts wrapped as 2 hits.

## Phase R2-C — one scripted golden fish

- Re-add `pig_g.png` (256px) the same way (sprite file + manifest entry).
- Ship the existing `{ goldenHead: true }` boot option (pigs.js:119-125): one guaranteed golden
  lane head from t=0, deterministic, zero new code paths. Do NOT build a mid-run wall-clock
  injection — the solver wins in 5.7s on 3 of 5 seeds, so an 8-12s timer races the win and can
  fire never. (There is no `_mint`; the golden branch lives in `_spawnQueuePig`, pigs.js:193-201.)
- `goldenChance` stays 0 (no random goldens on top of the scripted one).
- The winnability harness constructs PigManager with no opts, so it does NOT validate the golden —
  the golden is a hand-playtest item, say so in the report.

## Phase R2-D — juice pass (two peak moments only)

- Mine blast: screen shake ALREADY EXISTS and already fires (`vfx.js:632` sets `this.shake`,
  decay at :644-653, applied in main.js:829-830). Do not add a second shake system — tune
  `SHAKE_AMP` up and enlarge the mine particle burst, nothing else. (Shake offsets
  `camera.position`, not the frustum, so the portrait clamp is safe.)
- Treasure reveal: slow the reveal beat, add glow/scale pulse + a fuller coin fountain. The end
  card currently pops the instant `state==='won'` (main.js:718-719) and ALREADY overlaps the
  reveal — gate `winScreenEl.classList.add('in')` behind the reveal finishing (winAge >= the new
  reveal duration, or a timeout matched to it), or slowing the reveal makes the overlap worse.
- Nothing else gets juice this round. No user-visible dashes/arrows in any new string.

## Phase R2-E — retune + full re-verification (all must show output)

1. Wraps add ~2 hits: retune pattern/CONFIG only as needed. The harness proves WINNABILITY
   (solver floor), not the 20-30s human first-try — that 20-30s claim is Marko's hand-playtest
   item, never claim it from harness numbers.
2. `verify-winnability.mjs` green — 5/5 seeds winnable with wraps in.
3. `npx vite build` exit 0; `node scripts/build-single.mjs`; report byte sizes. Single file must
   stay under 5MB (was 3,608,788 bytes; 2 sprites + code adds well under 200KB — headroom 1.63MB).
4. adpreflight against the fresh single-file: unity + google both pass, exit 0, verdict verbatim.
5. Zero-network check the gates DON'T cover (adpreflight scans HTML attrs, not JS fetch calls):
   `grep -nE "fetch\(|\.mp3|AUDIO_BASE" dist-single/index.html` → zero hits required.
6. `grep -rIioE "fof|fortune|pixel ?flow" dist/ dist-single/` → zero hits (the copied audio.js
   comments are the likely leak).
7. One commit per phase, in this repo, from this dir.
