import { startFromEnvironment } from '../server.js';

if (process.argv.includes('--demo')) process.env.AI_MODE = 'demo';
process.env.AI_MODE = process.env.AI_MODE || 'gateway';
await startFromEnvironment();
