#!/usr/bin/env node
// Transparent stdio proxy for the Firefox Agent Bridge MCP server, used only by the bridge arm of
// the eval. The bridge leaves a session's tab group open after its MCP client disconnects (the
// group shows as "disconnected"), so a page left in it keeps polling the task's server and its
// requests land in the next attempts' ledgers (the harness then marks those rows foreign-browser).
// This proxy forwards every message unchanged and, when the client closes stdin, closes the tabs
// the session still has before letting the server exit. It adds no tools and edits no message.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [serverPath] = process.argv.slice(2);
const LOG = process.env['BRIDGE_PROXY_LOG'];
const note = (text) => LOG && appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${text}\n`);

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env, detached: true });
const pending = new Map();
let seq = 0;

const fromChild = createInterface({ input: child.stdout });
fromChild.on('line', (line) => {
  let id;
  try {
    id = JSON.parse(line).id;
  } catch {}
  if (typeof id === 'string' && pending.has(id)) {
    pending.get(id)(line);
    pending.delete(id);
    return;
  }
  process.stdout.write(line + '\n');
});

function call(name, args, timeoutMs = 1000) {
  const id = `cleanup-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => (pending.delete(id), resolve(null)), timeoutMs);
    pending.set(id, (line) => (clearTimeout(timer), resolve(JSON.parse(line))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

async function closeTabs() {
  const ctx = await call('tabs_context_mcp', {});
  const text = ctx?.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
  let ids = [];
  try {
    ids = JSON.parse(text.slice(text.indexOf('{'))).availableTabs.map((t) => t.tabId);
  } catch {}
  await Promise.all(ids.map((tabId) => call('tabs_close_mcp', { tabId })));
  note(`closed ${ids.length} tab(s): ${ids.join(',')}`);
}

let shuttingDown = null;
function shutdown(reason) {
  note(reason);
  shuttingDown ??= (async () => {
    try {
      await closeTabs();
    } catch (error) {
      note(`cleanup failed: ${error.message}`);
    }
    child.stdin.end();
    setTimeout(() => child.kill(), 500).unref();
  })();
}

const toChild = createInterface({ input: process.stdin });
toChild.on('line', (line) => child.stdin.write(line + '\n'));
toChild.on('close', () => shutdown('stdin closed'));
child.on('exit', (code, signal) => {
  note(`server exited code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => shutdown(`got ${signal}`));
