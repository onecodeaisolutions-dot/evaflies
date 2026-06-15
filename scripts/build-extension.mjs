// Gera o pacote de PRODUÇÃO da extensão para a Chrome Web Store.
// Remove os hosts de desenvolvimento (localhost/127.0.0.1) do manifest,
// deixando apenas os https — reduz a chance de "revisão detalhada".
// Uso: node scripts/build-extension.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const SRC = path.join(root, 'extension');
const BUILD = path.join(root, 'build', 'extension');
const ZIP = path.join(root, 'evaflies-extension-prod.zip');

await fs.rm(path.join(root, 'build'), { recursive: true, force: true });
await fs.cp(SRC, BUILD, { recursive: true });

// Mantém só host_permissions https (descarta localhost/127.0.0.1 de dev).
const manifestPath = path.join(BUILD, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const before = manifest.host_permissions || [];
manifest.host_permissions = before.filter((h) => h.startsWith('https://'));
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

await fs.rm(ZIP, { force: true });
execFileSync('zip', ['-r', '-q', ZIP, '.'], { cwd: BUILD });

console.log('host_permissions de produção:', manifest.host_permissions);
console.log('Pacote gerado:', ZIP);
