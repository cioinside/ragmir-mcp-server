#!/usr/bin/env node
// ragmir-upload-client — Local MCP stdio server for uploading files to Ragmir
// Uses official @modelcontextprotocol/sdk for protocol compatibility.
// Runs on user's machine (Windows/Mac/Linux). Install deps once: npm install

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { z } from 'zod';

const UPLOAD_URL = process.env.RAGMIR_UPLOAD_URL || 'http://192.168.1.226:8002/upload';

function log(...args) {
  process.stderr.write(`[ragmir-upload] ${args.join(' ')}\n`);
}

const server = new McpServer({
  name: 'ragmir-upload',
  version: '1.0.0',
});

// ─── Tool: upload_to_ragmir ────────────────────────────────────────────────

server.registerTool(
  'upload_to_ragmir',
  {
    description:
      'Upload a local file to a Ragmir project on the remote server. ' +
      'Reads the file from your local disk and sends it to the Ragmir upload endpoint. ' +
      'Works with ANY file type: .docx, .pdf, .xlsx, images, code, text, etc. ' +
      'The file is automatically indexed after upload.',
    inputSchema: {
      project: z.string().describe('Project name on the Ragmir server (must already exist)'),
      path: z.string().describe('Relative path within the project where the file will be stored, e.g. "docs/report.docx"'),
      localPath: z.string().describe('Absolute path to the local file on this machine, e.g. "C:\\Users\\user\\Documents\\report.docx" or "/home/user/file.pdf"'),
    },
  },
  async ({ project, path: remotePath, localPath }) => {
    if (!/^[a-zA-Z0-9._-]+$/.test(project)) {
      return { content: [{ type: 'text', text: `Error: Invalid project name: "${project}"` }], isError: true };
    }

    let fileBuffer;
    try {
      fileBuffer = readFileSync(localPath);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading local file: ${e.message}` }], isError: true };
    }

    const fileName = basename(localPath);
    log(`Uploading ${fileName} (${fileBuffer.length} bytes) to ${project}/${remotePath}`);

    try {
      const form = new FormData();
      form.append('project', project);
      form.append('path', remotePath);
      form.append('file', new Blob([fileBuffer]), fileName);
      form.append('autoIngest', 'true');

      const res = await fetch(UPLOAD_URL, { method: 'POST', body: form });
      log(`POST ${UPLOAD_URL} → status ${res.status}`);
      log(`Response content-type: ${res.headers.get('content-type')}`);

      const responseText = await res.text();
      log(`Response body (${responseText.length} chars): ${responseText.slice(0, 500)}`);

      if (!responseText || responseText.trim().length === 0) {
        return {
          content: [{ type: 'text', text: `Upload error: server returned empty response (status ${res.status})` }],
          isError: true,
        };
      }

      let result;
      try {
        result = JSON.parse(responseText);
      } catch (parseErr) {
        return {
          content: [{ type: 'text', text: `Upload error: invalid JSON response (status ${res.status}, body: "${responseText.slice(0, 200)}")` }],
          isError: true,
        };
      }

      if (result.ok) {
        const ingested = result.ingested ? ' (indexed)' : ' (indexing pending)';
        return {
          content: [{ type: 'text', text: `Uploaded ${fileName} (${result.bytes} bytes) to ${project}/${remotePath}${ingested}` }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `Upload failed: ${result.error || JSON.stringify(result)}` }],
          isError: true,
        };
      }
    } catch (e) {
      return { content: [{ type: 'text', text: `Upload error: ${e.message}` }], isError: true };
    }
  }
);

// ─── Tool: list_local_files ───────────────────────────────────────────────

server.registerTool(
  'list_local_files',
  {
    description:
      'List files in a local directory (recursively). ' +
      'Useful for finding files to upload. Returns relative paths from the given directory.',
    inputSchema: {
      directory: z.string().describe('Absolute path to the directory to list, e.g. "C:\\Users\\user\\Documents"'),
      extensions: z.array(z.string()).optional().describe('Optional filter: only include files with these extensions, e.g. [".docx", ".pdf"]'),
    },
  },
  async ({ directory, extensions }) => {
    const dir = resolve(directory);
    const files = [];

    function walk(current) {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (e) {
        throw new Error(`Cannot read directory: ${current} — ${e.message}`);
      }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (extensions && extensions.length > 0) {
            const ext = '.' + entry.name.split('.').pop().toLowerCase();
            if (!extensions.some(e => e.toLowerCase() === ext)) continue;
          }
          files.push(full.slice(dir.length + 1) || entry.name);
        }
      }
    }

    try {
      walk(dir);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: `Found ${files.length} files in ${directory}:\n${files.join('\n')}` }],
    };
  }
);

// ─── Start server ──────────────────────────────────────────────────────────

log(`Started. Upload URL: ${UPLOAD_URL}`);
log(`RAGMIR env: ${process.env.RAGMIR_UPLOAD_URL ? 'set' : 'NOT SET (using default)'}`);

// Diagnostic: try to reach the upload server at startup
(async () => {
  try {
    const baseUrl = UPLOAD_URL.replace(/\/upload$/, '');
    const res = await fetch(baseUrl, { method: 'GET' });
    const text = await res.text();
    log(`Diagnostic GET ${baseUrl} → ${res.status} "${text.slice(0, 100)}"`);
  } catch (e) {
    log(`Diagnostic GET failed: ${e.message}`);
    log(`Make sure the upload server is reachable at ${UPLOAD_URL}`);
  }
})();

const transport = new StdioServerTransport();
await server.connect(transport);