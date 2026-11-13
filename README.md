# Spectrogram

Sing into the mic and see, live:

- **the note** you're on, how many cents sharp or flat, and its frequency;
- **every overtone** of that note as a bar: how loud it is against the strongest one, which note it lands on, and how many cents that is off the piano's tuning;
- **the register**: where the sound sits between head, mix and chest, from how much of it is in the overtones;
- **the last few seconds** as a scrolling picture, with a strip under it coloured by register (ice-blue head, sage mix, brass chest).

## Opening it

Once it's on GitHub Pages (see the end of this file): **https://yonabenreuven2.github.io/spectrogram/**. Press **Start listening** and allow the microphone.

To try it before publishing, serve the folder and open `http://localhost:8000`:

```
cd C:\Users\yonab\Singing\spectrogram
python -m http.server 8000
```

No mic at hand? **Watch a made-up voice** on the start screen (or add `?demo` to the address) plays a synthetic voice gliding from a chest-like low note to a head-like high one.

**Install it as an app**, like Scales Feedback: on the Pages site in Chrome, the install icon at the right of the address bar; on Android, the menu's *Install app*. It then opens in its own window, also without a connection, and picks up new versions by itself (a bar offers a reload when one arrives while it's open).

## Reading it

**The bars.** The blue bar is the note you sing (the fundamental), the brass ones its overtones: 2 is an octave up, 3 a fifth above that, 4 two octaves, 5 a major third above that, and so on. Heights are in dB under the strongest harmonic. A faint bar is one lost in the room's noise. The cents under each are the same for every voice (the 3rd harmonic is always 2 cents wide of the piano's fifth, the 5th 14 cents narrow of its third, the 7th 31 narrow), shifted by however sharp or flat you are.

**The register meter.** Chest voice closes the folds for a long part of each vibration, which puts a lot of energy in the overtones: the 2nd and 3rd harmonic are often louder than the fundamental and many more follow. In head voice the folds barely close: the fundamental carries the sound and the overtones fall away fast. Mix is between. The meter combines:

- **overtones against the fundamental**: all the overtones' energy together, in dB over (or under) the fundamental's;
- **H1−H2**: the fundamental minus the 2nd harmonic. Around +10 dB or more is head-like, around 0 or below chest-like;
- **tilt**: how fast the harmonics fall away, in dB per octave.

The numbers are under the meter.

**It starts on a generic scale**, which is a reasonable guess, not a measurement of you. How strong the overtones come out also depends on your voice, the vowel, the pitch and the mic. A harmonic that lands on a resonance of the mouth gets a lift whatever the register, and a laptop mic that hears little below 100 Hz makes low notes look all overtone. So:

- **Teach it your voice** (Settings): hold one comfortable note in chest and one in head, two seconds each, on the same vowel. Your own two recordings then set the ends of the scale, and the meter says *set to your voice*.
- Compare like with like: the same vowel, a similar pitch.

**The picture** has two views (the buttons at the top, or V):

- **Frequency**: everything the mic hears, low at the bottom, with the C of each octave marked. Ticks on the right mark where each harmonic of the current note falls, with its number and note.
- **Harmonics**: one row per harmonic, the sung note at the bottom. The pattern stays put while the pitch moves, so a change of register shows as rows lighting up or going dark.

**Freeze** (Space) holds everything still to look at it.

| Key | Does |
| --- | --- |
| Space | Freeze or resume |
| M | Microphone on or off |
| V | Frequency or harmonics |
| S | Settings |

## Microphone

The browser's echo cancelling, noise suppression and automatic gain are turned off, because they change the overtones. Windows can add its own: Settings, System, Sound, your microphone, set **Audio enhancements** to **Off**. Settings in the app lets you pick the mic; Windows sometimes makes the piano's *Line (P-Series)* the default input.

Nothing is recorded or sent anywhere. The mic choice, A4 and your two voice recordings (two numbers) are kept in this browser, under names starting with `spectrogram.`.

## GitHub Pages

1. On GitHub, create an empty **public** repository named `spectrogram`.
2. Push this folder to it:

   ```
   cd C:\Users\yonab\Singing\spectrogram
   git init -b main
   git add .
   git commit -m "Spectrogram app"
   git remote add origin https://github.com/yonabenreuven2/spectrogram.git
   git push -u origin main
   ```

3. On the repository's page: **Settings**, **Pages**, *Deploy from a branch*, branch `main`, folder `/ (root)`, **Save**.

**The installed app's files** are the same as Scales Feedback's: `manifest.webmanifest` (its `id` is `/spectrogram/`, so Chrome doesn't take it for another app on the same site), `icons/`, `sw.js` (network first, keeps a copy for offline, only touches caches named `spectrogram-…`) and `js/pwa.js` (registers it and offers the reload). Bump the `?v=` numbers in `index.html` when a script or the stylesheet changes.

## Files and tests

- `js/dsp.js`: the measuring (pitch, spectrum, harmonics, the register number). No browser needed.
- `js/app.js`: the mic and the drawing.

```
node --test tests/*.test.js
```

The tests cover note names and cents, finding the sung note from C2 to C6 (also when the 2nd harmonic is the loudest or the fundamental is weak), silence and noise not counting as a note, each harmonic's loudness, H1−H2 and tilt, chest, mix and head spectra landing in their zones, and the scale set from your own recordings.
