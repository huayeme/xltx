import { writeFileAtomicSync } from './atomic-file.js';

export function writePrivateFileSync(file, data) {
    writeFileAtomicSync(file, data, 0o600);
}
