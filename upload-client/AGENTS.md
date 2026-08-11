# ragmir-upload-client

Local MCP stdio client for uploading files to Ragmir server. Runs on user machine (Win/Mac/Linux). Uses official `@modelcontextprotocol/sdk` + `zod`.

Separate deployable from the root `server.js` — do not merge.

## Files

- `upload-client.mjs` — the server. 243 lines. 2 tools.
- `package.json` — deps: `@hono/node-server`, `@modelcontextprotocol/sdk`, `express`, `zod`.
- `test_fallback.mjs` — untracked test script.

## Tools

- **`upload_to_ragmir`** — multipart POST to `${UPLOAD_URL}/upload`. Manual multipart construction (NOT `fetch`/FormData — undici 50MB body limit). Validates project name with `/^[a-zA-Z0-9._-]+$/`.
- **`list_local_files`** — recursive directory walk with optional extension filter.

## `upload_to_ragmir` response shape

The remote `/upload` endpoint returns JSON. The tool translates it into an
MCP tool result with `isError` set when anything went wrong. Server-side
classification happens in `../upload-server.js:runRgrIngest` +
`classifyRgrOutcome`; the fields below are guaranteed to be present on
every 200 OK:

| Field | Type | Meaning |
|---|---|---|
| `ok` | `boolean` | File on disk **and** at least one source indexed with zero errors. |
| `error` | `string \| undefined` | Top-level error (project not found, missing multipart field, etc.). When set, `ok:false`. |
| `ingestError` | `string \| undefined` | Why `rgr ingest` did not produce the expected outcome (non-zero exit, indexedFiles=0, errors>0). |
| `ingestWarning` | `string \| undefined` | Partial-success signal: some files indexed but `emptyTextFiles>0`. |
| `ingested` | `boolean` | True iff rgr reports `indexedFiles>0 && errors==0` for this run. |
| `ingestSkipped` | `boolean` | True iff the caller passed `autoIngest=false`. |
| `ingestExitCode` | `number` | `rgr ingest` exit status. `0` even on silent failures. |
| `ingestStdout` | `string` | Full rgr stdout (includes `Done. ...` summary line). |
| `ingestStderr` | `string` | Full rgr stderr (usually empty; rgr writes diagnostics to stdout). |
| `bytes` | `number` | Bytes written to disk. |
| `path`, `project` | `string` | Echoed back from the request. |

Decision matrix (see `classifyRgrOutcome` in `../upload-server.js`):

| rgr summary | `ok` | `ingested` | `ingestError` | `ingestWarning` |
|---|---|---|---|---|
| exit code != 0 | `false` | `false` | "rgr ingest exited with code N: ..." | — |
| summary unparseable | `false` | `false` | "Could not parse rgr ingest summary..." | — |
| `errors > 0` | `false` | indexedFiles>0 | "rgr ingest reported N file error(s)..." | — |
| `indexedFiles == 0 && emptyTextFiles > 0` | `false` | `false` | "N file(s) produced no indexable text..." | — |
| `indexedFiles == 0 && emptyTextFiles == 0` | `false` | `false` | "rgr ingest produced no indexed chunks." | — |
| `indexedFiles > 0 && emptyTextFiles > 0` | `true` | `true` | — | "N file(s) produced no indexable text and were skipped..." |
| `indexedFiles > 0 && emptyTextFiles == 0` | `true` | `true` | — | — |

Client-side rendering rules (see `upload-client.mjs`):

- `ok && ingested && !warning` → `"Uploaded <file> (<bytes>) to <project>/<path> (uploaded and indexed)"`
- `ok && warning`            → same, suffixed with ` — warning: <ingestWarning>`
- `ingestSkipped`            → tag becomes ` (uploaded; autoIngest disabled)`
- `!ok && ingestError`       → `"Upload saved to disk but ingestion failed: <ingestError>"` + truncated `rgr stderr`/`rgr stdout` + `rgr exit code: N`; `isError: true`
- `!ok && error`             → `"Upload failed: <error>"`; `isError: true`

## Config resolution (priority order)

1. `RAGMIR_UPLOAD_URL` env var.
2. `config.json` next to script: `{ "uploadUrl": "..." }`.
3. Default: `http://192.168.1.226:8002/upload`.

`resolveUploadUrl()` returns `{ url, source }`; `source` is logged at startup for debugging.

## Conventions

- **Manual multipart** (`upload-client.mjs:75-92`): builds body via `Buffer.concat` with `------RagmirUploadBoundary<rand>` + `Content-Disposition` parts. Reason: avoids undici's 50MB default body limit.
- **Direct `node:http`/`node:https`**, not `fetch`. Same reason.
- **Startup diagnostic**: pings `${UPLOAD_URL}` base path via GET, logs status. Non-fatal — server still starts if unreachable.

## Anti-patterns

- **`fetch` + `FormData` for uploads**: hits undici 50MB limit on large files. Use the manual multipart path.
- **Weakening project-name regex** `/^[a-zA-Z0-9._-]+$/`: paths and names are passed to a shell-side `rgr`. Treat as security boundary.
- **No fallback to fetch on `http.request` error**: if `http.request` fails (DNS, connection refused), the tool returns `isError: true` with the error message. Don't add silent retries — caller decides.

## Run

```
npm install
node upload-client.mjs
```

Pair with root `../upload-server.js` running on the Ragmir host at `:8002`.