import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {writePrivateFileSync} from '../vendor/weixin/engine/secure-file.js';
import {root,locations,loadConfig,secureTree,serviceName,privateDirectory} from './config.mjs';
import {loadAdapter} from './adapters/index.mjs';
import {requirePortable,portableSettings} from './portable.mjs';
import {copy} from './copy.mjs';
import {seedMessages} from './messages.mjs';

export function unitQuote(value,{exec=false}={}) {
  if(/[\0\r\n]/.test(value))throw new Error(copy.deploy.badPath);
  return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=>exec?'$$':'$')+'"';
}
export function renderUnit({project}) {
  unitQuote(project); // Validate newlines/NUL; WorkingDirectory itself is not shell-quoted.
  const launcher=path.join(project,'xltx');
  return `[Unit]\nDescription=Xiaolin Tongxue service\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=60\nStartLimitBurst=10\n\n[Service]\nType=simple\nWorkingDirectory=${project.replaceAll('%','%%')}\nExecStart=${unitQuote(launcher)} run\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\nUMask=0077\nLimitCORE=0\nStandardInput=null\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`;
}
const atomic=writePrivateFileSync;
// SYSTEM.md ships beside config.json as the persona template. Setup seeds it
// once: an existing data/pi/SYSTEM.md is the user's own prompt and is kept.
function seedPersona(project,dataDir) {
  const source=path.join(project,'SYSTEM.md'),target=path.join(dataDir,'pi','SYSTEM.md');
  if(!fs.existsSync(source)||fs.existsSync(target))return;
  privateDirectory(path.dirname(target));
  atomic(target,fs.readFileSync(source,'utf8'));
}
// The launcher redirects XDG_RUNTIME_DIR into data/run for the agent runtime,
// but systemctl must reach the real user manager at /run/user/<uid>. Without
// that, `systemctl --user` fails with "Failed to connect to user scope bus".
function hostEnvironment(){
  const {LD_LIBRARY_PATH:_,...env}=process.env;
  const uid=process.getuid?.(),runtime=uid===undefined?undefined:`/run/user/${uid}`;
  if(runtime&&fs.existsSync(runtime))env.XDG_RUNTIME_DIR=runtime;
  return env;
}
function hostCommand(name,args,options={}){
  return execFileSync('/usr/bin/'+name,args,{encoding:'utf8',timeout:portableSettings.commandTimeoutMs,stdio:['ignore','pipe','pipe'],env:hostEnvironment(),...options});
}
export function systemctl(args,{allowFailure=false}={}) {
  try{return hostCommand('systemctl',['--user',...args]);}
  catch(error){if(allowFailure&&error.stdout?.toString().trim())return error.stdout.toString();throw new Error((error.stderr?.toString()||error.message).trim());}
}
export function verifyUnit(unit,dataDir) {
  const dir=fs.mkdtempSync(path.join(dataDir,'.unit-check-'));
  try{const file=path.join(dir,serviceName);atomic(file,unit);hostCommand('systemd-analyze',['--user','verify',file]);}
  catch(error){throw new Error(copy.deploy.unitCheck((error.stderr?.toString()||error.message).trim()));}
  finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function ensureOwnService(unitFile,project){
  if(!fs.existsSync(unitFile))return;
  const unit=fs.readFileSync(unitFile,'utf8');
  if(!unit.includes(unitQuote(path.join(project,'xltx')))&&!unit.includes(unitQuote(path.join(project,'src/main.mjs'),{exec:true})))throw new Error('Another install already occupies this service. Uninstall the service from the original install directory first.');
}
export async function install({project=root,env=process.env,run=systemctl}={}) {
  if(process.getuid()===0)throw new Error(copy.deploy.notRoot);
  project=fs.realpathSync(project);requirePortable(project);
  const places=locations(env,undefined,project),config=loadConfig(env.WEIXIN_CONFIG,env,project),adapter=await loadAdapter(config);
  adapter.checkRuntime();
  const unit=renderUnit({project});
  secureTree(config.dataDir);verifyUnit(unit,config.dataDir);
  seedPersona(project,config.dataDir);
  seedMessages(config.dataDir);
  ensureOwnService(places.unitFile,project);
  fs.mkdirSync(path.dirname(places.unitFile),{recursive:true,mode:0o700});
  run(['show-environment']);
  const loaded=run(['show',serviceName,'--property=LoadState','--value'],{allowFailure:true}).trim();
  if(loaded&&!['not-found','bad-setting','error'].includes(loaded))run(['stop',serviceName]);
  try {
    const stored={...config,cwd:path.relative(project,config.cwd)||'.',piCommand:'./runtime/bin/pi'};
    delete stored.configFile;delete stored.dataDir;
    atomic(places.configFile,JSON.stringify(stored,null,2)+'\n');
    atomic(places.unitFile,unit);
    run(['daemon-reload']);run(['enable',serviceName]);run(['restart',serviceName]);
    if(run(['is-active',serviceName]).trim()!=='active')throw new Error(copy.deploy.notActive);
  }catch(error){throw new Error(copy.deploy.installFailed(error.message));}
  return {configFile:places.configFile,dataDir:places.dataDir,unitFile:places.unitFile};
}
export function uninstall({project=root,env=process.env,run=systemctl}={}){
  project=fs.realpathSync(project);
  const {unitFile}=locations(env,undefined,project);ensureOwnService(unitFile,project);
  if(!fs.existsSync(unitFile))return;
  run(['stop',serviceName]);run(['reset-failed',serviceName]);run(['disable',serviceName]);fs.unlinkSync(unitFile);
  run(['daemon-reload']);
}
