import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writePrivateFileSync} from '../../../vendor/weixin/engine/secure-file.js';
import {msg} from '../../messages.mjs';

// Pi's persisted tree is the only file-format boundary. Preserve entries verbatim:
// messages, images, tool calls, compaction and extension state belong to Pi.
// Never import Pi's package layout or rewrite/migrate the source session.
export function sessionPath(config,file) {
  if(typeof file!=='string'||!file)return undefined;
  const sessions=path.join(config.dataDir,'sessions');
  const resolved=path.resolve(config.dataDir,file);
  if(path.dirname(resolved)===sessions)return resolved;
  // Legacy absolute references remain usable after moving the whole directory.
  if(path.isAbsolute(file)&&file.includes(path.sep+'data'+path.sep+'sessions'+path.sep))return path.join(sessions,path.basename(file));
  throw new Error(msg('rpc.forkInvalidPath'));
}
export function storedSessionPath(config,file){return file?path.relative(config.dataDir,sessionPath(config,file)):undefined;}
export function referenceProtection(reference,config) {
  let file;
  try{file=typeof reference?.sessionFile==='string'?(config?sessionPath(config,reference.sessionFile):reference.sessionFile):undefined;}catch{}
  return {files:file?[file]:[],dirs:[],ids:[]};
}
export function referenceExists(reference,config) {
  try{return referenceProtection(reference,config).files.some(file=>fs.existsSync(file));}catch{return false;}
}
function localWorkingDirectory(config,cwd){
  const relative=path.relative(path.dirname(config.dataDir),cwd||'');
  return path.isAbsolute(cwd||'')&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)?cwd:config.cwd;
}
export function prepareSession(config,file){
  const text=fs.readFileSync(file,'utf8'),end=text.indexOf('\n');
  if(end<0)throw new Error(msg('rpc.forkInvalidHistory'));
  let header;
  try{header=JSON.parse(text.slice(0,end));}catch{throw new Error(msg('rpc.forkInvalidHistory'));}
  if(localWorkingDirectory(config,header.cwd)!==header.cwd){
    const stat=fs.statSync(file);
    const next={...header,cwd:config.cwd,parentSession:header.parentSession?sessionPath(config,header.parentSession):undefined};
    writePrivateFileSync(file,JSON.stringify(next)+text.slice(end));fs.utimesSync(file,stat.atime,stat.mtime);
  }
}
export function createBranch(config,reference,beforeWrite=()=>{}) {
  const sessions=fs.realpathSync(path.join(config.dataDir,'sessions'));
  const file=fs.realpathSync(sessionPath(config,reference.sessionFile));
  if(!file.startsWith(sessions+path.sep))throw new Error(msg('rpc.forkInvalidPath'));
  let records;
  try{records=fs.readFileSync(file,'utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));}catch{throw new Error(msg('rpc.forkInvalidHistory'));}
  const [header,...entries]=records;
  if(header?.type!=='session'||typeof header.id!=='string')throw new Error(msg('rpc.forkInvalidHistory'));
  const byId=new Map();
  for(const entry of entries){
    if(typeof entry.id!=='string'||byId.has(entry.id))throw new Error(msg('rpc.forkInvalidHistory'));
    byId.set(entry.id,entry);
  }
  const target=byId.get(reference.entryId);
  if(target?.type!=='message'||!['user','assistant'].includes(target.message?.role))throw new Error(msg('rpc.forkInvalidEntry'));
  const branch=[],seen=new Set();
  let entry=target;
  while(entry){
    if(seen.has(entry.id))throw new Error(msg('rpc.forkInvalidHistory'));
    seen.add(entry.id);branch.push(entry);
    if(entry.parentId===null)break;
    if(typeof entry.parentId!=='string'||!byId.has(entry.parentId))throw new Error(msg('rpc.forkInvalidHistory'));
    entry=byId.get(entry.parentId);
  }
  branch.reverse();
  const timestamp=new Date().toISOString(),id=randomUUID();
  const next=path.join(sessions,`${timestamp.replace(/[:.]/g,'-')}_${id}.jsonl`);
  const nextHeader={...header,id,timestamp,cwd:localWorkingDirectory(config,header.cwd),parentSession:file};
  beforeWrite(next);
  writePrivateFileSync(next,[nextHeader,...branch].map(item=>JSON.stringify(item)).join('\n')+'\n');
  return next;
}
