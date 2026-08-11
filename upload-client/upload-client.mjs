#!/usr/bin/env node
// ragmir-upload-client — Local MCP stdio server for uploading files to Ragmir
// Uses official @modelcontextprotocol/sdk for protocol compatibility.
// Runs on user's machine (Windows/Mac/Linux). Install deps once: npm install

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { z } from 'zod';

// Resolve upload URL: ENV > config file > default
function resolveUploadUrl() {
  if (process.env.RAGMIR_UPLOAD_URL) {
    return { url: process.env.RAGMIR_UPLOAD_URL, source: 'env:RAGMIR_UPLOAD_URL' };
  }
  // Try config.json next to the script
  const configPath = join(dirname(new URL(import.meta.url).pathname), 'config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg.uploadUrl) return { url: cfg.uploadUrl, source: `config.json (${configPath})` };
    } catch {}
  }
  return { url: 'http://192.168.1.226:8002/upload', source: 'default' };
}

const { url: UPLOAD_URL, source: UPLOAD_URL_SOURCE } = resolveUploadUrl();

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
      // Build multipart/form-data manually (fetch+FormData uses undici with 50MB default limit)
      const boundary = '----RagmirUploadBoundary' + Math.random().toString(16).slice(2);
      const parts = [];
      const fields = [
        ['project', project],
        ['path', remotePath],
        ['autoIngest', 'true'],
      ];
      for (const [name, value] of fields) {
        parts.push(Buffer.from(`--${boundary}\r\n`));
        parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
        parts.push(Buffer.from(`${value}\r\n`));
      }
      parts.push(Buffer.from(`--${boundary}\r\n`));
      parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
      parts.push(Buffer.from(`Content-Type: application/octet-stream\r\n\r\n`));
      parts.push(fileBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(parts);

      // Use http.request directly — no undici body size limit
      const parsedUrl = new URL(UPLOAD_URL);
      const httpMod = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;
      const status = await new Promise((resolve2, reject) => {
        const req = httpMod({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        });
        let responseBody = '';
        let responseStatus = 0;
        req.on('response', (res) => {
          responseStatus = res.statusCode;
          res.setEncoding('utf8');
          res.on('data', (chunk) => { responseBody += chunk; });
          res.on('end', () => resolve2({ status: responseStatus, body: responseBody }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      log(`POST ${UPLOAD_URL} → status ${status.status}`);
      log(`Response body (${status.body.length} chars): ${status.body.slice(0, 500)}`);

      if (!status.body || status.body.trim().length === 0) {
        return {
          content: [{ type: 'text', text: `Upload error: server returned empty response (status ${status.status})` }],
          isError: true,
        };
      }

      let result;
      try {
        result = JSON.parse(status.body);
      } catch (parseErr) {
        return {
          content: [{ type: 'text', text: `Upload error: invalid JSON response (status ${status.status}, body: "${status.body.slice(0, 200)}")` }],
          isError: true,
        };
      }

      if (result.ok) {
        const baseTag = result.ingestSkipped
          ? ' (uploaded; autoIngest disabled)'
          : ' (uploaded and indexed)';
        const warning = result.ingestWarning ? ` — warning: ${result.ingestWarning}` : '';
        return {
          content: [{ type: 'text', text: `Uploaded ${fileName} (${result.bytes} bytes) to ${project}/${remotePath}${baseTag}${warning}` }],
        };
      }

      const lines = [];
      if (result.error) {
        lines.push(`Upload failed: ${result.error}`);
      } else if (result.ingestError) {
        lines.push(`Upload saved to disk but ingestion failed: ${result.ingestError}`);
      } else {
        lines.push(`Upload failed (no diagnostic from server): ${JSON.stringify(result).slice(0, 500)}`);
      }
      const stderrTail = (result.ingestStderr || '').trim();
      const stdoutTail = (result.ingestStdout || '').trim();
      if (stderrTail) lines.push(`rgr stderr: ${stderrTail.slice(-500)}`);
      if (stdoutTail && !stdoutTail.startsWith('Done.')) lines.push(`rgr stdout: ${stdoutTail.slice(0, 500)}`);
      if (result.ingestExitCode != null) lines.push(`rgr exit code: ${result.ingestExitCode}`);
      return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
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
log(`URL source: ${UPLOAD_URL_SOURCE}`);

// Diagnostic: try to reach the upload server at startup
(async () => {
  try {
    const baseUrl = UPLOAD_URL.replace(/\/upload$/, '');
    const parsedUrl = new URL(baseUrl);
    const httpMod = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest;
    const status = await new Promise((resolve2, reject) => {
      const req = httpMod({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
      });
      let body = '';
      req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve2({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
    log(`Diagnostic GET ${baseUrl} → ${status.status} "${status.body.slice(0, 100)}"`);
  } catch (e) {
    log(`Diagnostic GET failed: ${e.message}`);
    log(`Make sure the upload server is reachable at ${UPLOAD_URL}`);
  }
})();

const transport = new StdioServerTransport();
await server.connect(transport);