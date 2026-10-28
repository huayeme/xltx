import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
export function fileForm(file, field) {
    const form = new FormData();
    form.append(field, new Blob([new Uint8Array(file.data)], { type: 'application/octet-stream' }), file.name);
    return form;
}

export async function fileRequest(url, init) {
    const response = await fetch(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(120_000) });
    if (!response.ok)
        throw new Error(`file-transfer-http-${response.status}`);
    const data = await response.json();
    const rejected = (code) => code !== undefined && code !== 0 && code !== '0';
    if (data.ok === false || rejected(data.errcode) || rejected(data.code))
        throw new Error(`file-transfer-api-${data.errcode ?? data.code ?? 'rejected'}`);
    return data;
}

export async function withOutgoingPath(file, send, dataDir) {
    if (!file.name || /[\\/\x00]/.test(file.name) || file.name === '.' || file.name === '..')
        throw new Error('invalid-file-name');
    const dir = await mkdtemp(join(dataDir, '.delivery-'));
    try {
        const path = join(dir, file.name);
        await writeFile(path, file.data, { mode: 0o600 });
        return await send(path);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
export { fileOperation } from '../engine/abort.js';
