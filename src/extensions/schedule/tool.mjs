import net from 'node:net';
import path from 'node:path';
import {TASK_CONFIG as config} from './config.mjs';

const description = `Manage standalone scheduled tasks. Tasks run independently of the chat session and deliver their result to Weixin.

Actions:
- create: name, instruction, kind (once/interval/daily/weekly/hook), schedule fields, optional links and onComplete.
- edit: id, revision and the complete task definition.
- list: current tasks, recent runs and pending triggers.
- runs: execution history; optional taskId, status, query, page and pageSize. Returns runs, total, page, pageSize and pages, newest first.
- run_detail: runId; returns the complete execution record, including saved task, payload, result and error. Use the record id with retry to rerun it.
- pause / resume / delete: id.
- run: id; starts a run now.
- stop: runId; stops only that execution.
- retry: runId; reruns the saved definition and payload without changing the schedule.
- emit: event and optional payload; triggers matching hook tasks.

Schedule fields: once/interval use an ISO at with timezone; interval also uses everySeconds. daily/weekly use HH:mm time and IANA timeZone; weekly uses weekdays (0 Sunday to 6 Saturday). hook uses event. links trigger taskIds on success, failed or finished, passing the previous result. onComplete emits a named event. notifyFailure defaults to true.`;

const parameters = {
  type: 'object',
  properties: {
    action: {type: 'string', enum: ['create', 'edit', 'list', 'runs', 'run_detail', 'pause', 'resume', 'delete', 'run', 'stop', 'retry', 'emit']},
    id: {type: 'string'},
    runId: {type: 'string'},
    taskId: {type: 'string'},
    status: {type: 'string', description: 'Exact execution status, such as success, failed, interrupted, cancelled, running or stopping.'},
    query: {type: 'string', description: 'Case-insensitive search in task name, instruction, result and error.'},
    page: {type: 'integer', minimum: 1},
    pageSize: {type: 'integer', minimum: 1, maximum: 200},
    revision: {type: 'integer'},
    name: {type: 'string', maxLength: config.nameLength},
    instruction: {type: 'string', maxLength: config.instructionLength},
    kind: {type: 'string', enum: config.kinds},
    at: {type: 'string'},
    everySeconds: {type: 'integer', minimum: config.intervalMinSeconds},
    event: {type: 'string', maxLength: config.eventLength},
    notifyFailure: {type: 'boolean'},
    onComplete: {type: 'string', maxLength: config.eventLength},
    time: {type: 'string'},
    timeZone: {type: 'string'},
    weekdays: {type: 'array', items: {type: 'integer'}},
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: {taskId: {type: 'string'}, when: {type: 'string', enum: config.linkConditions}},
        required: ['taskId', 'when'],
        additionalProperties: false,
      },
    },
    payload: {type: 'string'},
  },
  required: ['action'],
  additionalProperties: false,
};

function control(action, fields) {
  const root = process.env.WEIXIN_ROOT;
  if (!root) throw new Error('WEIXIN_ROOT is not set');
  const file = path.join(root, 'data/control.sock');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let buffer = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(60000, () => finish(new Error('Background task API timed out')));
    socket.once('error', () => finish(new Error('Background task API is unavailable')));
    socket.once('connect', () => socket.write(JSON.stringify({command: 'schedule', action, ...fields}) + '\n'));
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 64 * 1024 * 1024) return finish(new Error('Background task response is too large'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end));
        if (result.error) finish(new Error(result.error));
        else finish(null, result.result ?? result);
      } catch (error) {
        finish(error);
      }
    });
    socket.once('end', () => { if (!settled) finish(new Error('Background task API disconnected early')); });
  });
}

export function createScheduleTool() {
  return {
    name: 'schedule',
    label: 'Scheduled tasks',
    description,
    parameters,
    async execute(_toolCallId, args, signal) {
      signal?.throwIfAborted();
      const {action, ...fields} = args;
      const result = await control(action, fields);
      return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
    },
  };
}
