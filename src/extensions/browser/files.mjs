import fs from 'node:fs/promises';
import path from 'node:path';

// Resolve upload paths without reading or filtering their contents.
export async function resolveUploadPath(target, {cwd = process.cwd()} = {}) {
  const candidates = [target];
  try {
    const decoded = decodeURIComponent(target);
    if (decoded !== target) candidates.push(decoded);
  } catch {}
  let file;
  for (const candidate of candidates) {
    try { file = await fs.realpath(path.resolve(cwd, candidate)); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!file) file = path.resolve(cwd, target);
  return file;
}
