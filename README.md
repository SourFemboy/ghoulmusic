# GhoulMusic v1.0

A private, local-first personal music PWA designed for iPhone.

## What is included
- Import multiple audio files from Files / iCloud Drive
- Local IndexedDB music storage
- Duplicate detection
- MP3 ID3 title / artist / album / genre / year / embedded cover reading
- Playback for formats supported by the browser
- Search
- Songs / artists / albums
- Liked Songs
- Custom playlists
- Queue
- Shuffle / repeat
- Recently added / recently played
- Play counts
- Media Session metadata and lock-screen controls where supported
- Offline app shell via service worker
- Persistent-storage request
- Library metadata export
- Home Screen PWA manifest

## Important storage design
Your original music files should stay in iCloud Drive as your permanent master copy.
When you import them into GhoulMusic, the browser stores another local copy for the app.
The JSON export backs up playlists/library information, NOT the audio files themselves.

## Hosting
This is a static site. Put every file/folder in this package at the root of an HTTPS static host.
GitHub Pages works well. Do NOT upload your music files to the GitHub repository.

## iPhone
After the site is live:
1. Open the HTTPS site in Safari.
2. Tap Share.
3. Tap Add to Home Screen.
4. Launch GhoulMusic from the new icon.
5. Tap Add Music and choose tracks from iCloud Drive.
6. Open Settings inside GhoulMusic and tap Protect Local Storage.

## Metadata
v1 has built-in embedded metadata extraction for MP3/ID3 files.
M4A/AAC/FLAC/WAV can still be imported and played when supported by iOS, but v1 may use the filename plus Unknown Artist/Unknown Album if metadata is not parsed.

## Privacy
The app has no analytics, account system, upload endpoint, or music server.
The music imported by the app remains in local browser storage on the device.

## iOS note
PWA/audio behavior can differ by iOS version. If a future iOS release causes a Home Screen audio issue,
the same hosted GhoulMusic site can also be opened directly in Safari as a fallback.
