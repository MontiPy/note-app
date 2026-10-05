#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { start } from './app.js';

const HELP = `Usage: notes [vault-folder] [--port 4321] [--open]

Starts the notes app for a folder of Markdown files (default: ~/Notes).
The folder is created if it doesn't exist. Only this computer can connect.

Options:
  --port <n>   Port to listen on (default 4321, or $NOTES_PORT)
  --open       Open the app in your browser
  --no-seed    Don't add starter templates to the vault
  -h, --help   Show this help`;

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(HELP);
  process.exit(0);
}

let vaultPath = process.env.NOTES_VAULT || path.join(os.homedir(), 'Notes');
let port = Number(process.env.NOTES_PORT) || 4321;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!args[i].startsWith('--')) vaultPath = args[i].replace(/^~(?=$|\/)/, os.homedir());
}
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('Invalid --port');
  process.exit(1);
}

try {
  const { url, vault } = await start({ vaultPath, port, seed: !args.includes('--no-seed') });
  console.log(`Notes is running at ${url}`);
  console.log(`Vault: ${vault.root}`);
  console.log('Press Ctrl+C to stop.');
  if (args.includes('--open')) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
} catch (e) {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Try --port ${port + 1}.`);
  else console.error(e.message);
  process.exit(1);
}
