# Writing Desk

A quiet macOS writing desk for Victor: a large empty page, a daily goal, a streak that keeps you going, prompts from Elon, and offline 5:2 cover art. Built with Electron. Everything stays on your own Macs; the optional sync goes only to your own server over Tailscale.

- **The page**: title and body in a big serif on an empty canvas. Start typing and everything else fades away; move the mouse to bring it back. Autosaved as you type. Victor writes all article text: the app never generates or suggests any.
- **Momentum**: a thin ember line along the top fills toward today's goal. The chip bottom right shows today's words and your streak. Crossing the goal sets off the celebration: a ring draws itself, the streak number rolls up, embers burst and fly home to the streak flame. Milestones (3, 7, 14, 30, 50, 100, 365 days…) get a gold version. **⌘J** opens Momentum: a live flame that grows with your streak, today's ring, goal stepper, best streak, and a 20-week heat map where your current streak shimmers. Only *new* words count, so deleting text never lowers a day.
- **From Elon** (**⌘I**): a side panel of prompts and things to think about, kept apart from your writing, with a check to mark each done. Ideas arrive from the inbox folder (below), live, with a badge for unseen ones, or can be added by hand.
- **Covers** (**⌘K**): every cover is exactly **5:2** and has no text. Pick one with **Use as cover** and it sits at the top of the piece, above the title (hover it to change or remove it). **Export PNG** saves 3000×1200 (default folder `covers/`).
  - **Suggested by Codex**: once a piece has a title and about 60 words, and you pause writing, the app asks your own Codex CLI to paint three cover images for it with Codex's built-in image generation (no API key needed), in the background. The three run in parallel, one per art direction (bold geometric, atmospheric scene, symbolic object), and each appears as soon as it's done, usually within 30–40 s. When they're ready, a small notice slides down from the top; click it to see them. It suggests again when the title changes or the piece grows by ~200 words, and **Suggest again** does it on demand. Turn it off with the switch at the bottom of the Covers panel.
  - **Drawn from your words**: six offline styles (Bloom, Horizon, Orbit, Rhythm, Mosaic, Waves) built from the piece's keywords and sentence rhythm. **Shuffle** gives new compositions from the same words.
- **Your writing** (**⌘O**, or rest the pointer on the left edge): every piece with a preview, search, and delete. **⌘N** starts a new piece.

## Install on a Mac

```sh
git clone https://github.com/WittorioJaro/writing-desk.git
cd writing-desk
make install      # needs Node.js; builds "Writing Desk.app" and copies it to /Applications
```

The app is ad-hoc signed, not notarized. If macOS blocks the first launch, right-click it in Applications and choose **Open**. For an Intel Mac: `cd app && WD_ARCH=x64 npm run build`.

