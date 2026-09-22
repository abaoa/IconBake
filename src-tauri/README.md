# Tauri desktop shell for IconBake

This folder turns the pure-frontend IconBake web app into a small native desktop
executable (Windows / macOS / Linux) using [Tauri](https://tauri.app).

## Prerequisites
- Rust toolchain: https://rustup.rs
- Platform build deps for Tauri: https://tauri.app/v1/guides/getting-started/prerequisites

## Generate app icons (required before building)
```
npx tauri icon path/to/your-icon.png
```
This writes `icons/32x32.png`, `128x128.png`, `icon.icns`, `icon.ico` referenced by
`tauri.conf.json`.

## Run / build
```
npm run tauri dev        # dev with hot reload
npm run tauri build      # produce the installer / .exe (a few MB, not 100s of MB)
```

The resulting `.exe` ships with no external font backend — the whole font build
happens in the bundled WebView, same code as the website.
