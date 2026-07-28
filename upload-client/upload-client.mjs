#!/usr/bin/env node
// ragmir-upload-client — Local MCP stdio server for uploading files to Ragmir
// Zero dependencies. Runs on user's machine (Windows/Mac/Linux).
// Reads local files and POSTs them to the Ragmir upload server via HTTP.

import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const UPLOAD_URL = process.env.RAGMIR_UPLOAD_URL || 'http://192.168.1.226:8002/upload';
const SERVER_INFO = { name: 'ragmir-upload', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-00';

// ─── Tool definitions ─────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'upload_to_ragmir',
    description:
      'Upload a local file to a Ragmir project on the remote server. ' +
      'Reads the file from your local disk and sends it to the Ragmir upload endpoint. ' +
      'Works with ANY file type: .docx, .pdf, .xlsx, images, code, text, etc. ' +
      'The file is automatically indexed after upload.',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project name on the Ragmir server (must already exist)',
        },
        path: {
          type: 'string',
          description:
            'Relative path within the project where the file will be stored, e.g. "docs/report.docx"',
        },
        localPath: {
          type: 'string',
          description:
            'Absolute path to the local file on this machine, e.g. "C:\\Users\\user\\Documents\\report.docx" or "/home/user/file.pdf"',
        },
      },
      required: ['project', 'path', 'localPath'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_local_files',
    description:
      'List files in a local directory (recursively). ' +
      'Useful for finding files to upload. Returns relative paths from the given directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the directory to list, e.g. "C:\\Users\\user\\Documents"',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional filter: only include files with these extensions, e.g. [".docx", ".pdf"]',
        },
      },
      required: ['directory'],
      additionalProperties: false,
    },
  },
];

// ─── Protocol helpers ─────────────────────────────────────────────────────

function send(obj) {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  process.stdout.write(header + body);
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function log(...args) {
  process.stderr.write(`[ragmir-upload] ${args.join(' ')}\n`);
}

// ─── Tool handlers ────────────────────────────────────────────────────────

async function handleUpload({ project, path: remotePath, localPath }) {
  // Validate
  if (!/^[a-zA-Z0-9._-]+$/.test(project)) {
    throw new Error(`Invalid project name: "${project}"`);
  }

  // Read local file
  const fileBuffer = readFileSync(localPath);
  const fileName = localPath.split(/[/\\]/).pop();
  log(`Uploading ${fileName} (${fileBuffer.length} bytes) to ${project}/${remotePath}`);

  // Build multipart/form-data using built-in FormData + Blob
  const form = new FormData();
  form.append('project', project);
  form.append('path', remotePath);
  form.append('file', new Blob([fileBuffer]), fileName);
  form.append('autoIngest', 'true');

  const res = await fetch(UPLOAD_URL, { method: 'POST', body: form });
  const result = await res.json();

  if (result.ok) {
    const ingested = result.ingested ? ' (indexed)' : ' (indexing pending)';
    return `Uploaded ${fileName} (${result.bytes} bytes) to ${project}/${remotePath}${ingested}`;
  } else {
    throw new Error(`Upload failed: ${result.error || JSON.stringify(result)}`);
  }
}

function handleListLocalFiles({ directory, extensions }) {
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
        // Return path relative to the input directory
        files.push(full.slice(dir.length + 1) || entry.name);
      }
    }
  }

  walk(dir);
  return `Found ${files.length} files in ${directory}:\n${files.join('\n')}`;
}

// ─── Message handler ──────────────────────────────────────────────────────

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    log('Client connected:', JSON.stringify(params?.clientInfo));
    return;
  }

  if (method === 'notifications/initialized') {
    log('Client initialized');
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    try {
      let text;
      if (toolName === 'upload_to_ragmir') {
        text = await handleUpload(args);
      } else if (toolName === 'list_local_files') {
        text = handleListLocalFiles(args);
      } else {
        sendError(id, -32601, `Unknown tool: ${toolName}`);
        return;
      }
      sendResponse(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      log(`Error in ${toolName}:`, e.message);
      sendResponse(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Stdin reader (Content-Length framing) ────────────────────────────────

let inputBuffer = Buffer.alloc(0);

function processBuffer() {
  while (true) {
    // Look for header separator
    const sepIdx = indexOfBuffer(inputBuffer, Buffer.from('\r\n\r\n'));
    if (sepIdx === -1) break;

    const header = inputBuffer.slice(0, sepIdx).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      log('Bad header, dropping:', header);
      inputBuffer = inputBuffer.slice(sepIdx + 4);
      continue;
    }

    const contentLen = parseInt(match[1], 10);
    const bodyStart = sepIdx + 4;
    if (inputBuffer.length < bodyStart + contentLen) break; // incomplete body

    const body = inputBuffer.slice(bodyStart, bodyStart + contentLen).toString('utf8');
    inputBuffer = inputBuffer.slice(bodyStart + contentLen);

    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch(e => {
        log('Handler error:', e.message);
      });
    } catch (e) {
      log('JSON parse error:', e.message);
    }
  }
}

function indexOfBuffer(buf, search) {
  for (let i = 0; i <= buf.length - search.length; i++) {
    if (buf.slice(i, i + search.length).equals(search)) return i;
  }
  return -1;
}

process.stdin.on('data', chunk => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processBuffer();
});

process.stdin.on('end', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

log(`Started. Upload URL: ${UPLOAD_URL}`);
