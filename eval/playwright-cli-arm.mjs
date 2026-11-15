// The playwright-cli condition: the agent drives the browser by running
// `playwright-cli` in its shell, with no MCP server. The backends' sandboxes
// give that shell no network, loopback included, so the command on its PATH is
// a stub that hands each invocation (cwd and argv) to a broker in the harness
// process through files in the attempt's directory. The broker runs the real
// @playwright/cli outside the sandbox, as every condition's MCP server and
// browser run, and hands back stdout, stderr and the exit code unchanged.
//
// The attempt's directory is set up as `playwright-cli install --skills=agents`
// leaves a workspace: .playwright/cli.config.json and the packaged skill under
// .agents/skills/playwright-cli. The config carries what playwright-mcp gets
// from flags and its config file.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const requireHere = createRequire(import.meta.url);

export const PLAYWRIGHT_CLI = 'playwright-cli';
export const CLI_TIMEOUT_MS = 180000;
const RPC_DIR = join('.playwright', 'rpc');

const cliRoot = () => dirname(requireHere.resolve('@playwright/cli/package.json'));
export const cliEntry = () => join(cliRoot(), 'playwright-cli.js');
const coreRoot = () => dirname(requireHere.resolve('playwright-core/package.json'));
export const cliSkillDir = () => join(coreRoot(), 'lib', 'tools', 'cli-client', 'skill');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function skillFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? skillFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

// What identifies the surface: the package, the playwright-core under it, the
// skill the agent is handed and the command list `--help` prints.
export function cliInfo() {
  const read = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const skill = readFileSync(join(cliSkillDir(), 'SKILL.md'), 'utf8');
  const files = skillFiles(cliSkillDir());
  const help = JSON.parse(readFileSync(join(coreRoot(), 'lib', 'tools', 'cli-client', 'help.json'), 'utf8'));
  const commands = Object.keys(help.commands ?? {}).sort();
  return {
    source: 'dependency',
    version: read(cliRoot()),
    sha256: sha256(readFileSync(cliEntry())),
    core: { version: read(coreRoot()) },
    skill: {
      chars: skill.length,
      sha256: sha256(skill),
      files: files.length,
      totalChars: files.reduce((n, f) => n + statSync(join(cliSkillDir(), f)).size, 0),
    },
    commands: { count: commands.length, hash: sha256(JSON.stringify(commands)) },
  };
}

// The shape the MCP conditions' tools/list record takes, so reports that read
// surfaces[c].tools find one. No schema reaches the model: schemaChars is 0.
export function cliToolsInfo() {
  const info = cliInfo();
  const help = JSON.parse(readFileSync(join(coreRoot(), 'lib', 'tools', 'cli-client', 'help.json'), 'utf8'));
  const names = Object.keys(help.commands ?? {}).sort();
  return { count: names.length, names, hash: info.commands.hash, schemaChars: 0, instructions: null, skill: info.skill };
}

export function cliConfig({ outputDir, viewport, colorScheme, firefoxUserPrefs, userAgent = null, headed = false }) {
  return {
    browser: {
      browserName: 'firefox',
      isolated: true,
      launchOptions: { headless: !headed, firefoxUserPrefs },
      contextOptions: { viewport, colorScheme, ...(userAgent ? { userAgent } : {}) },
    },
    outputDir,
  };
}

const STUB = (rpc) => `#!/bin/sh
rpc='${rpc.replace(/'/g, `'\\''`)}'
id="$$"
rm -f "$rpc/$id".* 2>/dev/null
if ! { printf '%s\\0' "$PWD" "$@" > "$rpc/$id.tmp" && mv "$rpc/$id.tmp" "$rpc/$id.req"; } 2>/dev/null; then
  echo "playwright-cli: cannot write to $rpc" >&2
  exit 1
