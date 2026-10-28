import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {TASK_CONFIG as config} from './config.mjs';
import {normalizeSchedule, advanceSchedule, validateEvent} from './schedule.mjs';
import {createTaskRunStore} from './store.mjs';

const ACTIONS = ['create', 'edit', 'list', 'runs', 'run_detail', 'pause', 'resume', 'delete', 'run', 'stop', 'retry', 'emit'];

export function createTaskScheduler({directory, execute, notify = async () => {}, now = Date.now, interval = 1000}) {
  const file = path.join(directory, config.storage.tasksFile);
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {tasks: [], pending: []};
  const records = createTaskRunStore(path.join(directory, config.storage.runsDirectory));
  const save = () => {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(file + config.storage.temporarySuffix, JSON.stringify(state), {mode: config.storage.fileMode});
    fs.renameSync(file + config.storage.temporarySuffix, file);
  };
  if (state.active && !records.has(state.active.id)) records.put(state.active);
  for (const run of records.all()) {
    if (config.activeStatuses.includes(run.status)) {
      Object.assign(run, {status: 'interrupted', error: 'Service interrupted; not retried automatically', endedAt: now()});
      records.put(run);
    }
  }
  state.active = null;
  save();
  let active = null;
  let timer;

  const get = id => {
    const task = state.tasks.find(item => item.id === id);
    if (!task) throw new Error('Task not found');
    return task;
  };

  function validateGraph(candidate) {
    const rows = state.tasks.filter(item => item.id !== candidate.id).concat(candidate);
    const byId = new Map(rows.map(item => [item.id, item]));
    for (const link of candidate.links) if (!byId.has(link.taskId)) throw new Error('Linked task not found');
    const visiting = new Set();
    const done = new Set();
    const visit = task => {
      if (visiting.has(task.id)) throw new Error('Task dependencies form a cycle; remove the link back to an upstream task');
      if (done.has(task.id)) return;
      visiting.add(task.id);
      const ids = task.links.map(link => link.taskId);
      if (task.onComplete) ids.push(...rows.filter(item => item.kind === 'hook' && item.event === task.onComplete).map(item => item.id));
      for (const id of ids) {
        const next = byId.get(id);
        if (next) visit(next);
      }
      visiting.delete(task.id);
      done.add(task.id);
    };
    rows.forEach(visit);
  }

  function definition(input, old) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > config.nameLength || typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > config.instructionLength) {
      throw new Error(`Provide a task name (up to ${config.nameLength} characters) and an instruction (up to ${config.instructionLength} characters)`);
    }
    for (const key of ['notifyFailure']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(key + ' must be a boolean');
    if (input.onComplete !== undefined && input.onComplete !== null && input.onComplete !== '') validateEvent(input.onComplete);
    const links = input.links ?? [];
    if (!Array.isArray(links) || links.length > config.maxTasks || links.some(link => !link || typeof link.taskId !== 'string' || !config.linkConditions.includes(link.when)) || new Set(links.map(link => link.taskId)).size !== links.length) {
      throw new Error('Invalid downstream tasks or trigger conditions');
    }
    const task = {
      ...old,
      ...normalizeSchedule(input, now()),
      id: old?.id || crypto.randomUUID(),
      revision: (old?.revision || 0) + 1,
      name: input.name.trim(),
      instruction: input.instruction,
      notifyFailure: input.notifyFailure ?? config.defaultNotifyFailure,
      onComplete: input.onComplete || null,
      links: links.map(link => ({taskId: link.taskId, when: link.when})),
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
      paused: old?.paused ?? false,
      completed: false,
    };
    validateGraph(task);
    return task;
  }

  function create(input) {
    if (state.tasks.length >= config.maxTasks) throw new Error('Task limit reached');
    const task = definition(input);
    state.tasks.unshift(task);
    save();
    return structuredClone(task);
  }

  function edit(id, input) {
    const old = get(id);
    if (input.revision !== old.revision) throw new Error('Task was modified; reopen it and save again');
    const task = definition(input, old);
    state.tasks = state.tasks.map(item => (item === old ? task : item));
    save();
    return structuredClone(task);
  }

  function targets(event) {
    return state.tasks.filter(task => task.kind === 'hook' && task.event === event && !task.paused);
  }

  function enqueue(items) {
    if (state.pending.length + items.length > config.maxPending) throw new Error('Event queue is full');
    state.pending.push(...items.map(item => ({...item, id: crypto.randomUUID(), payload: structuredClone(item.payload ?? null)})));
    return items.length;
  }

  function complete(task, run, chain) {
    const payload = {taskId: task.id, runId: run.id, status: run.status, result: run.result, error: run.error};
    const ids = new Set(task.onComplete ? targets(task.onComplete).map(item => item.id) : []);
    for (const link of task.links) if (link.when === 'finished' || link.when === run.status) ids.add(link.taskId);
    const items = [];
    for (const id of ids) {
      if (!state.tasks.some(item => item.id === id)) continue;
      if (chain.includes(id)) {
        run.notificationError = 'Blocked a circular trigger: ' + id;
        continue;
      }
      items.push({taskId: id, payload, chain});
    }
    enqueue(items);
  }

  function run(id, payload = null, {retryOf = null, task = null, chain = [], queuedId = null, automatic = false} = {}) {
    if (active) throw Object.assign(new Error('A task is already running; try again later'), {code: 'TASK_BUSY'});
    const current = task || get(id);
    if (!retryOf && current.paused) throw new Error('Task is paused; resume it first');
    const snapshot = structuredClone(current);
    const controller = new AbortController();
    const record = {
      id: crypto.randomUUID(),
      taskId: id,
      name: snapshot.name,
      status: 'running',
      startedAt: now(),
      payload: structuredClone(payload),
      task: snapshot,
      automatic,
      ...(retryOf ? {retryOf} : {}),
    };
    const previous = structuredClone(state);
    const advancement = retryOf ? {} : advanceSchedule(current, now());
    const entry = {run: record, controller};
    active = entry;
    Object.assign(current, advancement);
    if (queuedId) state.pending = state.pending.filter(item => item.id !== queuedId);
    state.active = record;
    try {
      save();
      records.put(record);
    } catch (error) {
      state = previous;
      active = null;
      try { save(); } catch (rollback) { console.error('[tasks] failed to save restored state', rollback); }
      throw error;
    }
    entry.promise = (async () => {
      try {
        const result = await Promise.resolve().then(() => execute(structuredClone(snapshot), structuredClone(payload), {
          signal: controller.signal,
          onStopError: message => {
            record.stopError = message;
            try { records.put(record); save(); } catch (error) { console.error('[tasks] failed to save stop error', error); }
          },
        }));
        controller.signal.throwIfAborted();
        record.result = typeof result === 'object' && result !== null ? String(result.text ?? '') : String(result ?? '');
        record.status = 'success';
      } catch (error) {
        record.status = controller.signal.aborted && !record.stopError ? 'cancelled' : 'failed';
        record.error = controller.signal.aborted
          ? (record.stopError ? 'Stop request failed: ' + record.stopError + '; this run has now ended' : 'The user stopped this run')
          : error.message;
      } finally {
        record.endedAt = now();
        try { complete(snapshot, record, [...chain, id]); } catch (error) { record.notificationError = error.message; }
        try {
          await notify({task: snapshot, run: structuredClone(record)});
        } catch (error) {
          record.notificationError = error.message;
        }
        try {
          records.put(record);
          state.active = null;
          save();
        } finally {
          active = null;
        }
      }
      return structuredClone(record);
    })();
    return entry.promise;
  }

  function launch(id, payload, options) {
    const promise = run(id, payload, options);
    promise.catch(error => { if (error.code !== 'TASK_BUSY') console.error('[tasks]', error); });
    return structuredClone(active.run);
  }

  function retry(runId) {
    const original = records.get(runId);
    if (!original || !config.retryableStatuses.includes(original.status)) throw new Error('Only failed, interrupted, stopped or waiting runs can be retried');
    return launch(original.taskId, original.payload, {task: original.task, retryOf: runId});
  }

  function stopRun(runId) {
    if (!active || active.run.id !== runId) throw new Error('This run has already ended');
    if (!active.controller.signal.aborted) {
      active.run.status = 'stopping';
      records.put(active.run);
      save();
      active.controller.abort();
    }
    return {ok: true, status: 'stopping'};
  }

  function update(id, action) {
    const task = get(id);
    if (action === 'delete') {
      if (active?.run.taskId === id) throw new Error('Stop this run before deleting the task');
      if (state.tasks.some(item => item.links.some(link => link.taskId === id))) throw new Error('Remove links to this task from other tasks first');
      state.tasks = state.tasks.filter(item => item !== task);
      state.pending = state.pending.filter(item => item.taskId !== id);
    } else if (action === 'pause') task.paused = true;
    else if (action === 'resume') task.paused = false;
    else throw new Error('Invalid action');
    save();
    return {ok: true};
  }

  async function tick() {
    if (active) return;
    for (const item of [...state.pending]) {
      const task = state.tasks.find(candidate => candidate.id === item.taskId);
      if (!task) {
        state.pending = state.pending.filter(pending => pending.id !== item.id);
        save();
        continue;
      }
      if (task.paused) continue;
      try {
        await run(task.id, item.payload, {chain: item.chain ?? [], queuedId: item.id, automatic: true});
        return;
      } catch (error) {
        if (error.code !== 'TASK_BUSY') throw error;
      }
    }
    for (const task of state.tasks.filter(candidate => !candidate.paused && !candidate.completed && candidate.kind !== 'hook' && candidate.nextAt <= now())) {
      try {
        await run(task.id, null, {automatic: true});
        return;
      } catch (error) {
        if (error.code !== 'TASK_BUSY') throw error;
      }
    }
  }

  async function emit(event, payload) {
    validateEvent(event);
    const queued = enqueue(targets(event).map(task => ({taskId: task.id, payload})));
    save();
    return {queued};
  }

  const list = () => ({
    tasks: structuredClone(state.tasks),
    runs: records.query().runs,
    pending: structuredClone(state.pending),
    running: active ? structuredClone(active.run) : null,
  });

  return {
    create,
    edit,
    run,
    launch,
    retry,
    stopRun,
    update,
    emit,
    tick,
    list,
    runs: records.query,
    runDetail: records.get,
    actions: ACTIONS,
    isRunning: () => !!active,
    start() {
      if (!timer) {
        timer = setInterval(() => tick().catch(console.error), interval);
        timer.unref();
      }
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    async close() {
      clearInterval(timer);
      timer = null;
      if (active && !active.controller.signal.aborted) active.controller.abort();
    },
  };
}
