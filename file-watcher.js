#!/usr/bin/env node
// file-watcher.js — Watches project directories for new/changed files and auto-ingests
// Polls every N seconds, runs rgr ingest when changes detected

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECTS_DIR = process.env.RAGMIR_PROJECTS_DIR || '/opt/ragmir-projects';
const RGR = '/usr/local/node22/bin/rgr';
const POLL_INTERVAL = parseInt(process.env.WATCH_INTERVAL || '10000', 10);
const EXCLUDE_DIRS = ['.ragmir', 'node_modules', '.git'];

function findProjectDirs() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(PROJECTS_DIR, e.name))
    .filter(d => fs.existsSync(path.join(d, '.ragmir')));
}

function getFileFingerprint(dir) {
  let hash = '';
  function walk(d, prefix) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDE_DIRS.includes(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix + entry.name + '/');
      } else {
        const stat = fs.statSync(full);
        hash += `${prefix}${entry.name}:${stat.size}:${stat.mtimeMs};`;
      }
    }
  }
  walk(dir, '');
  return hash;
}

function ingest(projectDir) {
  const name = path.basename(projectDir);
  try {
    execSync(`${RGR} ingest --project-root "${projectDir}"`, {
      encoding: 'utf8',
      timeout: 300000,
      env: { ...process.env, PATH: `/usr/local/node22/bin:${process.env.PATH}` },
    });
    process.stderr.write(`[file-watcher] ingested "${name}" OK\n`);
    return true;
  } catch (e) {
    process.stderr.write(`[file-watcher] ingest failed for "${name}": ${e.message}\n`);
    return false;
  }
}

const fingerprints = new Map();

process.stderr.write(`[file-watcher] watching ${PROJECTS_DIR} every ${POLL_INTERVAL}ms\n`);

function tick() {
  const projects = findProjectDirs();
  for (const projectDir of projects) {
    const fp = getFileFingerprint(projectDir);
    const prev = fingerprints.get(projectDir);
    if (prev !== undefined && prev !== fp) {
      const name = path.basename(projectDir);
      process.stderr.write(`[file-watcher] changes detected in "${name}", ingesting...\n`);
      ingest(projectDir);
    }
    fingerprints.set(projectDir, fp);
  }
}

tick();
setInterval(tick, POLL_INTERVAL);
