import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === 'linux' && args.some(arg => arg === 'build' || arg === 'bundle')) {
  const osRelease = readFileSync('/etc/os-release', 'utf8');
  const distro = osRelease.match(/^(?:ID|ID_LIKE)=.*$/gm) ?? [];
  if (distro.some(line => line.split('=')[1].replaceAll('"', '').split(/\s+/).includes('arch'))) {
    // linuxdeploy's bundled strip predates Arch's RELR ELF sections. Cargo
    // already strips our release executable; leave bundled system libraries alone.
    env.NO_STRIP = '1';
  }
}

// npm scripts put the project's Tauri CLI on PATH.
const child = spawn('tauri', args, { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('error', error => {
  console.error(`Unable to start Tauri: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
