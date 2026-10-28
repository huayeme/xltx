import path from 'node:path';
import {requirePortable,installRoot} from './portable.mjs';
import {redirectLogs} from './local-logs.mjs';
requirePortable();
redirectLogs(path.join(installRoot,'data'));
try{await import('./main.mjs');}catch(error){console.error(error.stack||error.message);process.exitCode=1;}
