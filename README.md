# Ayah Live

A mobile-first web app (PWA) that listens to Quran recitation — an imam in salah, a recording,
or your own recitation — identifies the surah and ayah being recited as it happens, and plays
**your own** pre-recorded English translation of each verse (`29-11.mp3`, `104.mp3` …).

Recognition runs entirely on the phone. No audio is sent anywhere.

```
mic ─► AudioWorklet ─► worker: resample 16 kHz ─► conditioner ─► Zipformer2-CTC (WASM)
                                                                     │ word-level aligner
                                                                     ▼
            history ◄── confirmed ◄── VerseTracker (sequence, context, priors, ambiguity)
               │
               └──► PlaybackController ─► exact file resolver ─► your mp3s
```

---

## Quick start

```bash
npm install --ignore-scripts      # --ignore-scripts skips onnxruntime-node's optional GPU download
npm run fetch-assets              # 69 MB model + Quran text from Tilawa's GitHub releases, SHA-256 verified
npm test                          # tracker, resolver and playback-policy tests
npm run dev                       # http://localhost:5173
```

The microphone needs a secure origin. `localhost` works on a computer; for your phone, deploy it
(next section) and open the HTTPS URL in Chrome. Then *⋮ → Add to Home screen* to install it.

### Deploy to GitHub Pages (free)

1. Create a GitHub repository and push this folder to its `main` branch.
2. Repository *Settings → Pages → Build and deployment → Source: GitHub Actions*.
3. The included workflow (`.github/workflows/pages.yml`) downloads the model, runs the tests,
   builds, and publishes to `https://<you>.github.io/<repo>/`.

Any static host with HTTPS that allows a 69 MB file works (GitHub Pages, Netlify; not
Cloudflare Pages, which caps files at 25 MB). `npm run build` produces `dist/`; serve it as-is.

The first visit downloads the recogniser once (≈69 MB model + 9 MB data + 15 MB runtime); it is
cached on the phone after that and the app works offline.

---

## Using it

1. **Settings → Your translation files → Choose folder** (or *Choose files* and select all).
   Accepted names, case-insensitive:
   - one verse: `92-2.mp3`, `92-02.mp3`, `114-06.mp3`, `092-002.mp3`
   - whole surah: `104.mp3`
   - optional cues: `start.mp3`, `stop.mp3` (otherwise the bundled `assets/audio/` chimes play)

   Files are stored on the phone (IndexedDB) and never uploaded. Alternatively set a hosted
   folder URL (e.g. `translations/` deployed next to the app; an optional `index.json` listing
   the file names avoids probing).
2. Pick the prayer: **General · Jummah · Maghrib · Isha**.
3. **Start listening.** The big ornament shows the verse: brass while it is still being heard,
   verdigris once confirmed. Confirmed verses are listed with their time.
4. **Tap** a history row to replay that verse's translation. **Long-press** (or right-click, or
   the ⋯ button) for *Play full surah translation*.
5. Earbud **play/pause** toggles listening (see limitations below).

Use earbuds: translations played through the phone speaker are heard by the microphone. If you
must use the speaker, turn on *Translations play through the phone speaker* (browser echo
cancellation).

---

## How recognition works

### 1. Acoustic model — chosen by measurement

| Candidate | What it is | Verdict |
|---|---|---|
| **Tilawa Zipformer2-CTC** (`zipformer_a0w_ep1_a05.int8.onnx`, 66 MB) | Streaming CTC over 251 tajweed-phoneme tokens, with a word-level aligner over the whole Quran | **Used.** Truly streaming (300 ms chunks, no re-decoding), runs in browser WASM, best published live-tracking results (Tilawa v3 corpus 248/256 with the remaining misses mostly word-identical verses) |
| Tilawi FastConformer (`muhdur/tilawi-fastconformer-quran`, ~110 MB) | Text-CTC FastConformer fine-tuned on Quran + trust gate | Excellent on whole clips (599/600 EveryAyah verses) but clip-based: live use means re-running on overlapping windows. Compared below via Tilawa's equivalent FastConformer export |
| Tarteel Whisper tiny/base | Whisper fine-tuned on Quran | Not streaming (30 s encoder windows), hallucinates on silence/noise; in Tilawa's benchmarks every Whisper variant trails FastConformer/Zipformer on streaming recall and precision |
| yayaiu6 Real-Time Tracker | NeMo Conformer-CTC small + Python backend over WebSockets | Server-side only; sends audio off the device |

### 2. The tracker (`src/core/tracker/verseTracker.ts`)

