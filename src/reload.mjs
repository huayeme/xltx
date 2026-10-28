import {execFile} from 'node:child_process';
import {msg} from './messages.mjs';
import {hostEnvironment} from './deploy.mjs';

// systemd reports these while it is already working on the unit; /reload must
// not answer "this process is unmanaged" just because a start or stop is in
// flight.
const managed = new Set(['active', 'reloading', 'activating', 'deactivating']);

const systemctl = (args, timeoutMs = 5000) => new Promise(resolve => {
  execFile('/usr/bin/systemctl', ['--user', ...args], {encoding: 'utf8', timeout: timeoutMs, env: hostEnvironment()}, (error, stdout, stderr) => resolve({error, stdout, stderr}));
});

// /reload restarts the unit and answers nothing: a reply could only be sent
// before the stop, and waiting for it would make the command slow.
export function createReload({serviceName, log = console.error, run = systemctl}) {
  return async function reload() {
    const {stdout} = await run(['is-active', serviceName]);
    if (!managed.has((stdout || '').trim())) return {text: msg('reloadUnmanaged')};
    log('[reload]', 'Restart requested');
    const {error} = await run(['restart', '--no-block', serviceName]);
    if (error) log('[reload]', error.message);
    return {};
  };
}
