#!/usr/bin/env node
// ragmir-mcp-server.js — Universal Ragmir MCP Server
// Supports: project management, file upload, ingest, search/ask/research
// Runs over stdio (for mcpo) or standalone

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const RGR = '/usr/local/node22/bin/rgr';
const PROJECTS_DIR = process.env.RAGMIR_PROJECTS_DIR || '/opt/ragmir-projects';

// ─── MCP Protocol Helpers ────────────────────────────────────────────────

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
}

// ─── Tool Definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ragmir_create_project',
    title: 'Create Project',
    description: 'Create a new Ragmir project. Creates a directory and initializes .ragmir config. Does NOT ingest files — after creating, upload files with ragmir_write_file/ragmir_write_files_batch, then add sources with ragmir_add_sources, then run ragmir_ingest.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name (used as endpoint slug)' },
        description: { type: 'string', maxLength: 500, description: 'Optional project description' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_delete_project',
    title: 'Delete Project',
    description: 'Delete a Ragmir project and all its data (index, files, config).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name to delete' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_list_projects',
    title: 'List Projects',
    description: 'List all Ragmir projects on this server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_write_file',
    title: 'Write File',
    description: 'Write a file to a project directory. Creates parent dirs automatically. Overwrites existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path within the project (e.g. "docs/README.md")' },
        content: { type: 'string', description: 'File content (text)' },
      },
      required: ['project', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_write_files_batch',
    title: 'Write Files (Batch)',
    description: 'Write multiple files to a project at once. Efficient for bulk uploads.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1 },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
          description: 'Array of {path, content} objects',
        },
      },
      required: ['project', 'files'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_list_files',
    title: 'List Files',
    description: 'List files in a project directory (excluding .ragmir internals).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        subdirectory: { type: 'string', description: 'Optional subdirectory to list (e.g. "src/")' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_read_file',
    title: 'Read File',
    description: 'Read a file from a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path' },
      },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_delete_file',
    title: 'Delete File',
    description: 'Delete a file from a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path' },
      },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_add_sources',
    title: 'Add Sources',
    description: 'Add source glob patterns to a project. These patterns determine which files get indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        patterns: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          description: 'Glob patterns (e.g. ["docs/**/*.md", "src/**/*.ts"])',
        },
      },
      required: ['project', 'patterns'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_ingest',
    title: 'Ingest Project',
    description: 'Run ingestion on a project: parse files, chunk, embed, and update the vector index. Run this after adding or changing files.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_project_status',
    title: 'Project Status',
    description: 'Get detailed status of a project: indexed files, chunks, config, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_search',
    title: 'Search',
    description: 'Search project corpus with citations. Returns the most relevant passages.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Search query' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max results (default 5)' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ragmir_ask',
    title: 'Ask',
    description: 'Get cited context for a question (without LLM). Returns relevant passages.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Question' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max results' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ragmir_research',
    title: 'Research',
    description: 'Run multi-query research with cited evidence across the project corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Research query' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max results' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function getProjectPath(name) {
  // Sanitize: only allow alphanumeric, dash, underscore, dot
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid project name: ${name}. Use only letters, numbers, dash, underscore, dot.`);
  }
  return path.join(PROJECTS_DIR, name);
}

function rgr(args, projectRoot, timeoutMs = 120000) {
  const cmd = `${RGR} --project-root "${projectRoot}" ${args}`;
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, PATH: `/usr/local/node22/bin:${process.env.PATH}` },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    // Return stdout even on error (rgr sometimes writes to stdout before failing)
    return (e.stdout || '') + '\n' + (e.stderr || e.message);
  }
}

function walkDir(dir, prefix = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === '.ragmir' || entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(path.join(dir, entry.name), rel));
    } else {
      const stat = fs.statSync(path.join(dir, entry.name));
      results.push({ path: rel, size: stat.size });
    }
  }
  return results;
}

// ─── Tool Handlers ───────────────────────────────────────────────────────

const handlers = {
  ragmir_create_project({ name, description }) {
    const projectPath = getProjectPath(name);
    if (fs.existsSync(projectPath)) {
      throw new Error(`Project "${name}" already exists at ${projectPath}`);
    }

    // Create directory and initialize
    fs.mkdirSync(projectPath, { recursive: true });
    const initOut = rgr('init', projectPath);

    // Add a README if description provided
    if (description) {
      fs.writeFileSync(
        path.join(projectPath, 'README.md'),
        `# ${name}\n\n${description}\n`
      );
    }

    return {
      content: [{
        type: 'text',
        text: `Project "${name}" created at ${projectPath}\n\n${initOut}\n\nNext steps:\n1. Upload files with ragmir_write_file or ragmir_write_files_batch\n2. Add source patterns with ragmir_add_sources\n3. Run ragmir_ingest to build the index`,
      }],
    };
  },

  ragmir_delete_project({ name }) {
    const projectPath = getProjectPath(name);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project "${name}" not found`);
    }
    fs.rmSync(projectPath, { recursive: true, force: true });
    return {
      content: [{ type: 'text', text: `Project "${name}" deleted (${projectPath})` }],
    };
  },

  ragmir_list_projects() {
    if (!fs.existsSync(PROJECTS_DIR)) {
      return { content: [{ type: 'text', text: 'No projects directory. Create one with ragmir_create_project.' }] };
    }
    const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const p = path.join(PROJECTS_DIR, e.name);
        const hasRagmir = fs.existsSync(path.join(p, '.ragmir'));
        const files = walkDir(p);
        return {
          name: e.name,
          path: p,
          initialized: hasRagmir,
          fileCount: files.length,
        };
      });

    if (projects.length === 0) {
      return { content: [{ type: 'text', text: 'No projects yet. Create one with ragmir_create_project.' }] };
    }

    const lines = projects.map(p =>
      `• ${p.name}\n  Path: ${p.path}\n  Initialized: ${p.initialized ? 'yes' : 'NO'}\n  Files: ${p.fileCount}`
    );
    return { content: [{ type: 'text', text: `Projects (${projects.length}):\n\n${lines.join('\n\n')}` }] };
  },

  ragmir_write_file({ project, path: filePath, content }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const fullPath = path.join(projectPath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');

    return {
      content: [{ type: 'text', text: `Wrote ${content.length} bytes to ${filePath} in project "${project}"` }],
    };
  },

  ragmir_write_files_batch({ project, files }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    let totalBytes = 0;
    let count = 0;
    for (const file of files) {
      const fullPath = path.join(projectPath, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf8');
      totalBytes += file.content.length;
      count++;
    }

    return {
      content: [{ type: 'text', text: `Wrote ${count} files (${totalBytes} bytes) to project "${project}"` }],
    };
  },

  ragmir_list_files({ project, subdirectory }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const dir = subdirectory ? path.join(projectPath, subdirectory) : projectPath;
    const files = walkDir(dir);

    if (files.length === 0) {
      return { content: [{ type: 'text', text: `No files in project "${project}"${subdirectory ? '/' + subdirectory : ''}` }] };
    }

    const lines = files.map(f => `${f.path} (${f.size} bytes)`);
    return { content: [{ type: 'text', text: `Files (${files.length}):\n${lines.join('\n')}` }] };
  },

  ragmir_read_file({ project, path: filePath }) {
    const projectPath = getProjectPath(project);
    const fullPath = path.join(projectPath, filePath);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    const content = fs.readFileSync(fullPath, 'utf8');
    return { content: [{ type: 'text', text: content }] };
  },

  ragmir_delete_file({ project, path: filePath }) {
    const projectPath = getProjectPath(project);
    const fullPath = path.join(projectPath, filePath);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    fs.unlinkSync(fullPath);
    return { content: [{ type: 'text', text: `Deleted ${filePath} from project "${project}"` }] };
  },

  ragmir_add_sources({ project, patterns }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(path.join(projectPath, '.ragmir'))) {
      throw new Error(`Project "${project}" not initialized. Run ragmir_create_project first.`);
    }

    const out = rgr(`sources add ${patterns.map(p => `"${p}"`).join(' ')}`, projectPath);
    return { content: [{ type: 'text', text: `Added ${patterns.length} source patterns to "${project}":\n\n${out}` }] };
  },

  ragmir_ingest({ project }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(path.join(projectPath, '.ragmir'))) {
      throw new Error(`Project "${project}" not initialized.`);
    }

    const out = rgr('ingest', projectPath, 300000); // 5 min timeout for large projects
    return { content: [{ type: 'text', text: `Ingestion complete for "${project}":\n\n${out}` }] };
  },

  ragmir_project_status({ project }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const out = rgr('status', projectPath);
    return { content: [{ type: 'text', text: out }] };
  },

  ragmir_search({ project, query, topK }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(path.join(projectPath, '.ragmir'))) {
      throw new Error(`Project "${project}" not initialized.`);
    }

    const kArg = topK ? `--top-k ${topK}` : '';
    const out = rgr(`search "${query.replace(/"/g, '\\"')}" ${kArg}`, projectPath);
    return { content: [{ type: 'text', text: out || 'No results found.' }] };
  },

  ragmir_ask({ project, query, topK }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(path.join(projectPath, '.ragmir'))) {
      throw new Error(`Project "${project}" not initialized.`);
    }

    const kArg = topK ? `--top-k ${topK}` : '';
    const out = rgr(`ask "${query.replace(/"/g, '\\"')}" ${kArg}`, projectPath);
    return { content: [{ type: 'text', text: out || 'No results found.' }] };
  },

  ragmir_research({ project, query, topK }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(path.join(projectPath, '.ragmir'))) {
      throw new Error(`Project "${project}" not initialized.`);
    }

    const kArg = topK ? `--top-k ${topK}` : '';
    const out = rgr(`research "${query.replace(/"/g, '\\"')}" ${kArg}`, projectPath, 120000);
    return { content: [{ type: 'text', text: out || 'No results found.' }] };
  },
};

