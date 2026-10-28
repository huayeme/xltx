import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeFileAtomicSync(file, data, mode) {
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    let fd;
    try {
        fd = openSync(temp, 'wx', mode);
        writeFileSync(fd, data, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        if (mode !== undefined) {
            try {
                chmodSync(temp, mode);
            }
            catch {                                     }
        }
        renameSync(temp, file);
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {           }
        }
        try {
            unlinkSync(temp);
        }
        catch {                          }
    }
}

export function backupCorruptFileSync(file) {
    if (!existsSync(file))
        return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${file}.corrupt-${stamp}-${process.pid}`;
    renameSync(file, backup);
    return backup;
}
