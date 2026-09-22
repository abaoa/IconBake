// Browser polyfill for Node's global `Buffer`.
//
// `ttf2woff` — the module that turns our TTF into WOFF — is written against
// Node's `Buffer`. Browsers (and the Tauri webview) have no such global, so
// without this polyfill the font build aborts with "Buffer is not defined".
//
// Import this module before anything that can trigger a font build.
import { Buffer as BrowserBuffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: unknown }
if (!g.Buffer) {
  g.Buffer = BrowserBuffer
}
