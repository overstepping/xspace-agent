import 'dotenv/config';
import { XSpaceAgent } from './packages/core/dist/agent.js';

const SPACE_URL = 'https://x.com/i/spaces/1XxyggmPRLZGM?s=20';

const provider = process.env.AI_PROVIDER || 'openai';
const apiKeyMap = {
  openai: process.env.OPENAI_API_KEY,
  'openai-chat': process.env.OPENAI_API_KEY,
  claude: process.env.ANTHROPIC_API_KEY,
  groq: process.env.GROQ_API_KEY,
};

const agent = new XSpaceAgent({
  auth: {
    token: process.env.X_AUTH_TOKEN,
    ct0: process.env.X_CT0,
    username: process.env.X_USERNAME,
    password: process.env.X_PASSWORD,
    email: process.env.X_EMAIL,
  },
  ai: {
    provider,
    apiKey: apiKeyMap[provider] || process.env.OPENAI_API_KEY || '',
    systemPrompt: 'You are a helpful AI agent participating in an X Space.',
  },
  voice: {
    provider: process.env.TTS_PROVIDER || 'openai',
    apiKey: process.env.ELEVENLABS_API_KEY || process.env.OPENAI_API_KEY,
  },
  browser: {
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
  behavior: { autoRespond: true, silenceThreshold: 1.5 },
});

agent.on('status', (s) => console.log(`[status] ${s}`));
agent.on('error', (e) => console.error(`[error] ${e?.message || e}`));
agent.on('transcription', ({ speaker, text }) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${speaker}: ${text}`);
});
agent.on('response', ({ text }) => {
  console.log(`[${new Date().toLocaleTimeString()}] [Agent]: ${text}`);
});

const shutdown = async () => {
  console.log('\n[shutdown] leaving Space...');
  try { await agent.leave(); } catch (e) { console.error('leave error:', e?.message); }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(`[launch] joining ${SPACE_URL} (provider=${provider}, headless=true, autoRespond=true)`);
try {
  await agent.join(SPACE_URL);
} catch (e) {
  console.error('[fatal]', e?.message || e);
  process.exit(1);
}
