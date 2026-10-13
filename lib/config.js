import { gatewayToken } from './credentials.js';
import { checkCodex } from './codex.js';
import { resolve } from 'node:path';

export async function configuration(env = process.env) {
  const mode = env.AI_MODE || 'gateway';
  if (!['api', 'codex', 'gateway', 'demo'].includes(mode)) throw new Error('AI_MODE must be api, codex, gateway or demo');
  const apiFormat = env.AI_API_FORMAT || 'chat';
  if (!['chat', 'responses'].includes(apiFormat)) throw new Error('AI_API_FORMAT must be chat or responses');
  const timeout = Number(env.AI_TIMEOUT_MS || 180000);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 600000) throw new Error('AI_TIMEOUT_MS must be between 1000 and 600000');
  const config = { mode, apiFormat, timeout, recapDir: resolve(env.RECAP_DIR || 'data/recaps'), difficulty: env.CHESS_DIFFICULTY || 'normal',
    model: env.AI_MODEL || 'default', profile: env.AI_PROFILE, codexCommand: env.CODEX_COMMAND, codexJs: env.CODEX_JS_PATH,
    reasoning: mode === 'codex' ? env.AI_REASONING_EFFORT : undefined };
  if (config.reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.reasoning)) throw new Error('Invalid AI_REASONING_EFFORT for local Codex');
  if (mode === 'api' || mode === 'gateway') {
    config.token = await gatewayToken(env);
    if (!config.token.trim()) throw new Error('Remote AI token is empty. Set AI_TOKEN or AI_TOKEN_FILE.');
    config.url = env.AI_URL || 'https://api.openai.com/v1/' + (apiFormat === 'responses' ? 'responses' : 'chat/completions');
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('AI_URL must be an HTTP(S) endpoint without embedded credentials');
    if (mode === 'api' && (!env.AI_MODEL || env.AI_MODEL === 'YOUR_MODEL_ID')) throw new Error('Set AI_MODEL to a model ID offered by your remote API');
  }
  if (mode === 'codex') await checkCodex(config);
  return config;
}
