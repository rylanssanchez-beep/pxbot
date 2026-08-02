'use strict';

// Loads KEY=VALUE pairs from .env (repo root) into process.env, without
// overwriting anything already set in the real environment. No external
// dependency (no `dotenv` package) — matches server.js's Node-built-ins-only
// philosophy. `require`d with `node -r ./scripts/load_env.js <script>` so
// credentials never appear as command-line arguments (visible via `ps`).

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

function loadEnv(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return; }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

loadEnv(ENV_PATH);
