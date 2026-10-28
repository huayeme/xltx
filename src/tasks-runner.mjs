import path from 'node:path';
import {RpcConnection} from './adapters/pi/rpc-client.mjs';
import {browserConfig} from './extensions/browser/config.mjs';
import {TASK_CONFIG} from './extensions/schedule/config.mjs';

const textOf = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

// Scheduled tasks run in their own ephemeral Pi process. They are independent
// from the Weixin chat session and do not persist a conversation.
export function createTaskRunner({config, root, log = console.error}) {
  const command = path.join(root, 'runtime/bin/pi');
  const extension = path.join(root, 'src/extensions/browser/index.mjs');
  return async function runTask(task, payload, {signal, onStopError = () => {}} = {}) {
    let text = '';
    let failure;
    let settle;
    const settled = new Promise((resolve, reject) => { settle = {resolve, reject}; });
    // The timeout and exit paths can reject before the prompt has been accepted,
    // so keep the rejection observed until the run reaches `await settled`.
    settled.catch(() => {});
    let done = false;
    let timedOut = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      error ? settle.reject(error) : settle.resolve();
    };
    const connection = new RpcConnection(command, ['--mode', 'rpc', '--no-session', '--extension', extension], {
      cwd: config.cwd,
      env: {...process.env, XLTX_BROWSER_PROFILE: path.join(config.dataDir, browserConfig.taskProfileDirectory.replace(/^data\//, ''))},
      maxRecordBytes: config.maxRecordBytes,
      timeoutMs: config.runtimeTimeoutMs,
      log,
      onEvent(event) {
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const value = textOf(event.message.content);
          if (value) text = value;
          if (event.message.errorMessage) failure = event.message.errorMessage;
        }
        if (event.type === 'agent_settled') finish(failure ? new Error(failure) : undefined);
        if (event.type === 'extension_error') log('[task-extension]', event.error || event.message || 'extension error');
      },
      onExit(error) {
        finish(error || new Error('The scheduled task process exited unexpectedly'));
      },
    });
    const abort = () => {
      Promise.resolve(connection.terminate(5000)).catch(error => onStopError(error.message));
    };
    signal?.addEventListener('abort', abort, {once: true});
    const timeoutMessage = `The scheduled task did not finish within ${Math.round(TASK_CONFIG.runTimeoutMs / 60000)} minutes and was stopped`;
    const timer = setTimeout(() => {
      timedOut = true;
      void connection.terminate(5000);
      finish(new Error(timeoutMessage));
    }, TASK_CONFIG.runTimeoutMs);
    try {
      signal?.throwIfAborted();
      const message = task.instruction + (payload == null ? '' : `\n${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
      const result = await connection.request('prompt', {message});
      if (result?.disposition === 'handled') throw new Error('The scheduled task did not start');
      await settled;
      if (signal?.aborted) throw signal.reason || new Error('The user stopped this run');
      return {text: text || '(no text reply)'};
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await connection.close(5000).catch(() => {});
    }
  };
}
