import {msg} from './messages.mjs';

// Restarting the service is the point of the command: ask systemd right away
// and let it stop this process. The reply is already in the answer that the
// bridge publishes next; if the restart wins the race, the user sees the
// session come back instead of a confirmation.
export function createReload({systemctl, serviceName, log = console.error}) {
  return function reload() {
    if (systemctl(['is-active', serviceName], {allowFailure: true}).trim() !== 'active') return {text: msg('reloadUnmanaged')};
    log('[reload]', 'Restart requested');
    systemctl(['restart', '--no-block', serviceName]);
    return {text: msg('reload')};
  };
}
