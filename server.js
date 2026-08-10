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

function notifyToolsChanged() {
  sendNotification('notifications/tools/list_changed', {});
}

function registerTool(definition, handler) {
  if (!definition || typeof definition.name !== 'string') {
    throw new Error('registerTool: definition.name is required');
  }
  if (typeof handler !== 'function') {
    throw new Error('registerTool: handler must be a function');
  }
  const idx = TOOLS.findIndex(t => t.name === definition.name);
  if (idx >= 0) {
    TOOLS[idx] = definition;
  } else {
    TOOLS.push(definition);
  }
  handlers[definition.name] = handler;
  notifyToolsChanged();
  process.stderr.write(`[ragmir] registered tool "${definition.name}" (total: ${TOOLS.length})\n`);
  return TOOLS.length;
}

function unregisterTool(name) {
  const idx = TOOLS.findIndex(t => t.name === name);
  if (idx === -1) return false;
  TOOLS.splice(idx, 1);
  delete handlers[name];
  notifyToolsChanged();
  process.stderr.write(`[ragmir] unregistered tool "${name}" (total: ${TOOLS.length})\n`);
  return true;
}

// ─── Tool Definitions ────────────────────────────────────────────────────

let TOOLS = [
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
    description:
      'Lists all available Ragmir projects. ' +
      'CALL THIS FIRST when the user mentions a project by name or topic and you are unsure which project contains their data, ' +
      'or when you need to find which project to search.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_write_file',
    title: 'Write File',
    description: 'Write a file to a project. For text files use "content", for binary files (.docx, .pdf, .xlsx, .pptx, images) base64-encode the file and use "contentBase64". Auto-ingests by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path (e.g. "docs/report.docx")' },
        content: { type: 'string', description: 'Text content for text files' },
        contentBase64: { type: 'string', minLength: 1, description: 'Base64-encoded content for binary files (docx, pdf, xlsx, images)' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after write (default: true)' },
      },
      required: ['project', 'path'],
      oneOf: [
        { required: ['content'] },
        { required: ['contentBase64'] },
      ],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_write_files_batch',
    title: 'Write Files (Batch)',
    description: 'Write multiple files at once. Each file: use "content" for text, "contentBase64" for binary (.docx, .pdf, .xlsx, images). Auto-ingests by default.',
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
              content: { type: 'string', description: 'Text content' },
              contentBase64: { type: 'string', minLength: 1, description: 'Base64-encoded binary content' },
            },
            required: ['path'],
          },
          description: 'Array of files — each needs content OR contentBase64',
        },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after write (default: true)' },
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
    description: 'Delete a file from a project. Auto-ingests by default (removes orphaned chunks from the vector index). Set autoIngest=false to skip ingestion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after delete (default: true). Set false to skip.' },
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
    description:
      'ALWAYS use this when the user asks about content previously uploaded to a Ragmir project. ' +
      'Use it for ANY factual question about documents, code, notes, manuals, PDFs, etc. that have been indexed. ' +
      'Returns the most relevant passages with source citations.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Natural language search query describing what you want to find' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max results to return (default 5, increase for broader searches)' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ragmir_ask',
    title: 'Ask',
    description:
      'Ask a question against a Ragmir project and get an LLM-synthesized answer with cited sources. ' +
      'USE THIS for complex questions that require reasoning over multiple passages, summarizing, or comparing information ' +
      'from the project. Use ragmir_search instead if you just need raw relevant passages.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'The question to answer' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max sources to use (default 5)' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ragmir_research',
    title: 'Research',
    description:
      'Deep multi-query research across the entire project corpus. ' +
      'USE THIS when the user wants an in-depth investigation, comprehensive report, or comparison ' +
      'across many documents. Slower but more thorough than ragmir_ask.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Research question or topic to investigate' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max sources (default 5)' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'ragmir_search_all',
    title: 'Search All Projects',
    description:
      'Universal search across all Ragmir projects. ' +
      'CALL THIS FIRST when starting any task — it queries every project\'s index in one shot, ' +
      'returns passages ranked by relevance, and tags each hit with its source project. ' +
      'Use this INSTEAD OF ragmir_search when you are not sure which project contains the relevant data, ' +
      'when a question may have answers in multiple projects, or when you want to check whether prior ' +
      'work already exists before creating a new project. ' +
      'Pass projects=[...] to restrict the search to a specific subset. ' +
      'Lower distance = better match (ANNOY/Euclidean). Hits with distance=null go to the end.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 20000, description: 'Natural language search query' },
        topK: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Max results per project (default 3)' },
        projects: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 100 },
          description: 'Optional list of project names to search (default: all initialized projects)',
        },
        totalLimit: { type: 'integer', exclusiveMinimum: 1, maximum: 100, description: 'Max total results after merging across projects (default 10)' },
        offset: { type: 'integer', exclusiveMinimum: 0, maximum: 100, description: 'Number of leading hits to skip for pagination (default 0)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },

  // ─── Knowledge accumulation tools ──────────────────────────────────────

  {
    name: 'ragmir_append_file',
    title: 'Append File',
    description: 'Append text content to an existing file. Useful for adding new findings to an existing knowledge record. Auto-backs up and auto-ingests by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path' },
        content: { type: 'string', description: 'Text to append' },
        separator: { type: 'string', description: 'Separator before appended content (default: newline + --- + appended timestamp marker)' },
        autoBackup: { type: 'boolean', description: 'Auto-backup before appending (default: true)' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after append (default: true)' },
      },
      required: ['project', 'path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_edit_file',
    title: 'Edit File',
    description: 'Find/replace within a file. Useful for updating a specific field in a knowledge record. Auto-backs up and auto-ingests by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'Relative file path' },
        find: { type: 'string', description: 'Literal string to find' },
        replace: { type: 'string', description: 'Replacement text' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences (default: false)' },
        autoBackup: { type: 'boolean', description: 'Auto-backup before editing (default: true)' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after edit (default: true)' },
      },
      required: ['project', 'path', 'find', 'replace'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_supersede_note',
    title: 'Supersede Note',
    description: 'Mark an old knowledge record as superseded and create a new one that references it. Preserves history. Auto-backs up and auto-ingests by default.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        oldPath: { type: 'string', minLength: 1, description: 'Path to existing record to supersede' },
        newPath: { type: 'string', minLength: 1, description: 'Path for the new record' },
        newContent: { type: 'string', description: 'Content of the new record' },
        reason: { type: 'string', description: 'Short explanation (e.g. "found better method via X")' },
        autoBackup: { type: 'boolean', description: 'Auto-backup before superseding (default: true)' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after superseding (default: true)' },
      },
      required: ['project', 'oldPath', 'newPath', 'newContent'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_list_history',
    title: 'List History',
    description: 'List all backup versions of a file from .ragmir-history/.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'File whose history to list' },
      },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_diff_versions',
    title: 'Diff Versions',
    description: 'Show diff between two versions of a file (or current vs backup).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'File path' },
        versionA: { type: 'string', description: 'First version ("current" or backup filename). Default: most recent backup.' },
        versionB: { type: 'string', description: 'Second version ("current" or backup filename). Default: "current".' },
      },
      required: ['project', 'path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_restore_version',
    title: 'Restore Version',
    description: 'Restore a file from a specific backup. Auto-backs up current version before overwriting.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        path: { type: 'string', minLength: 1, description: 'File path to restore' },
        version: { type: 'string', minLength: 1, description: 'Backup filename to restore from' },
        autoBackup: { type: 'boolean', description: 'Backup current version before overwriting (default: true)' },
        autoIngest: { type: 'boolean', description: 'Auto-run ingestion after restore (default: true)' },
      },
      required: ['project', 'path', 'version'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ragmir_health_check',
    title: 'Health Check',
    description: 'Quick health summary of a project index vs source files. Fast (status) or deep (full audit).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', minLength: 1, maxLength: 100, description: 'Project name' },
        deep: { type: 'boolean', description: 'Run full audit (slower, O(corpus)) (default: false)' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'ragmir_admin_reload_tools',
    title: 'Reload Tools (admin)',
    description: 'Force connected MCP clients to re-fetch the tools list by emitting notifications/tools/list_changed. Use after server-side tool mutations, or to recover from a desynced client cache. Returns the currently registered tool names.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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

let handlers = {
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

  ragmir_write_file({ project, path: filePath, content, contentBase64, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const fullPath = path.join(projectPath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });

    let bytesWritten;
    if (contentBase64) {
      const buffer = Buffer.from(contentBase64, 'base64');
      fs.writeFileSync(fullPath, buffer);
      bytesWritten = buffer.length;
    } else if (content !== undefined) {
      fs.writeFileSync(fullPath, content, 'utf8');
      bytesWritten = Buffer.byteLength(content, 'utf8');
    } else {
      throw new Error('Provide content (text) or contentBase64 (binary)');
    }

    let result = `Wrote ${bytesWritten} bytes to ${filePath} in project "${project}"`;

    if (autoIngest !== false) {
      try {
        const ext = path.extname(filePath).toLowerCase();
        const extGlob = ext ? `**/*${ext}` : '';
        if (extGlob) {
          rgr(`sources add "${extGlob}"`, projectPath);
        }
        const out = rgr('ingest', projectPath, 300000);
        result += '\n\nAuto-ingested. Index is ready for search.';
      } catch (e) {
        result += `\n\nAuto-ingest failed: ${e.message}. Run ragmir_ingest manually.`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
  },

  ragmir_write_files_batch({ project, files, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    let totalBytes = 0;
    let count = 0;
    for (const file of files) {
      const fullPath = path.join(projectPath, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      if (file.contentBase64) {
        const buffer = Buffer.from(file.contentBase64, 'base64');
        fs.writeFileSync(fullPath, buffer);
        totalBytes += buffer.length;
      } else if (file.content !== undefined) {
        fs.writeFileSync(fullPath, file.content, 'utf8');
        totalBytes += Buffer.byteLength(file.content, 'utf8');
      } else {
        throw new Error(`File "${file.path}": provide content or contentBase64`);
      }
      count++;
    }

    let result = `Wrote ${count} files (${totalBytes} bytes) to project "${project}"`;

    if (autoIngest !== false) {
      try {
        const exts = [...new Set(files.map(f => path.extname(f.path).toLowerCase()).filter(Boolean))];
        for (const ext of exts) {
          rgr(`sources add "**/*${ext}"`, projectPath);
        }
        const out = rgr('ingest', projectPath, 300000);
        result += '\n\nAuto-ingested. Index is ready for search.';
      } catch (e) {
        result += `\n\nAuto-ingest failed: ${e.message}. Run ragmir_ingest manually.`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
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

  ragmir_delete_file({ project, path: filePath, autoIngest }) {
    const projectPath = getProjectPath(project);
    const fullPath = path.join(projectPath, filePath);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    fs.unlinkSync(fullPath);
    let result = `Deleted ${filePath} from project "${project}"`;

    if (autoIngest !== false) {
      try {
        const out = rgr('ingest', projectPath, 300000);
        result += '\n\nAuto-ingested. Orphaned chunks cleaned up.';
      } catch (e) {
        result += `\n\nAuto-ingest failed: ${e.message}. Run ragmir_ingest manually.`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
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

  ragmir_search_all({ query, topK, projects, totalLimit, offset }) {
    if (typeof query !== 'string' || query.length === 0) {
      throw new Error('Provide a non-empty "query" string');
    }

    const perProjectK = topK || 3;
    const limit = totalLimit || 10;
    const skip = offset || 0;
    const escapedQuery = query.replace(/"/g, '\\"');

    let projectNames;
    if (Array.isArray(projects) && projects.length > 0) {
      projectNames = projects;
    } else if (fs.existsSync(PROJECTS_DIR)) {
      projectNames = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .filter(e => fs.existsSync(path.join(PROJECTS_DIR, e.name, '.ragmir')))
        .map(e => e.name);
    } else {
      return { content: [{ type: 'text', text: `No projects directory at ${PROJECTS_DIR}` }] };
    }

    if (projectNames.length === 0) {
      return { content: [{ type: 'text', text: 'No initialized projects found.' }] };
    }

    // rgr() is execSync-based, so we run searches sequentially. For ≤10
    // projects × 1-2s each this is acceptable and keeps the synchronous
    // model consistent with the rest of the server. Convert to child_process
    // + Promise.all if cross-project latency ever becomes a bottleneck.
    const allHits = [];
    const perProjectStats = [];

    for (const name of projectNames) {
      const projectPath = getProjectPath(name);
      const jsonOut = rgr(
        `search "${escapedQuery}" --top-k ${perProjectK} --json`,
        projectPath,
        60000
      );

      let parsed;
      try {
        // rgr() returns stdout + '\n' + (stderr || e.message) on non-zero exit
        // (when zero hits the CLI exits 1 but still writes valid JSON to stdout).
        // Walk braces to find the end of the first JSON object and parse only that.
        const trimmed = jsonOut.trim();
        const firstBrace = trimmed.indexOf('{');
        if (firstBrace === -1) {
          throw new Error('No JSON object found in rgr output');
        }
        let depth = 0;
        let endIdx = -1;
        let inString = false;
        let escape = false;
        for (let i = firstBrace; i < trimmed.length; i++) {
          const c = trimmed[i];
          if (inString) {
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = false; }
            continue;
          }
          if (c === '"') { inString = true; continue; }
          if (c === '{') depth++;
          else if (c === '}') {
            depth--;
            if (depth === 0) { endIdx = i; break; }
          }
        }
        if (endIdx === -1) {
          throw new Error('No matching closing brace in rgr output');
        }
        parsed = JSON.parse(trimmed.slice(firstBrace, endIdx + 1));
      } catch (e) {
        perProjectStats.push({ project: name, hits: 0, error: `JSON parse failed: ${e.message}` });
        continue;
      }

      const results = Array.isArray(parsed && parsed.results) ? parsed.results : [];
      let count = 0;
      for (const r of results) {
        allHits.push({
          project: name,
          distance: typeof r.distance === 'number' ? r.distance : null,
          citation: r.citation || r.relativePath || r.source || '(unknown source)',
          text: typeof r.text === 'string' ? r.text : '',
        });
        count++;
      }
      perProjectStats.push({ project: name, hits: count });
    }

    allHits.sort((a, b) => {
      if (a.distance === null && b.distance === null) return 0;
      if (a.distance === null) return 1;
      if (b.distance === null) return -1;
      return a.distance - b.distance;
    });

    const page = allHits.slice(skip, skip + limit);
    const totalCandidates = allHits.length;

    if (page.length === 0) {
      const stats = perProjectStats.map(s =>
        s.error
          ? `• ${s.project}: error — ${s.error}`
          : `• ${s.project}: ${s.hits} hit(s)`
      ).join('\n');
      return {
        content: [{
          type: 'text',
          text: `No results across ${projectNames.length} project(s) for "${query}".\n\nPer-project stats:\n${stats}`,
        }],
      };
    }

    const stats = perProjectStats.map(s =>
      s.error
        ? `• ${s.project}: error`
        : `• ${s.project}: ${s.hits} hit(s)`
    ).join('\n');

    const projectListStr = projectNames.join(', ');
    const pageInfo = skip > 0 ? ` (page: skip ${skip}, showing ${page.length})` : '';

    const body = page.map((h, i) => {
      const scoreStr = h.distance === null
        ? 'distance=null (BM25-only)'
        : `distance=${h.distance.toFixed(4)}`;
      const preview = h.text.length > 800 ? h.text.slice(0, 800) + '…' : h.text;
      return `[${i + 1}] project="${h.project}" ${scoreStr}\n    citation: ${h.citation}\n    ${preview.replace(/\n/g, '\n    ')}`;
    }).join('\n\n');

    const header =
      `Searched ${projectNames.length} project(s): ${projectListStr}\n` +
      `Query: "${query}"\n` +
      `Total candidates across all projects: ${totalCandidates}. Showing ${page.length}${pageInfo}.\n`;

    return {
      content: [{
        type: 'text',
        text: `${header}\n${body}\n\n---\nPer-project stats:\n${stats}`,
      }],
    };
  },

  // ─── Knowledge accumulation handlers ───────────────────────────────────

  _backupFile(fullPath, historyBase) {
    const rel = path.relative(PROJECTS_DIR, fullPath);
    const relDir = path.dirname(rel);
    const projectName = path.basename(historyBase);
    const projectPrefix = projectName + path.sep;
    let subPath;
    if (relDir === projectName) {
      subPath = '';
    } else if (relDir.startsWith(projectPrefix)) {
      subPath = relDir.slice(projectPrefix.length);
    } else {
      subPath = relDir;
    }
    const historyDir = path.join(historyBase, '.ragmir-history', subPath);
    fs.mkdirSync(historyDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const bakPath = path.join(historyDir, `${ts}.bak`);
    fs.copyFileSync(fullPath, bakPath);
    return bakPath;
  },

  ragmir_append_file({ project, path: filePath, content, separator, autoBackup, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);
    const fullPath = path.join(projectPath, filePath);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    const defaultSep = '\n\n---\n## Appended: ' + new Date().toISOString() + '\n\n';
    const sep = separator || defaultSep;
    const existing = fs.readFileSync(fullPath, 'utf8');
    const bytesBefore = Buffer.byteLength(existing, 'utf8');

    let bakPath = null;
    if (autoBackup !== false) {
      bakPath = this._backupFile(fullPath, projectPath);
    }

    fs.writeFileSync(fullPath, existing + sep + content, 'utf8');
    const bytesAppended = Buffer.byteLength(content, 'utf8');

    let result = `Appended ${bytesAppended} bytes to ${filePath} in project "${project}"`;
    if (bakPath) result += `\nBackup: ${bakPath.replace(PROJECTS_DIR + '/', '')}`;

    if (autoIngest !== false) {
      try {
        rgr('ingest', projectPath, 300000);
        result += '\nAuto-ingested.';
      } catch (e) {
        result += `\nAuto-ingest failed: ${e.message}`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
  },

  ragmir_edit_file({ project, path: filePath, find, replace, replaceAll, autoBackup, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);
    const fullPath = path.join(projectPath, filePath);
    if (!fs.existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    let content = fs.readFileSync(fullPath, 'utf8');
    const count = (content.split(find).length - 1);

    if (count === 0) {
      throw new Error(`"${find}" not found in ${filePath}`);
    }

    if (!replaceAll && count > 1) {
      throw new Error(`Found ${count} occurrences of "${find}", use replaceAll=true to replace all`);
    }

    let bakPath = null;
    if (autoBackup !== false) {
      bakPath = this._backupFile(fullPath, projectPath);
    }

    if (replaceAll) {
      content = content.split(find).join(replace);
    } else {
      content = content.replace(find, replace);
    }

    fs.writeFileSync(fullPath, content, 'utf8');

    let result = `Replaced ${count} occurrence${count > 1 ? 's' : ''} of "${find}" with "${replace}" in ${filePath}`;
    if (bakPath) result += `\nBackup: ${bakPath.replace(PROJECTS_DIR + '/', '')}`;

    if (autoIngest !== false) {
      try {
        rgr('ingest', projectPath, 300000);
        result += '\nAuto-ingested.';
      } catch (e) {
        result += `\nAuto-ingest failed: ${e.message}`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
  },

  ragmir_supersede_note({ project, oldPath, newPath, newContent, reason, autoBackup, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);
    const oldFull = path.join(projectPath, oldPath);
    if (!fs.existsSync(oldFull)) throw new Error(`File not found: ${oldPath}`);

    let oldContent = fs.readFileSync(oldFull, 'utf8');
    const ext = path.extname(oldPath).toLowerCase();
    const iso = new Date().toISOString().replace(/[:.]/g, '-');
    let bakPath = null;

    if (autoBackup !== false) {
      bakPath = this._backupFile(oldFull, projectPath);
    }

    if (typeof newContent !== 'string') {
      throw new Error('newContent is required and must be a string');
    }

    if (ext === '.json') {
      try {
        const obj = JSON.parse(oldContent);
        obj.status = 'superseded';
        obj.superseded_by = newPath;
        obj.superseded_at = iso;
        if (reason) obj.superseded_reason = reason;
        oldContent = JSON.stringify(obj, null, 2);
      } catch (e) {
        oldContent = `<!-- superseded: ${iso}; superseded_by: ${newPath}; reason: ${reason || 'none'} -->\n\n` + oldContent;
      }
    } else if (ext === '.yaml' || ext === '.yml') {
      const lines = oldContent.split('\n');
      let statusUpdated = false, supByUpdated = false;
      for (let i = 0; i < lines.length; i++) {
        if (!statusUpdated && /^status:\s*/.test(lines[i])) {
          lines[i] = 'status: superseded';
          statusUpdated = true;
          continue;
        }
        if (!supByUpdated && /^superseded_by:\s*/.test(lines[i])) {
          lines[i] = `superseded_by: ${newPath}`;
          supByUpdated = true;
          continue;
        }
      }
      const prepend = [];
      if (reason) prepend.push(`reason: ${reason}`);
      if (!supByUpdated) prepend.push(`superseded_by: ${newPath}`);
      if (!statusUpdated) prepend.push('status: superseded');
      oldContent = prepend.concat(lines).join('\n');
    } else {
      oldContent = `<!-- superseded: ${iso}; superseded_by: ${newPath}; reason: ${reason || 'none'} -->\n\n` + oldContent;
    }

    fs.writeFileSync(oldFull, oldContent, 'utf8');

    // Write new file
    const newFull = path.join(projectPath, newPath);
    fs.mkdirSync(path.dirname(newFull), { recursive: true });
    fs.writeFileSync(newFull, newContent, 'utf8');

    let result = `Superseded ${oldPath} → ${newPath}\nReason: ${reason || 'none'}\nBackup: ${bakPath ? bakPath.replace(PROJECTS_DIR + '/', '') : 'none'}`;

    if (autoIngest !== false) {
      try {
        rgr('ingest', projectPath, 300000);
        result += '\nAuto-ingested.';
      } catch (e) {
        result += `\nAuto-ingest failed: ${e.message}`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
  },

  ragmir_list_history({ project, path: filePath }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const historyDir = path.join(projectPath, '.ragmir-history', path.dirname(filePath));
    if (!fs.existsSync(historyDir)) {
      return { content: [{ type: 'text', text: `No history found for ${filePath}` }] };
    }

    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.bak')).sort().reverse();
    if (files.length === 0) {
      return { content: [{ type: 'text', text: `No backup versions for ${filePath}` }] };
    }

    const lines = files.map(f => {
      const stat = fs.statSync(path.join(historyDir, f));
      const ts = f.replace('.bak', '');
      return `  ${f} — ${stat.size} bytes — ${ts}`;
    });

    return { content: [{ type: 'text', text: `History for ${filePath} (${files.length} versions):\n\n${lines.join('\n')}` }] };
  },

  ragmir_diff_versions({ project, path: filePath, versionA, versionB }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const historyDir = path.join(projectPath, '.ragmir-history', path.dirname(filePath));
    const bakFiles = fs.existsSync(historyDir) ? fs.readdirSync(historyDir).filter(f => f.endsWith('.bak')).sort().reverse() : [];

    function resolveVersion(ver) {
      if (ver === 'current') return { type: 'current', path: path.join(projectPath, filePath) };
      // It's a backup filename
      const bakPath = path.join(historyDir, ver);
      if (!fs.existsSync(bakPath)) throw new Error(`Version not found: ${ver}`);
      return { type: 'backup', path: bakPath, name: ver };
    }

    const vA = resolveVersion(versionA || (bakFiles.length > 0 ? bakFiles[0] : null));
    const vB = resolveVersion(versionB || 'current');

    let contentA, contentB;
    if (vA.type === 'current') contentA = fs.readFileSync(vA.path, 'utf8');
    else contentA = fs.readFileSync(vA.path, 'utf8');
    if (vB.type === 'current') contentB = fs.readFileSync(vB.path, 'utf8');
    else contentB = fs.readFileSync(vB.path, 'utf8');

    if (contentA === contentB) {
      return { content: [{ type: 'text', text: 'No differences.' }] };
    }

    // Simple line-based unified diff
    const linesA = contentA.split('\n');
    const linesB = contentB.split('\n');
    const labelA = vA.type === 'current' ? 'current' : vA.name;
    const labelB = vB.type === 'current' ? 'current' : vB.name;

    // Determine which is older
    let olderLabel = labelA, newerLabel = labelB;
    if (vA.type === 'current' && vB.type === 'backup') {
      olderLabel = labelB;
      newerLabel = labelA;
    } else if (vA.type === 'backup' && vB.type === 'current') {
      olderLabel = labelA;
      newerLabel = labelB;
    }

    // LCS-based diff
    const m = linesA.length, n = linesB.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (linesA[i - 1] === linesB[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
        else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }

    // Backtrack to find diff
    const diffs = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
        diffs.unshift({ type: ' ', lineA: i, lineB: j, text: linesA[i - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        diffs.unshift({ type: '+', lineB: j, text: linesB[j - 1] });
        j--;
      } else {
        diffs.unshift({ type: '-', lineA: i, text: linesA[i - 1] });
        i--;
      }
    }

    let output = `--- ${olderLabel}\n+++ ${newerLabel}\n`;
    for (const d of diffs) {
      if (d.type === ' ') {
        output += ` ${d.text}\n`;
      } else if (d.type === '-') {
        output += `-${d.text}\n`;
      } else {
        output += `+${d.text}\n`;
      }
    }

    return { content: [{ type: 'text', text: output }] };
  },

  ragmir_restore_version({ project, path: filePath, version, autoBackup, autoIngest }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const historyDir = path.join(projectPath, '.ragmir-history', path.dirname(filePath));
    const bakPath = path.join(historyDir, version);
    if (!fs.existsSync(bakPath)) throw new Error(`Backup not found: ${version}`);

    const currentFull = path.join(projectPath, filePath);

    let bakNow = null;
    if (autoBackup !== false && fs.existsSync(currentFull)) {
      bakNow = this._backupFile(currentFull, projectPath);
    }

    const restored = fs.readFileSync(bakPath, 'utf8');
    fs.mkdirSync(path.dirname(currentFull), { recursive: true });
    fs.writeFileSync(currentFull, restored, 'utf8');
    const size = Buffer.byteLength(restored, 'utf8');

    let result = `Restored ${filePath} from ${version} (${size} bytes)\nBackup of current: ${bakNow ? bakNow.replace(PROJECTS_DIR + '/', '') : 'none'}`;

    if (autoIngest !== false) {
      try {
        rgr('ingest', projectPath, 300000);
        result += '\nAuto-ingested.';
      } catch (e) {
        result += `\nAuto-ingest failed: ${e.message}`;
      }
    }

    return { content: [{ type: 'text', text: result }] };
  },

  ragmir_health_check({ project, deep }) {
    const projectPath = getProjectPath(project);
    if (!fs.existsSync(projectPath)) throw new Error(`Project "${project}" not found`);

    const hasRagmir = fs.existsSync(path.join(projectPath, '.ragmir'));
    const files = walkDir(projectPath);
    const lastActivity = files.length > 0
      ? files.map(f => fs.statSync(path.join(projectPath, f.path)).mtime)
          .sort((a, b) => b - a)[0]
      : 'N/A';

    let statusOut = rgr('status', projectPath);
    let summary = `=== Health Check: ${project} ===\n`;
    summary += `Project exists: yes\n`;
    summary += `.ragmir initialized: ${hasRagmir ? 'yes' : 'NO'}\n`;
    summary += `Files: ${files.length}\n`;
    summary += `Last activity: ${lastActivity}\n\n`;
    summary += `--- Status ---\n${statusOut}\n`;

    if (deep) {
      const auditOut = rgr('audit', projectPath);
      summary += `\n--- Audit (deep) ---\n${auditOut}\n`;
    }

    // Parse status for color coding
    const hasChunks = statusOut.includes('chunksIndexed') || statusOut.includes('chunks');
    if (hasRagmir && hasChunks) {
      summary += `\n✅ Health: OK\n`;
    } else if (!hasRagmir) {
      summary += `\n❌ Health: Project not initialized\n`;
    } else {
      summary += `\n⚠️  Health: No chunks indexed\n`;
    }

    return { content: [{ type: 'text', text: summary }] };
  },

  ragmir_admin_reload_tools() {
    notifyToolsChanged();
    const names = TOOLS.map(t => t.name).sort();
    return {
      content: [{
        type: 'text',
        text: `Sent notifications/tools/list_changed to all connected clients.\n\nCurrently registered: ${TOOLS.length} tools\n${names.join('\n')}\n\nClients honouring the MCP listChanged capability will re-call tools/list automatically.`,
      }],
    };
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
      'Ragmir — local RAG knowledge base that stores documents, code, and notes.',
      '',
      '=== WHEN TO SEARCH THE KNOWLEDGE BASE ===',
      'ALWAYS use ragmir_search/ragmir_ask/ragmir_research when the user asks about:',
      '- The contents of files they previously uploaded',
      '- Project documentation, manuals, reports, notes, code',
      '- Any factual question where the answer might be in their indexed data',
      'If you do not know which project contains the data, call ragmir_list_projects first.',
      '',
      'PROJECT WORKFLOW:',
      '1. ragmir_list_projects() — find which project to use (only if uncertain)',
      '2. ragmir_create_project(name) — only when creating a new project',
      '3. ragmir_write_files_batch(project, files) — upload TEXT files (code, .md, .txt)',
      '   OR upload_to_ragmir() from ragmir-upload MCP for BINARY files (.docx, .pdf, .xlsx, images)',
      '4. Files auto-ingest. No need to call ingest manually.',
      '5. ragmir_search / ragmir_ask / ragmir_research — query the indexed content.',
      '',
      'CHOOSING THE RIGHT QUERY TOOL:',
      '- ragmir_search → raw passages with citations (fast, prefer for specific lookups)',
      '- ragmir_ask → LLM-synthesized answer with citations (use for questions needing reasoning)',
      '- ragmir_research → deep multi-query investigation (use for reports/comparisons/overviews)',
      '',
      'BINARY FILES (.docx, .pdf, .xlsx, .pptx, images): use the upload_to_ragmir tool from the ragmir-upload MCP server.',
      '  Example: upload_to_ragmir(project="myproject", path="docs/report.docx", localPath="C:\\Users\\user\\Documents\\report.docx")',
      '  It reads the local file and uploads it automatically. NEVER write code or shell commands for this — just call the tool.',
      '',
      '=== KNOWLEDGE ACCUMULATION (Experience Records) ===',
      'For agents that want to accumulate and update experience over time:',
      '- DESIGN: one knowledge record = one small file (2-10 KB). Records can be YAML, JSON, or Markdown.',
      '- STRUCTURE: use a folder like `experience/<task-id>/note.yaml` so each record has a clean path.',
      '- LIFECYCLE:',
      '  * Create: ragmir_write_file (new record)',
      '  * Add findings to existing record: ragmir_append_file (with timestamp separator)',
      '  * Update a specific field: ragmir_edit_file (find/replace)',
      '  * Found a better method? ragmir_supersede_note — preserves old + links to new',
      '- SAFETY:',
      '  * Every write/edit/append/delete auto-backs up to .ragmir-history/ BEFORE the operation',
      '  * Every mutation auto-triggers rgr ingest (incremental — only the changed file is re-embedded)',
      '  * Use ragmir_list_history + ragmir_diff_versions to review before destructive ops',
      '  * Use ragmir_restore_version to roll back if needed',
      '- VERIFICATION: ragmir_health_check (fast status) or with deep=true (full audit) after batch ops',
      '- All .ragmir-history/ backups are excluded from the ragmir index automatically (hidden directory).',
      '',
      '=== HOT RELOAD OF TOOL LIST ===',
      'After server upgrades that add/change/remove tools, the MCP client normally only learns about',
      'changes on reconnect. This server emits notifications/tools/list_changed (the MCP spec-compliant',
      'mechanism) so MCP-compliant clients refresh their tool list without reconnecting.',
      'Triggers:',
      '  - ragmir_admin_reload_tools() MCP call — emits notification, returns sorted tool list',
      '  - SIGHUP sent to the server process (kill -HUP <pid>) — emits notification, logs to stderr',
      'Call ragmir_admin_reload_tools after server.js is upgraded and the process restarted, OR send',
      'SIGHUP if you cannot call the tool (e.g. the upgrade changed the tool name itself).',
      '',
      'Do not announce "let me search" — just call the tool directly and use the result.',
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

process.on('SIGHUP', () => {
  notifyToolsChanged();
  process.stderr.write(`[ragmir] SIGHUP received → notified ${TOOLS.length} tools\n`);
});

process.on('SIGTERM', () => process.exit(0));

// Log to stderr (doesn't interfere with MCP stdio)
process.stderr.write(`ragmir-universal MCP server started (projects: ${PROJECTS_DIR})\n`);
