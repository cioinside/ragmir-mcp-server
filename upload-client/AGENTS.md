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