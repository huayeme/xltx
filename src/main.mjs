import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {createWeixinBridge} from './bridge.mjs';
import {loadAdapter} from './adapters/index.mjs';
import {createCommandLayer,commandPolicy,parseCommand} from './commands.mjs';
import {loadConfig,checkNodeVersion,privateDirectory,root} from './config.mjs';
import {serveControl} from './control.mjs';
import {copy} from './copy.mjs';
import {msg,seedMessages} from './messages.mjs';
import {createRetention} from './retention.mjs';
import {requirePortable} from './portable.mjs';
import {createTaskScheduler} from './extensions/schedule/scheduler.mjs';
import {createTaskRunner} from './tasks-runner.mjs';

process.umask(0o077);
requirePortable();
const config=loadConfig();
checkNodeVersion();
const adapter=await loadAdapter(config);
if(process.argv.includes('--check')){const {label,version}=adapter.checkRuntime();console.log(copy.main.check(label,version,config.cwd));process.exit(0);}
privateDirectory(config.dataDir);
config.dataDir=fs.realpathSync(config.dataDir);
seedMessages(config.dataDir);

const lock=net.createServer(socket=>socket.destroy());
await new Promise((resolve,reject)=>{lock.once('error',reject);lock.listen('\0xltx-'+createHash('sha256').update(config.dataDir).digest('hex'),resolve);});
const log=(...items)=>console.error(new Date().toISOString(),...items);
let backend=adapter.create({log});
const handleMessage=createCommandLayer(()=>{if(backend.closed)backend=adapter.create({log});return backend;});
const decorate=answer=>{const notice=backend.pendingNotice();if(!notice)return {answer};return {answer:{...(answer||{}),text:[notice,answer?.text].filter(Boolean).join('\n')},done:()=>backend.clearNotice()};};
let bridge,stopping=false,timer,checkTimer,checking=false,cleaning=false,closeControl,maintenance;
const retention=createRetention({dataDir:config.dataDir,...config.retention});
bridge=createWeixinBridge({dir:path.join(config.dataDir,'weixin'),defaultCwd:config.cwd,log,textLimit:config.textLimit,retryMs:config.healthIntervalMs,
  onAccountChanged:()=>backend.resetSession(),
  classifyMessage:message=>{const policy=commandPolicy(message);return {...policy,immediate:policy.immediate||!!backend.awaitingInput&&!parseCommand(message)};},
  decorate,
  resolveReference:id=>backend.reference(id),
  referenceProtection:reference=>backend.referenceProtection(reference),
  referenceExists:reference=>backend.referenceExists(reference),
  async onMessage(message,publish,beforeSubmit){
    if(maintenance)await maintenance;
    return handleMessage(message,publish,beforeSubmit);
  },
});
const taskRunner=createTaskRunner({config,root,log});
const tasks=createTaskScheduler({
  directory:config.dataDir,
  execute:taskRunner,
  notify:async ({task,run})=>{
    if(run.status!=='success'&&!task.notifyFailure)return;
    const text=run.status==='success'
      ? msg('task.success',task.name,run.result||msg('task.empty'))
      : msg('task.failed',task.name,run.error||'');
    await bridge.notify(text);
  },
});
async function health(){
  if(checking||stopping)return;checking=true;
  try {
    const state=await bridge.status();
    if(state.enabled&&state.failed)await bridge.restore();
  } catch(error){log('[health]',error.message);}finally{checking=false;}
}
function protection(){
  const parts=[backend.protection(),bridge.protection()];
  return {files:parts.flatMap(item=>item.files),dirs:parts.flatMap(item=>item.dirs),ids:parts.flatMap(item=>item.ids)};
}
async function maintain(){
  if(cleaning||stopping||changingLogin||tasks.isRunning())return;cleaning=true;
  try {
    const stores=()=>[bridge.retentionStore(),backend.retentionStore()];
    const plan=retention.plan(stores(),protection());
    if(!plan.selected.length){
      if(plan.total>config.retention.maxBytes)log('[retention]',plan.fixed>config.retention.maxBytes?'Retained credentials and settings exceed the data limit':'Cleanup deferred while data is in use');
      return;
    }
    maintenance=(async()=>{
      try{
        await bridge.prepareCleanup();
        if(stopping||changingLogin)return;
        if(plan.candidates.some(item=>item.file===backend.status().sessionFile))await backend.releaseSession();
        if(stopping||changingLogin)return;
        const next=retention.plan(stores(),protection());
        if(next.files.includes(backend.status().sessionFile)&&backend.status().running)return;
        let result;
        try{result=retention.apply(next,file=>backend.detachSession(file));}finally{backend.forgetMissingSession();}
        if(result.deferred)log('[retention]','Cleanup deferred while data is in use');
      }finally{bridge.finishCleanup();}
    })();
    try{await maintenance;}finally{maintenance=undefined;}
  } catch(error){log('[retention]',error.message);}
  finally{cleaning=false;}
}
async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(timer);clearInterval(checkTimer);
  try {await maintenance;await closeControl?.();await tasks.close();await Promise.all([bridge.close(),backend.close()]);}
  catch(error){log('[shutdown]',error.message);}
  finally {lock.close();}
}
process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
process.on('uncaughtException',error=>{log('[fatal]',error.message);backend.kill();process.exit(1);});
process.on('unhandledRejection',error=>{log('[fatal]',error?.message||String(error));backend.kill();process.exit(1);});
let changingLogin=false;
closeControl=await serveControl(config,async (command,request)=>{
  if(command==='schedule'){
    const action=request?.action;
    if(action==='create')return {result:tasks.create(request)};
    if(action==='edit')return {result:tasks.edit(request.id,request)};
    if(action==='list')return {result:tasks.list()};
    if(action==='runs')return {result:tasks.runs(request)};
    if(action==='run_detail'){
      if(typeof request.runId!=='string'||!request.runId)throw new Error('Please provide a run id (runId).');
      const result=tasks.runDetail(request.runId);
      if(!result)throw new Error('The run record does not exist.');
      return {result};
    }
    if(action==='pause'||action==='resume'||action==='delete')return {result:tasks.update(request.id,action)};
    if(action==='run')return {result:tasks.launch(request.id)};
    if(action==='stop')return {result:tasks.stopRun(request.runId)};
    if(action==='retry')return {result:tasks.retry(request.runId)};
    if(action==='emit')return {result:await tasks.emit(request.event,request.payload)};
    throw new Error(copy.main.unknownCommand);
  }
  if(!['status','login','logout'].includes(command))throw new Error(copy.main.unknownCommand);
  if(command==='status')return {...await bridge.status(),...backend.status(),dataDir:config.dataDir};
  if(maintenance)await maintenance;
  if(changingLogin)throw new Error(copy.main.switching);
  changingLogin=true;
  try{
    if(command==='logout'){
      await bridge.configure({action:'logout'});await backend.close();
      fs.rmSync(path.join(config.dataDir,'login.png'),{force:true});
      return {status:copy.main.loggedOut};
    }
    if(!(await bridge.status()).enabled)await bridge.configure({action:'connect'});
    return {...await bridge.status(),loginUrl:bridge.loginUrl()};
  }finally{changingLogin=false;}
});
await bridge.restore();
tasks.start();
timer=setInterval(()=>void health(),config.healthIntervalMs);
checkTimer=setInterval(()=>void maintain(),config.retention.checkIntervalMs);
log('[service] Started; Weixin:',(await bridge.status()).state);
await health();