fi
while [ ! -e "$rpc/$id.done" ]; do sleep 0.02; done
cat "$rpc/$id.out"
cat "$rpc/$id.err" >&2
code=$(cat "$rpc/$id.done")
rm -f "$rpc/$id".* 2>/dev/null
exit "$code"
`;

// Lays out `cwd` as a playwright-cli workspace and returns the directory to put
// first on the shell's PATH.
export function prepareCliWorkspace(cwd, config) {
  mkdirSync(join(cwd, RPC_DIR), { recursive: true });
  writeFileSync(join(cwd, '.playwright', 'cli.config.json'), JSON.stringify(config, null, 2));
  cpSync(cliSkillDir(), join(cwd, '.agents', 'skills', PLAYWRIGHT_CLI), { recursive: true });
  const bin = join(cwd, '.playwright', 'bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, PLAYWRIGHT_CLI);
  writeFileSync(stub, STUB(join(cwd, RPC_DIR)));
  chmodSync(stub, 0o755);
  return bin;
}

// The real CLI's environment: `privateDir` holds its daemon's session files
// and its browser's temp files, so one attempt's daemon is never another's.
export function cliEnv(baseEnv, privateDir) {
  const tmp = join(privateDir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  return { ...baseEnv, PWTEST_DAEMON_SESSION_DIR: join(privateDir, 'daemon'), NO_UPDATE_NOTIFIER: '1', TMPDIR: tmp };
}

export function cliExec(args, { cwd, env, timeoutMs = CLI_TIMEOUT_MS, onChild = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cliEntry(), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const done = (code, extra = '') => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (timedOut ? `playwright-cli: timed out after ${timeoutMs / 1000}s\n` : extra),
        ms: Date.now() - started,
      });
    };
    child.on('error', (error) => done(127, `playwright-cli: ${error.message}\n`));
    child.on('close', (code) => done(code));
  });
}

// Serves the stub's requests in `cwd` until stop(). `log`, when set, gets one
// JSON line per call, shaped like mcp-tap.mjs's call records.
export function startCliBroker({ cwd, env, log = null }) {
  const rpc = join(cwd, RPC_DIR);
  const records = [];
  const children = new Set();
  const inFlight = new Set();
  let stopped = false;
  const finish = (id, result) => {
    try {
      writeFileSync(join(rpc, `${id}.out`), result.stdout);
      writeFileSync(join(rpc, `${id}.err`), result.stderr);
      writeFileSync(join(rpc, `${id}.done.tmp`), String(result.code));
      renameSync(join(rpc, `${id}.done.tmp`), join(rpc, `${id}.done`));
    } catch {}
  };
  const serve = async (file) => {
    const id = file.slice(0, -'.req'.length);
    let parts;
    try {
      parts = readFileSync(join(rpc, file), 'utf8').split('\0');
      rmSync(join(rpc, file), { force: true });
    } catch {
      return;
    }
    parts.pop();
    const [dir, ...args] = parts;
    const at = Date.now();
    const result = await cliExec(args, {
      cwd: dir && existsSync(dir) ? dir : cwd,
      env,
      onChild: (child) => {
        children.add(child);
        child.on('close', () => children.delete(child));
      },
    });
    const record = {
      type: 'call',
      seq: records.length + 1,
      tool: args.find((a) => !a.startsWith('-')) ?? '(none)',
      at,
      ms: result.ms,
      argBytes: Buffer.byteLength(args.join(' ')),
      resultChars: result.stdout.length + result.stderr.length,
      isError: result.code !== 0 || /^### Error/m.test(result.stdout),
      code: result.code,
      args,
    };
    records.push(record);
    if (log) {
      try {
        appendFileSync(log, JSON.stringify(record) + '\n');
      } catch {}
    }
    finish(id, result);
  };
  const scan = () => {
    if (stopped) return;
    let files = [];
    try {
      files = readdirSync(rpc);
    } catch {}
    for (const file of files) {
      if (!file.endsWith('.req') || inFlight.has(file)) continue;
      inFlight.add(file);
      serve(file).finally(() => inFlight.delete(file));
    }
  };
  const timer = setInterval(scan, 15);
  return {
    records: () => records.slice(),
    async stop() {
      stopped = true;
      clearInterval(timer);
      for (const child of children) child.kill('SIGKILL');
      await cliExec(['close-all'], { cwd, env, timeoutMs: 15000 });
    },
  };
}

// A row's tools map from the broker's records, in callTelemetry's shape.
export function cliToolStats(records) {
  const tools = {};
  for (const r of records) {
    const t = (tools[r.tool] ??= { calls: 0, errors: 0, chars: 0, ms: [] });
    t.calls++;
    if (r.isError) t.errors++;
    t.chars += r.resultChars;
    t.ms.push(r.ms);
  }
  for (const t of Object.values(tools)) {
    const sorted = t.ms.sort((a, b) => a - b);
    t.p50_ms = sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
    delete t.ms;
  }
  return tools;
}

export const cliWindows = (records) => records.map((r) => [r.at, r.at + (r.ms ?? 0)]);
