# design/

Source artwork. Nothing here is served or bundled — it lives outside `static/`
on purpose, so the masters don't get published to the web root or swept into the
service-worker precache (`vite.config.ts` globs all of `static/`).

| File              | What it is                                     |
| ----------------- | ---------------------------------------------- |
| `icon.svg`        | Vector master, 800×800                          |
| `icon-master.png` | Raster master, 1600×1600                        |

**Note:** both masters are the *white glyph on transparent* variant. The shipped
icons put that glyph on an orange squircle (`rgb(231, 92, 23)`), and that
composite step happened outside this repo — so these files are the glyph source,
not a pixel-exact master of what ships.

## Regenerating

**Web maskable icon** (`static/icons/icon-maskable-512.png`) is derived from
`static/icons/icon-512.png`:

```sh
bun run scripts/gen-maskable-icon.ts
```