// ─── JSON-RPC Handler ────────────────────────────────────────────────────

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { resources: { listChanged: true }, tools: { listChanged: true } },
      serverInfo: { name: 'ragmir-universal', version: '1.0.0' },
      instructions: [
      'Ragmir Universal MCP Server — local RAG knowledge base.',
      '',
      'WORKFLOW (follow this sequence):',
      '1. ragmir_create_project — create a named project',
      '2. ragmir_write_file or ragmir_write_files_batch — upload source files into the project',
      '3. ragmir_add_sources — tell Ragmir which files to index (glob patterns like "**/*.py")',
      '4. ragmir_ingest — build the vector index (run after writing files and adding sources)',
      '5. ragmir_search / ragmir_ask / ragmir_research — query the indexed knowledge base',
      '',
      'Use these tools DIRECTLY — do NOT write shell scripts or curl commands.',
      'Each tool is an MCP function call. Call it with the required arguments.',
      '',
      'Example flow for indexing a codebase:',
      '  → ragmir_create_project(name="my-api")',
      '  → ragmir_write_files_batch(project="my-api", files=[{path:"src/main.py", content:"..."}])',
      '  → ragmir_add_sources(project="my-api", patterns=["src/**/*.py", "docs/**/*.md"])',
      '  → ragmir_ingest(project="my-api")',
      '  → ragmir_search(project="my-api", query="How does auth work?")',
    ].join('\n'),
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};

    if (!handlers[toolName]) {
      sendError(id, -32601, `Unknown tool: ${toolName}`);
      return;
    }

    try {
      const result = handlers[toolName](args);
      sendResponse(id, result);
    } catch (e) {
      sendResponse(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'ping') {
    sendResponse(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

// ─── Main ────────────────────────────────────────────────────────────────

// Ensure projects directory exists
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Read from stdin line by line
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const req = JSON.parse(trimmed);
    handleRequest(req);
  } catch (e) {
    // Ignore non-JSON lines (noise from mcpo transport)
  }
});

rl.on('close', () => process.exit(0));

// Log to stderr (doesn't interfere with MCP stdio)
process.stderr.write(`ragmir-universal MCP server started (projects: ${PROJECTS_DIR})\n`);
