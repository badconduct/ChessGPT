import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, delimiter } from 'node:path';

let queue = Promise.resolve();
export async function codexCommand(config) {
  if (config.codexJs) return { command: process.execPath, prefix: [resolve(config.codexJs)] };
  const command = config.codexCommand || 'codex';
  if (process.platform !== 'win32' || !/^codex(?:\.cmd)?$/i.test(command)) return { command, prefix: [] };
  // npm's Windows .cmd shim cannot be spawned without a shell. Launch its JS entry instead.
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    for (const candidate of ['codex.exe', 'node_modules/@openai/codex/bin/codex.js']) {
      const path = join(directory.replace(/^"|"$/g, ''), candidate);
      try { await access(path); return candidate.endsWith('.js') ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] }; } catch { /* try next PATH entry */ }
    }
  }
  throw new Error('Codex was not found on PATH. Install Codex or set CODEX_COMMAND / CODEX_JS_PATH.');
}

function run(cli, args, input, config, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(cli.command, cli.prefix.concat(args), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let outputBytes = 0, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.once('close', () => reject(error)); child.kill();
        } else reject(error);
      } else resolveResult();
    };
    const timer = setTimeout(() => finish(new Error('Local Codex timed out. Retry White.')), config.timeout || 180000);
    // CLI progress is drained, bounded, and never copied into public errors or logs.
    const drain = chunk => { outputBytes += chunk.length; if (outputBytes > 4 * 1024 * 1024) finish(new Error('Local Codex output exceeded the limit.')); };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.on('error', () => finish(new Error('Could not launch Codex. Check CODEX_COMMAND / CODEX_JS_PATH.')));
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code === 0 ? null : new Error('Local Codex failed. Check codex login status and your model access.')));
    child.stdin.end(input);
  });
}

export async function checkCodex(config) {
  const cli = await codexCommand(config);
  await run(cli, ['login', 'status'], '', { ...config, timeout: 15000 }, tmpdir());
}

export function localCodex(config, instructions, prompt) {
  const task = queue.then(async () => {
    const cli = await codexCommand(config);
    const temporary = await mkdtemp(join(tmpdir(), 'chessgpt-codex-'));
    try {
      const schema = join(temporary, 'schema.json'), output = join(temporary, 'reply.json');
      await writeFile(schema, JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }));
      const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--strict-config',
        '--disable', 'shell_tool', '--disable', 'plugins', '--disable', 'skill_search', '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'multi_agent', '--disable', 'view_image',
        '--color', 'never', '--output-schema', schema, '--output-last-message', output];
      if (config.model && config.model !== 'default') args.push('--model', config.model);
      if (config.reasoning) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(config.reasoning));
      args.push('-');
      await run(cli, args, instructions + '\nReturn your response as the text field of the outer JSON object. The text must contain exactly the response requested below. Do not use tools.\n\n' + prompt, config, temporary);
      const data = JSON.parse(await readFile(output, 'utf8'));
      if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('Local Codex returned no text.');
      return data.text;
    } finally {
      if (dirname(resolve(temporary)) === resolve(tmpdir()) && basename(temporary).startsWith('chessgpt-codex-')) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  queue = task.catch(() => {});
  return task;
}
