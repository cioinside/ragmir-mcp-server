#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.UPLOAD_PORT || '8002', 10);
const PROJECTS_DIR = process.env.RAGMIR_PROJECTS_DIR || '/opt/ragmir-projects';
const RGR = '/usr/local/node22/bin/rgr';

function parseMultipart(buffer, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let pos = 0;

  while (pos < buffer.length) {
    const start = bufferIndexOf(buffer, sep, pos);
    if (start === -1) break;

    const afterSep = start + sep.length;
    if (buffer[afterSep] === 0x2d && buffer[afterSep + 1] === 0x2d) break; // --boundary-- end marker

    const headerStart = afterSep + 2; // skip \r\n after boundary
    const headerEnd = bufferIndexOf(buffer, Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;

    const headerStr = buffer.slice(headerStart, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    // Find next boundary
    const nextBoundary = bufferIndexOf(buffer, sep, bodyStart);
    const bodyEnd = nextBoundary !== -1 ? nextBoundary - 2 : buffer.length; // strip \r\n before boundary

    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: contentTypeMatch ? contentTypeMatch[1].trim() : null,
      data: buffer.slice(bodyStart, bodyEnd),
    });

    pos = nextBoundary !== -1 ? nextBoundary : buffer.length;
  }

  return parts;
}

function bufferIndexOf(buf, search, from) {
  for (let i = from; i <= buf.length - search.length; i++) {
    if (buf.slice(i, i + search.length).equals(search)) return i;
  }
  return -1;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    return res.end('Ragmir Upload Server OK');
  }

  if (req.method === 'POST' && req.url === '/upload') {
    const ct = req.headers['content-type'] || '';
    const bMatch = ct.match(/boundary=(.+)/);
    if (!bMatch) return sendJson(res, 400, { error: 'Expected multipart/form-data' });

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const parts = parseMultipart(buffer, bMatch[1].trim());

      const pPart = parts.find(p => p.name === 'project');
      const fPart = parts.find(p => p.name === 'path');
      const filePart = parts.find(p => p.name === 'file');
      const autoPart = parts.find(p => p.name === 'autoIngest');

      if (!pPart || !fPart || !filePart) {
        return sendJson(res, 400, { error: 'Required: project, path, file', got: parts.map(p => p.name) });
      }

      const project = pPart.data.toString('utf8').trim();
      const filePath = fPart.data.toString('utf8').trim();

      if (!/^[a-zA-Z0-9._-]+$/.test(project)) {
        return sendJson(res, 400, { error: `Invalid project name: ${project}` });
      }

      const projectDir = path.join(PROJECTS_DIR, project);
      if (!fs.existsSync(projectDir)) {
        return sendJson(res, 404, { error: `Project "${project}" not found` });
      }

      const fullPath = path.join(projectDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, filePart.data);

      const result = { ok: true, project, path: filePath, bytes: filePart.data.length };

      const doIngest = autoPart ? autoPart.data.toString('utf8').trim() !== 'false' : true;
      if (doIngest) {
        try {
          execSync(`${RGR} ingest --project-root "${projectDir}"`, {
            encoding: 'utf8', timeout: 300000,
            env: { ...process.env, PATH: `/usr/local/node22/bin:${process.env.PATH}` },
          });
          result.ingested = true;
        } catch (e) {
          result.ingested = false;
          result.ingestError = e.stderr || e.message;
        }
      }

      sendJson(res, 200, result);
    });
    return;
  }

  sendJson(res, 404, { error: 'Use POST /upload' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ragmir upload server on port ${PORT}, projects: ${PROJECTS_DIR}`);
});