Each Mac keeps its own copy in `~/Library/Application Support/WritingDesk/`. To share it between Macs, turn on [sync](#sync-between-macs-over-tailscale).

## Sync between Macs (over Tailscale)

One Mac (the Mac mini) runs a tiny sync server that stores everything in a single SQLite file. Other Macs sync with it over your tailnet. There are no accounts and no third-party services, and nothing goes over the public internet.

**On the server Mac (once):**

```sh
./scripts/install-server.sh      # build, install as a LaunchAgent, expose on the tailnet
./scripts/uninstall-server.sh    # stop it (data is kept)
```

The server listens only on `127.0.0.1:8766`. `tailscale serve` publishes it to your tailnet as `http://<mac-name>:8765`. Tailscale accepts the connection, so the macOS firewall needs no exception and your LAN can't reach the server. Re-run the install script after pulling changes.

**On every Mac (including the server Mac):** click the small dot in the top-right corner (or press ⌘,), enter `http://<mac-name>:8765`, and click **Turn on**. The app syncs at launch, every 30 seconds, and a few seconds after you stop typing. The dot turns green when synced, red on an error; the Sync panel shows the details.

**What syncs:** articles, Elon's ideas (including done ticks), the daily goal, and the word history.
- **Word counts:** tracked per Mac, so writing on two Macs on the same day adds up instead of double counting.
- **Deleting:** removing an article deletes it everywhere. If another Mac edited it after its last sync, though, that writing is kept.
- **Conflicts:** if the same article was edited on two Macs between syncs, nothing is lost. The newer edit stays as the article, and the other version appears next to it as **"<title> (conflict copy)"**.
- **Ideas inbox:** the inbox folder is per Mac. Ideas dropped on the Mac mini reach the other Macs through sync.

**Footprint:** one ~600 KB native binary. Idle it uses ~10 MB of memory and no CPU (no timers; it only wakes for a request). A sync of ~700 KB of writing costs ~14 ms of CPU, so two Macs syncing every 30 s use about a minute of CPU a day. Only syncs that change something are written to the database and the log.

**Server files** (`~/Library/Application Support/WritingDeskServer/`):

| Path | What |
|---|---|
| `writing-desk.sqlite` | the database: table `docs(kind, id, json)`. Inspect it with `sqlite3 writing-desk.sqlite "select kind, id from docs"` |
| `backups/yyyy-MM-dd.sqlite` | a snapshot taken before each day's first change (the newest 14 are kept) |
| `server.log` | server log: only syncs that changed something, and errors |
| `~/Library/LaunchAgents/local.writingdesk.server.plist` | starts the server at login and restarts it if it stops |

The app uses plain HTTP to reach the server; the traffic is encrypted by Tailscale (WireGuard). Only the app's background process talks to the server — the writing window itself has no network access at all.

## Build & test

```sh
make test      # app unit tests (incl. two Macs syncing through the real Swift server), app end-to-end, server checks
make run       # run the app from source
make app       # build app/dist/Writing Desk-darwin-arm64/Writing Desk.app
make install   # build and install to /Applications
```

Layout: `app/` is the Electron app (`src/core` = data, sync and inbox logic in the main process; `src/renderer` = the UI, motion and covers). `Sources/` is the Swift sync server and its checks.

## Data paths (all local)

Default root: `~/Library/Application Support/WritingDesk/`. Set `WRITING_DESK_HOME=/some/dir` to override it (useful for testing).

| Path | What |
|---|---|
| `state.json` | articles, ideas, goal, daily word history |
| `inbox/` | **Elon's ideas inbox**: drop `.txt` / `.md` files here |
| `inbox/imported/` | inbox files that have already been processed |
| `covers/` | default PNG export folder |
| `device-id` | random id for this Mac (keeps per-Mac word counts apart) |
| `sync.json` | sync server URL and on/off switch |
| `sync-state.json` | which server versions this Mac last saw (used to detect conflicting edits) |
| `covers.json` | the chosen cover per piece, Codex suggestions, and the Smart covers switch (this Mac only, not synced) |
| `covers/suggested/` | cover images painted by Codex, one folder per piece |

### Inbox format

One idea per line. Leading `-`, `*`, `•` or `1.` bullets are stripped, lines starting with `#` are ignored, and case-insensitive duplicates are skipped. The inbox is read at launch, whenever a file lands in the folder (it's watched), from **Check inbox** in the From Elon panel, or with ⇧⌘I. Files are handled one at a time: the ideas are saved to `state.json` first, and only then is the file moved to `inbox/imported/`. This save happens even when a file contains only duplicates, so a file is never archived while the ideas it repeats exist only in memory. If a file can't be read, or its ideas can't be saved, the original stays in `inbox/` and the reason is shown in a notice. Files imported earlier in the same run stay saved. Retrying is safe: ideas that are already saved are skipped as duplicates, so a file whose move failed adds nothing the second time and is just moved.

```md
# Ideas — 2026-11-21
- Why do streaks fail after week two?
- Think about what "minimal" means for a cover
```

## If saved data can't be loaded

If `state.json` exists but can't be read (for example, it's corrupted or was edited by hand), Writing Desk opens **read-only**: a red banner shows the error, editing is disabled, and nothing is written. The startup inbox import and sync are paused too. The file is left exactly as it was. To recover, fix `state.json` or move it aside (use **Show in Finder** on the banner), then relaunch. If there's no `state.json` at all, that's treated as a normal first launch.

## Notes

- Nothing is sent over the network except to the sync server you configure, and, while **Smart suggestions with Codex** is on, the **title and the opening (~180 words)** of a piece, which the Codex CLI sends to OpenAI under your own sign-in. Codex runs read-only in an empty temporary folder with `--ephemeral`, so it keeps no session. The window itself can only load local files (enforced by a content-security policy and a request filter).
- Each Codex run works in an empty temporary folder (`-s workspace-write`, which image generation needs, and `--ephemeral`). Codex saves the image under `~/.codex/generated_images/`; the app accepts it only if it's a fresh PNG inside that folder, then moves it to `covers/suggested/<piece>/`. Images come back at 1983×793 (5:2); anything else is center-cropped to 5:2. Exports use the image's full resolution. The model defaults to `gpt-6-luna` with low reasoning (the image model does the painting), set in `covers.json`, because the default in this Mac's Codex config isn't available with a ChatGPT sign-in.
- The chosen cover is stored per Mac, so it doesn't sync yet: the Swift sync server would drop fields it doesn't know.
- The app never writes or suggests article text (Codex only paints pictures, and is told not to put any words in them). Elon's prompts live in their own panel and never touch your writing.
- Data format is unchanged from v1, so the Swift sync server and older copies keep working. Dates stay as Apple reference-date seconds and article fingerprints are exact 64-bit values, so this app and the server agree on what changed.
- `npx electron test/shots.js /tmp/shots` (in `app/`) saves screenshots of every view from a seeded test workspace; `SHOT_THEME=light` for light mode.
- `npx electron test/trace.js /tmp/trace [scenario…]` (in `app/`) traces every animation frame by frame under a controlled clock (timers, `requestAnimationFrame`, CSS animations and the canvas embers all step together) and saves one contact sheet per scenario, e.g. `celebration`, `momentum-open`, `covers-shuffle`.
- Ambient motion (the streak ember, the unseen-prompts dot, the goal-line shine) plays a few times and then rests, and everything pauses when the window isn't focused, so the app idles at ~0% CPU.
