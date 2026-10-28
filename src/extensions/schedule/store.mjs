import fs from 'node:fs';
import path from 'node:path';
import {TASK_CONFIG as config} from './config.mjs';

const {recordExtension, temporarySuffix, fileMode} = config.storage;
const runIdPattern = /^[a-zA-Z0-9_-]+$/;

export function createTaskRunStore(directory) {
  fs.mkdirSync(directory, {recursive: true});
  const records = new Map();
  for (const name of fs.readdirSync(directory).filter(entry => entry.endsWith(recordExtension))) {
    const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    records.set(record.id, record);
  }
  const ordered = () => [...records.values()].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  function put(record) {
    if (typeof record.id !== 'string' || !runIdPattern.test(record.id)) throw new Error('Invalid run record id');
    const file = path.join(directory, record.id + recordExtension);
    fs.writeFileSync(file + temporarySuffix, JSON.stringify(record), {mode: fileMode});
    fs.renameSync(file + temporarySuffix, file);
    records.set(record.id, structuredClone(record));
  }
  return {
    put,
    has: id => records.has(id),
    get: id => structuredClone(records.get(id)),
    all: () => structuredClone(ordered()),
    query: ({taskId = '', status = '', query = '', page = 1, pageSize = 50, before = null} = {}) => {
      page = Number(page);
      pageSize = Number(pageSize);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('Invalid pagination parameters');
      const needle = String(query).trim().toLocaleLowerCase();
      const rows = ordered().filter(run => (!taskId || run.taskId === taskId) && (!status || run.status === status) && (!before || run.startedAt <= Number(before)) && (!needle || [run.name, run.result, run.error, run.task.instruction].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)));
      return {runs: structuredClone(rows.slice((page - 1) * pageSize, page * pageSize)), total: rows.length, page, pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize))};
    },
  };
}