The recogniser proposes; the tracker decides. Two states, as specified:

- **Tentative** — the recogniser is aligned to a verse and words are being heard (brass outline
  traces the fraction heard), or a proposal is being held for corroboration.
- **Confirmed** — committed to history and translation playback triggered.

Rules, in order:

- **Continuation.** The verse after the last confirmed one (or one later, if one was missed) is
  confirmed from its *own* words: half of a short verse, or 4 words of a long one. Never from
  zero words — the expected next verse is never substituted for audio evidence.
- **Discovery** (first verse, after a pause, after Al-Fatihah, after a surah's last verse) is
  accepted on the recogniser's gate unless it is *risky*: very short (≤3 words), its opening
  half also opens another verse, ≥75% word-identical to another verse, heard through poor
  audio, or the basmala. Risky proposals are held until the next verse continues them or nearly
  all of their own words are heard.
- **Jumps** away from a running passage without a pause are always held until corroborated; if
  the recogniser returns to the passage, the jump is dropped.
- **Pauses** (≥4 s without recitation) reset the recogniser, so Al-Fatihah — or any verse the
  imam repeats — is heard again in every rak'ah (the bare SDK reports each verse once per session;
  see benchmark *salah* rows).
- **Identical verses** (96 groups, e.g. 55:13 ×31, 77:15 ×10, the *Ha Mim* openings) are placed
  by context; with no context they are confirmed with their alternatives listed ("same words in
  30 other places") and revised automatically once the next verse settles the location.
- **Prayer priors** (`src/core/tracker/priors.ts`) only lower the bar for favoured surahs;
  nothing is ever excluded. Sources: Muslim 877/878 (Jumu'ah: Al-Jumu'ah, Al-Munafiqun,
  Al-A'la, Al-Ghashiyah), Nasa'i 982/983 (short mufassal in Maghrib, medium in Isha), Bukhari
  763/765 (Al-Mursalat, At-Tur in Maghrib), Bukhari 767 (At-Tin in Isha). These are documented
  practices turned into small multipliers, not frequency estimates.
- **Sensitivity** (Careful / Balanced / Fast) moves the risk threshold.

### 3. Audio (`src/core/audio/`)

Windowed-sinc resampling to 16 kHz; 70 Hz high-pass; slow speech-gated gain (target −24 dBFS,
up to +30 dB, never lifting the noise floor above −35 dBFS); soft limiter for coughs near the
phone. Deliberately **no** spectral noise suppression and no gating: they delete breathy
consonants and long tajweed vowels. Browser noise suppression/AGC are off. A speech-vs-noise
estimate makes evidence heard through poor audio count for less.

### 4. Playback (`src/core/playback/`)

- **Exact resolver.** A verse resolves only to a file named for that verse; unpadded name wins
  deterministically if both `92-2.mp3` and `92-02.mp3` exist. Missing file → "No translation
  file for 29:12", tracking continues. Whole-surah files are separate from verse files.
- **Follow live** (default): never more than one verse behind — one clip plays, one waits, a
  newer verse replaces the waiting one. **Every verse in order**: FIFO, capped at 12.
- Each history entry auto-plays at most once; a legitimately repeated verse is a new entry and
  plays again. One `<audio>` element for translations, so clips never overlap. Manual replays
  interrupt and can be paused/stopped.

---

## Benchmarks

`bench/make_corpus.py` builds test streams from real recitations (Tilawa's corpora: EveryAyah
studio reciters Alafasy/Husary, TLOG and RetaSy crowd-sourced phone recordings, user recordings)
under four conditions, and `bench/run.ts` streams them through the same code the app runs, in
320 ms chunks:

| Condition | Simulation |
|---|---|
| clean | original audio |
| mild | small room: RT60 0.8 s, DRR +4 dB, pink noise SNR 20 dB, −30 dBFS |
| hall | mosque, several rows back: RT60 1.6 s, DRR 0 dB, babble + pink SNR 12 dB, coughs, footsteps, −36 dBFS |
| pocket | hall + phone in a pocket: 2.5 kHz cloth low-pass, SNR 6 dB, −40 dBFS |

Stream kinds: **single** (one verse, fresh start), **salah** (Fatihah → passage → 12 s
ruku/sujud gap → Fatihah → passage), **midstart** (listening starts 3 s into a passage; the
first verse is optional), **noise** (60 s of babble, coughs, reversed and syllable-shuffled
recitation — Arabic-sounding audio that is not Quran in order; nothing should be confirmed).

Interim results (clean audio, first pass; the full four-condition run is still in progress):

| Variant | Kind | Streams | Recall | Wrong | Exact sequence |
|---|---|---|---|---|---|
| This app (tracker) | single verse | 20 | 95% | 0 | 95% |
| Bare Tilawa SDK | single verse | 20 | 95% | 0 | 95% |
| This app (tracker) | salah (2 rak'ahs) | 12 | 99.7% | 0 | 92% |
| Bare Tilawa SDK | salah (2 rak'ahs) | 12 | 70.2% | 0 | 0% |

The salah gap is the second-rak'ah Al-Fatihah: the bare SDK reports each verse once per
session, so it never confirms Al-Fatihah again; the pause reset fixes that. The one tracker
miss was 44:1 (*Ha Mim*, identical in seven surahs), since fixed by resolving held identical
verses from the verse that follows (unit-tested).

*Recall* counts word-identical verses as correct (audio cannot separate them), as in Tilawi's
evaluation. *Wrong* = verses confirmed that were not recited. Latency is from the end of the
verse's audio (negative = confirmed before the reciter finished it). RTF is on 2 cloud vCPUs
with native ONNX Runtime; in headless Chrome (WASM, 1 thread) the app ran at about 21% of real
time while the benchmark shared the CPU.

Reproduce: clone `https://github.com/yazinsai/tilawa` for the source audio, then

```bash
python3 bench/make_corpus.py <tilawa>/lab/benchmark bench/data --singles 120
npx tsx bench/run.ts --data bench/data --variants tracker,baseline --out results.json
```

The best test is your own: record a Jummah/Maghrib/Isha recitation on your phone and run it
through the same harness (put it in a folder with a `manifest.json` in the format the script
writes).

---

## Screen-off listening and earbud controls — what works and what doesn't

| | Chrome on Android (installed PWA) |
|---|---|
| Listening with screen on (wake lock) | ✅ reliable — the default (*Keep the screen on*). Dim it and put the phone face down. |
| Earbud play/pause → toggle listening | ⚠️ designed for, not yet tested on your phone: a near-silent loop keeps the Media Session active while listening, so the key reaches the app; after a stop, the paused media notification should let play restart listening. Some earbuds and OS versions don't send the key at all — the on-screen button always works. |
| Listening after locking the screen | ⚠️ not guaranteed. Chrome may keep capturing while the tab plays audio, but Android can suspend it. If the microphone is taken away the app stops cleanly and tells you; it never pretends to be listening. |

**Guaranteed screen-off listening needs a native shell.** The recognition core (`src/core/`) and
the UI are independent of the browser, so the same app can be packaged:

1. **Capacitor** (`npx cap add android`): the built `dist/` runs in a WebView.
2. Add a **foreground service** of type `microphone` (Android 14+: `FOREGROUND_SERVICE_MICROPHONE`)
   with a persistent notification; capture with `AudioRecord` at 16 kHz in the service and pass
   PCM frames to the WebView (or run the model natively with `onnxruntime-android` and the same
   tracker logic ported, or via `@tilawa/core` in a headless JS runtime).
3. Register an Android **MediaSession** in the service so earbud play/pause toggles capture.
4. Keep the WebView for the UI and translation playback.

This is the same shape as your existing Android shells (one WebView, full screen), plus a
foreground service. The web app stays the source of truth.

---

## Project layout

```
src/core/            framework-free, unit-tested, used by the app and the benchmark
  quran/             verse index (Hafs counts verified at build), identical/near-twin tables
  audio/             resampler, conditioner
  engine/            Recognizer interface + Tilawa adapter (swap models here)
  tracker/           VerseTracker, prayer priors
  playback/          exact file resolver, playback policy
  pipeline.ts        conditioner → recogniser → tracker, pause resets
src/app/             browser glue: worker, mic/worklet, media session, wake lock, IndexedDB
src/ui/              React components
public/              worklet, service worker, manifest, icons, cues, models/ (fetched)
scripts/             fetch-assets (download + verify), build-data (verse index + checks)
bench/               corpus builder and benchmark harness
```

## Licences

- This code: MIT.
- Recognition model and phoneme corpus: Quran-Lab / Tilawa, **NPL-1.2** — free to use and host,
  non-commercial, share-alike (`public/models/NPL-1.2.txt`). You may not charge for the app or
  any feature it powers.
- `@tilawa/core` SDK: MIT. ONNX Runtime: MIT.
- Quran text: Tanzil Project Uthmani text (CC-BY 3.0), used verbatim.
- Fonts: Amiri and Instrument Sans (SIL OFL).
