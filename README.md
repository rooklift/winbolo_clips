# WinBolo Clips

Cuts short video clips out of **WinBolo** replays (`.wbv`): pick a piece
of the map and a stretch of the game, and get a WebM video of it.

It is the [WinBolo Replay Viewer](https://github.com/rooklift/winbolo_parser)
with one job added. The replay engine and the drawing are the viewer's,
unchanged (see [engine/](#the-engine)), so a clip looks exactly as the
viewer plays the game; the video export follows the
[Ancient Bolo Log Viewer](https://github.com/rooklift/ancient_bolo_parser)'s.

It is a web page, with no dependencies and nothing to build. Replays are
read, and clips encoded, in the browser; nothing is uploaded.

## Running it

Open `index.html` in a current Chromium browser (Chrome, Edge), straight
from disk or from any static file server. Or, as an
[Electron](https://www.electronjs.org/) window around the same page:

```
npx electron .
```

The export needs WebCodecs with a VP9 encoder, which Chromium has. Other
browsers will play replays but may refuse to export.

## Making a clip

1. **Open a replay**: drop it on the page, click, or Ctrl+O.
2. **Frame it.** Pan and zoom as in the viewer, then Shift+drag on the map
   to mark the clip's region. Drag the region's handles to resize it, and
   its size label to move it. The aspect menu holds it to 16:9, 4:3, 1:1
   or 9:16. "Fit to view" makes the view itself the region; with no region
   at all, the clip is the whole view.
3. **Set the start and the end**: go to each and press `[` and `]` (or the
   panel's Set buttons). `,` and `.` step a tick at a time to find them
   exactly. The clip's span shows in amber under the seek bar, and Enter
   plays it through once.
4. **Export.** The clip is rendered, then shown playing, with its size; a
   button saves it.

**What you see is what you get.** A tile that is 32 pixels wide on screen
is 32 pixels wide in the video, so the video's size is the region's size
at the zoom you are at, and the region's label reads it out. The region
belongs to the map: it stays where it is put while the view pans and
zooms, and zooming in makes the same piece of map a larger video. What is
drawn is what is on screen: the viewpoint's colours, simple graphics, the
debug labels if they are on.

**Following a player.** With the view locked to a player (L), the region
rides centred on that player, and so does the clip; it hears the player's
own gunfire as the player would.

## The video

- **WebM, VP9 video with Opus sound**, encoded at constant quality: the
  file's size follows what happens on screen. The three qualities trade
  size for sharpness.
- **50 frames a second by default.** The game runs at 50 ticks a second
  and the log states every one, so at 50 fps and 1× a frame is a tick:
  nothing is interpolated and nothing skipped. 25 fps shows every second
  tick.
- **Speed** is the game's speed in the clip, from 0.25× to 8×. It is
  independent of the playback speed on the transport bar.
- **Sound** is the viewer's inferred game sound, heard from the region:
  what happens inside it is near, the rest far. Clips faster than 1× are
  silent, as fast playback is.
- Width and height are rounded to even numbers of pixels, between 32 and
  4096. The art is 16 pixels to the tile, so zooms of 16, 32, 48, 64 and 80
  draw it at a whole multiple. Video stores colour at half resolution, so
  fine detail is cleaner at zoom 32 and up than at 16.

## Controls

| key                    | action                                       |
|------------------------|----------------------------------------------|
| Shift + drag           | mark the clip's region                       |
| drag a handle / the label | resize / move the region                  |
| `[`, `]`               | set the clip's start, end, to the current time |
| Shift+`[`, Shift+`]`   | go to the clip's start, end                  |
| Enter                  | play the clip's span once                    |
| `,` `.` (Shift: 1 s)   | back / forward one tick                      |
| Space                  | play / pause                                 |
| ← → (Shift: ×6)        | back / forward 10 seconds                    |
| ↑ ↓                    | previous / next change                       |
| Home, End              | beginning, end                               |
| F1 to F8               | playback speed 0.5× to 64×                   |
| A                      | game sounds                                  |
| wheel, Ctrl + - 0      | zoom at the cursor, zoom, centre the map     |
| drag                   | pan                                          |
| L                      | lock the view, and the clip, to the viewpoint player |
| G, T, M, B, N          | simple graphics, simple terrain, simple LGM, big shots, neutral pill colour |
| E, P                   | event messages, pre-game messages on the wire |
| D, I, U                | debug coordinates, pillbox IDs, base stocks  |
| Escape                 | abandon a drag; cancel an export             |
| ?                      | this list, on the page                       |

## The engine

`engine/` is copied from the viewer's repository and not edited here: the
parser (`logparse.js`), the replay engine (`game.js`), the map codec and
tile rules (`format.js`, `sprites.js`), the art (`sprite_data.js`) and
the sound rules (`sound.js`). `sound_data.js` is the viewer's sound
samples packed into one script, so the page can read them when opened
from disk. To take up changes made in the viewer:

```
node tools/sync.js [path to winbolo_parser]
```

(by default `../winbolo_parser`). The rest is this repository's own:

| file          | what it is                                               |
|---------------|----------------------------------------------------------|
| `renderer.js` | the viewer's renderer, cut down to a web page and opened up for the export |
| `clip.js`     | the clip: its region, its start and end, the panel and the overlay |
| `video.js`    | the export: frames through WebCodecs into the muxer, and the result |
| `webm.js`     | a minimal WebM muxer, the Ancient Bolo Log Viewer's      |
| `mixer.js`    | the soundtrack: the game's sounds mixed offline          |
| `main.js`     | the Electron window                                      |

## Tests

```
npm test
```

covers the muxer, the mixer, and that `engine/` matches the viewer's
repository where that sits beside this one. The export itself needs a
browser and is not in the suite.

## Provenance and credits

- **[WinBolo](https://github.com/milki/winbolo)** (**John Morrison**,
  1998-2008, GPL v2): the game, the log format and the tile art.
- **Stuart Cheshire**: Bolo itself, and its sound samples.
- **[WinBolo Replay Viewer](https://github.com/rooklift/winbolo_parser)**:
  everything in `engine/`, and the renderer this one is made from.
- **[Ancient Bolo Log Viewer](https://github.com/rooklift/ancient_bolo_parser)**:
  the video export's design, its WebM muxer and its sound mixer.
