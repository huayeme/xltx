import fs from 'node:fs';
import path from 'node:path';
import {installRoot, inside} from '../../portable.mjs';
import {browserConfig as config} from './config.mjs';

function escapeXml(value) {
  return value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[character]);
}

function find(directory, name, depth) {
  if (depth < 0) return undefined;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Browser component cannot access external paths through a symbolic link: ' + file);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) {
      const found = find(file, name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function browserRoot(project = installRoot) {
  return inside(path.join(project, config.runtimeDirectory), project);
}

// The bundled browser is verified on every use so a partial or tampered
// installation cannot silently fall back to a host browser.
export function browserExecutable(project = installRoot) {
  const root = browserRoot(project);
  if (!fs.statSync(root).isDirectory()) throw new Error('Browser component is not a directory.');
  const file = find(root, config.executableName, config.executableSearchDepth);
  if (!file) throw new Error('The browser in the install directory is incomplete. Please reinstall.');
  return inside(file);
}

export function browserProfileDirectory(project = installRoot) {
  const directory = inside(process.env.XLTX_BROWSER_PROFILE || path.join(project, config.profileDirectory), project);
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  return directory;
}

function fontsConfig(project) {
  const root = browserRoot(project);
  const fonts = path.join(root, config.fontsDirectory);
  if (!fs.existsSync(fonts)) return undefined;
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(project, 'data/cache'), config.fontsCacheName);
  fs.mkdirSync(cache, {recursive: true, mode: 0o700});
  const content = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${escapeXml(fonts)}</dir>
  <cachedir>${escapeXml(cache)}</cachedir>
  <match target="pattern">
    <edit name="dpi" mode="assign"><double>${config.fontDpi}</double></edit>
  </match>
  <alias><family>system-ui</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
</fontconfig>
`;
  const file = path.join(path.dirname(cache), config.fontsConfigName);
  let current;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = undefined; }
  if (current !== content) fs.writeFileSync(file, content, {mode: 0o600});
  return file;
}

export function browserEnvironment(base = process.env, project = installRoot) {
  const env = {...base};
  const libraries = path.join(browserRoot(project), config.librariesDirectory);
  const segments = [fs.existsSync(libraries) ? libraries : undefined, base.LD_LIBRARY_PATH].filter(Boolean).join(':');
  if (segments) env.LD_LIBRARY_PATH = segments;
  try {
    const file = fontsConfig(project);
    if (file) env.FONTCONFIG_FILE = file;
  } catch {}
  return env;
}
