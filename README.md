# Writing Desk

A small macOS writing editor for Victor (native SwiftUI, built with Command Line Tools only, no Xcode). Everything stays on your own Macs. The optional sync goes only to your own server over Tailscale.

- **Editor**: minimal title + body, autosaved on every keystroke. Victor writes all article text; the app never generates or suggests article text.
- **Accountability**: a daily word goal (default 500, adjust in steps of 50), today's progress bar, a 14-day history chart, and a streak counter. Only *new* words count, so deleting text never lowers a day's total.
- **Ideas from Elon**: a separate side panel (never mixed into articles) holding prompts and things to think about, with a checkbox to mark each one done. Ideas come from a local inbox folder (below) or can be typed in by hand.
- **Covers**: the toolbar **Covers** button generates 5 distinct, text-free, minimalist cover options (Orbit, Grid, Waves, Monolith, Rhythm) at exactly **5:2 (1500×600)**. They're built offline from the article's keywords and sentence rhythm, so different articles get different covers and the same article always gets the same ones. **Export PNG…** saves a cover (defaults to the `covers/` folder).

## Install on a Mac

**Prebuilt (Apple silicon):** download `WritingDesk.zip` from the repo's latest GitHub Release, unzip it, and drag `WritingDesk.app` into `/Applications`. The app isn't notarized, so the first time you open it, right-click it and choose **Open**.

**From source (any Mac with the Command Line Tools: `xcode-select --install`):**

```sh
git clone https://github.com/WittorioJaro/writing-desk.git
cd writing-desk
./scripts/build-app.sh && ditto build/WritingDesk.app /Applications/WritingDesk.app
open /Applications/WritingDesk.app
```

Each Mac keeps its own copy in `~/Library/Application Support/WritingDesk/`. To share it between Macs, turn on [sync](#sync-between-macs-over-tailscale).

## Sync between Macs (over Tailscale)

One Mac (the Mac mini) runs a tiny sync server that stores everything in a single SQLite file. Other Macs sync with it over your tailnet. There are no accounts and no third-party services, and nothing goes over the public internet.

**On the server Mac (once):**

```sh
./scripts/install-server.sh      # build, install as a LaunchAgent, expose on the tailnet
./scripts/uninstall-server.sh    # stop it (data is kept)
```

The server listens only on `127.0.0.1:8766`. `tailscale serve` publishes it to your tailnet as `http://<mac-name>:8765`. Tailscale accepts the connection, so the macOS firewall needs no exception and your LAN can't reach the server. Re-run the install script after pulling changes.

**On every Mac (including the server Mac):** click the **Sync** toolbar button, enter `http://<mac-name>:8765`, and click **Turn on**. The app syncs at launch, every 30 seconds, and a few seconds after you stop typing. The status line shows the last sync or any error.

**What syncs:** articles, Elon's ideas (including done ticks), the daily goal, and the word history.
- **Word counts:** tracked per Mac, so writing on two Macs on the same day adds up instead of double counting.
- **Deleting:** removing an article deletes it everywhere. If another Mac edited it after its last sync, though, that writing is kept.
- **Conflicts:** if the same article was edited on two Macs between syncs, nothing is lost. The newer edit stays as the article, and the other version appears next to it as **"<title> (conflict copy)"**.
- **Ideas inbox:** the inbox folder is per Mac. Ideas dropped on the Mac mini reach the other Macs through sync.

**Server files** (`~/Library/Application Support/WritingDeskServer/`):

| Path | What |
|---|---|
| `writing-desk.sqlite` | the database: table `docs(kind, id, json)`. Inspect it with `sqlite3 writing-desk.sqlite "select kind, id from docs"` |
| `backups/yyyy-MM-dd.sqlite` | a snapshot taken before each day's first change (the newest 14 are kept) |
| `server.log` | server log |
| `~/Library/LaunchAgents/local.writingdesk.server.plist` | starts the server at login and restarts it if it stops |

The app uses plain HTTP to reach the server. The traffic is encrypted by Tailscale (WireGuard), and the app bundle allows non-HTTPS connections for this.

## Build & run

```sh
make test   # build + run the 22 checks (covers, persistence, accountability, ideas, failure safety, sync incl. a real two-Mac server run)
make run    # build build/WritingDesk.app and open it
make app    # just build the .app
```

Or run it directly: `./scripts/build-app.sh && open build/WritingDesk.app`.

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

### Inbox format

One idea per line. Leading `-`, `*`, `•` or `1.` bullets are stripped, lines starting with `#` are ignored, and case-insensitive duplicates are skipped. The inbox is read at launch, when you click the tray button in the ideas panel, or with ⇧⌘I. Files are handled one at a time: the ideas are saved to `state.json` first, and only then is the file moved to `inbox/imported/`. This save happens even when a file contains only duplicates, so a file is never archived while the ideas it repeats exist only in memory. If a file can't be read, or its ideas can't be saved, the original stays in `inbox/` and the reason is shown in the status line. Files imported earlier in the same run stay saved. Retrying is safe: ideas that are already saved are skipped as duplicates, so a file whose move failed adds nothing the second time and is just moved.

```md
# Ideas — 2026-11-21
- Why do streaks fail after week two?
- Think about what "minimal" means for a cover
```

## If saved data can't be loaded

If `state.json` exists but can't be read (for example, it's corrupted or was edited by hand), Writing Desk opens **read-only**: a red banner shows the error, editing is disabled, and nothing is written. The startup inbox import and sync are paused too. The file is left exactly as it was. To recover, fix `state.json` or move it aside (use **Show in Finder** on the banner), then relaunch. If there's no `state.json` at all, that's treated as a normal first launch.

## Notes

- Nothing is sent over the network except to the sync server you configure. Covers are drawn with CoreGraphics and contain no text.
- Tests are a plain executable (`WritingDeskChecks`) because the Swift Testing/XCTest macro plugins aren't available with Command Line Tools alone. For the same reason the UI avoids the `@State` macro and keeps view state in the `ObservableObject` model instead.
- `COVER_SAMPLES_DIR=/tmp/x make test` also writes sample covers for visual review.
