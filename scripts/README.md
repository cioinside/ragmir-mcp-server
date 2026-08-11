# scripts/

Operational scripts for the `ragmir-mcp-server` repo.

Each `apply-rgr-*-patch.sh` script in this directory targets one known
upstream bug in the global `@jcode.labs/ragmir` package. All are
**idempotent** (safe to re-run), share the same exit-code contract
(`0` / `1` / `2`), and are auto-applied by `package.json`'s
`postinstall` hook. Run them by hand after any global upgrade of
`@jcode.labs/ragmir` that touches the install directory.

| Script | Upstream bug | Patch |
|---|---|---|
| `apply-rgr-pdf-patch.sh`   | [#158](https://github.com/jcode-works/jcode-ragmir/issues/158) — `await pdf.destroy()` removed in `unpdf@1.8.0` (every PDF errors) | wraps `pdf.destroy()` in `typeof === 'function'` guard |
| `apply-rgr-yaml-patch.sh`  | [#159](https://github.com/jcode-works/jcode-ragmir/issues/159) — `YAML.parse()` rejects multi-document YAML (frontmatter) | replace with `YAML.parseAllDocuments(...)` + `map` + `join("\n")` |

## `apply-rgr-pdf-patch.sh`

**Idempotent** patcher for the upstream bug at
[jcode-works/jcode-ragmir#158](https://github.com/jcode-works/jcode-ragmir/issues/158):

`packages/ragmir-core/src/parsing.ts:686` calls `await pdf.destroy()`
unconditionally, but `unpdf@1.8.0` removed `PDFDocumentProxy.destroy()`.
This breaks PDF ingestion end-to-end (exit 0 but `errors=1`, every PDF
emits `Parsing: pdf.destroy is not a function`).

This script:

- Locates the installed `rgr` binary (via `$RGR_BIN` env or `command -v rgr`).
- Resolves the symlink to the package install dir.
- Locates the corresponding `dist/parsing.js`.
- Skips if the guard marker is already present (idempotent).
- Otherwise, makes a one-time timestamped backup and applies a
  one-line `sed` patch that wraps `await pdf.destroy()` in a
  `if (typeof pdf.destroy === "function")` type guard.
- Verifies the patch via grep counts (must be exactly 1 guard line,
  0 unguarded hits).

### When to run

- **Once now**, to fix the currently-installed `rgr`.
- **After any** `npm i -g @jcode.labs/ragmir` / `pnpm rebuild` /
  global upgrade that touches the `rgr` install and may have
  overwritten the fix.

### Usage

```bash
scripts/apply-rgr-pdf-patch.sh                       # patch global rgr
RGR_BIN=/path/to/rgr scripts/apply-rgr-pdf-patch.sh # explicit binary
FORCE=1 scripts/apply-rgr-pdf-patch.sh              # re-apply even if patched
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Already patched, or patch applied cleanly and verified. |
| `1` | Patching failed — verification mismatch, raw line not found. Inspect the file manually. |
| `2` | `rgr` not found / `parsing.js` missing. Set `RGR_BIN` or install `rgr`. |

### Reverting

```bash
ls /usr/local/node22/lib/node_modules/@jcode.labs/ragmir/dist/parsing.js.bak.*  # pick the newest
cp parsing.js.bak.<timestamp> parsing.js
```

### When to delete this script

Once upstream ships a fix (either a `unpdf` pin to `~1.6.x` or a
defensive guard in `parsing.ts`), delete this script along with
restoring the original `dist/parsing.js`.

## `apply-rgr-yaml-patch.sh`

**Idempotent** patcher for the upstream bug at
[jcode-works/jcode-ragmir#159](https://github.com/jcode-works/jcode-ragmir/issues/159):

`packages/ragmir-core/src/parsing.ts` (compiled to `dist/parsing.js:86-88`)
handles `.yaml` / `.yml` files via `YAML.parse()`, which throws on any
file containing more than one YAML document — including the widely-used
Hugo / Jekyll / Eleventy / Hexo / Pelican frontmatter pattern.

This script:

- Locates the installed `rgr` binary (via `$RGR_BIN` env or `command -v rgr`).
- Resolves the symlink to the package install dir.
- Locates the corresponding `dist/parsing.js`.
- Skips if the fix marker (`YAML.parseAllDocuments(...)`) is already present (idempotent).
- Otherwise, makes a one-time timestamped backup and applies a `sed`
  patch that replaces the single `YAML.stringify(YAML.parse(...))`
  line with two lines that use `YAML.parseAllDocuments(...)` +
  `docs.map(d => YAML.stringify(d)).join("\n")`.
- Verifies the patch via grep counts (exactly 1 guard line, 0 raw hits).

### When to run

Same rules as the PDF patch:

- **Once now**, to fix the currently-installed `rgr`.
- **After any** `npm i -g @jcode.labs/ragmir` / `pnpm rebuild` /
  global upgrade that overwrites the fix.

### Usage

```bash
scripts/apply-rgr-yaml-patch.sh                       # patch global rgr
RGR_BIN=/path/to/rgr scripts/apply-rgr-yaml-patch.sh # explicit binary
```

### Exit codes

Same as the PDF patch:

| Code | Meaning |
|---|---|
| `0` | Already patched, or patch applied cleanly and verified. |
| `1` | Patching failed — raw line not found (upstream refactored the handler). |
| `2` | `rgr` not found / `parsing.js` missing. Set `RGR_BIN` or install `rgr`. |

### Reverting

```bash
ls /usr/local/node22/lib/node_modules/@jcode.labs/ragmir/dist/parsing.js.bak.*  # pick the newest
cp parsing.js.bak.<timestamp> parsing.js
```

### When to delete this script

Once upstream merges a fix (either `parseAllDocuments` in `parsing.ts`
or a Markdown-style frontmatter parser), delete this script along with
restoring the original `dist/parsing.js`.