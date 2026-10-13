import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

export async function gatewayToken(env = process.env) {
  if (env.AI_TOKEN_FILE) return (await readFile(env.AI_TOKEN_FILE, 'utf8')).trim();
  if (env.AI_TOKEN) return env.AI_TOKEN;
  if (!['ssh', 'dockernet-ssh'].includes(env.AI_TOKEN_SOURCE)) throw new Error((env.AI_MODE === 'api' ? 'Remote API' : 'Gateway mode') + ' requires AI_TOKEN or AI_TOKEN_FILE');
  if (process.platform !== 'win32') throw new Error('SSH token retrieval requires Windows/WSL; use AI_TOKEN_FILE in Docker.');
  const target = env.AI_SSH_TARGET, key = env.AI_SSH_KEY, container = env.AI_SSH_CONTAINER;
  const tokenPath = env.AI_SSH_TOKEN_PATH || '/run/secrets/client-token';
  if (!target || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(target) || !key || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container || '') || !/^\/run\/secrets\/[a-zA-Z0-9_.-]+$/.test(tokenPath)) throw new Error('SSH token retrieval requires valid AI_SSH_TARGET, AI_SSH_KEY, AI_SSH_CONTAINER and AI_SSH_TOKEN_PATH settings.');
  try {
    const { stdout } = await promisify(execFile)('wsl.exe', [
      '-d', env.AI_WSL_DISTRO || 'Debian', '--exec', 'ssh', '-i', key,
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target,
      'docker exec ' + container + ' cat ' + tokenPath
    ], { timeout: 15000, maxBuffer: 4096, windowsHide: true });
    const token = stdout.trim();
    if (token.length < 32 || /\s/.test(token)) throw new Error('Invalid credential');
    return token;
  } catch {
    throw new Error('Could not retrieve the client credential through WSL/SSH. Check the SSH settings or configure AI_TOKEN_FILE.');
  }
}
