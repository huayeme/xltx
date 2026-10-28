import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {copy} from './copy.mjs';

export const root=fileURLToPath(new URL('../',import.meta.url));
export const serviceName='xltx.service';

const unixSocketMaxBytes=107;
export function checkDataPath(dir) {
  if(Buffer.byteLength(path.join(dir,'control.sock'))>unixSocketMaxBytes)throw new Error(copy.config.dataPathLong);
}
export function checkNodeVersion(current=process.versions.node) {
  const required=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).engines.node.slice(2);
  const actual=current.split('.').map(Number),minimum=required.split('.').map(Number);
  for(let i=0;i<minimum.length;i++){if(actual[i]>minimum[i])return;if(actual[i]<minimum[i])throw new Error(copy.config.nodeOld(required,current));}
}
export function expand(value,base=process.cwd(),home=os.homedir()) {
  if(typeof value!=='string'||!value||/[\0\r\n]/.test(value))throw new Error(copy.config.invalidPath);
  return path.resolve(base,value==='~'?home:value.startsWith('~/')?path.join(home,value.slice(2)):value);
}
export function locations(env=process.env,home,project=root) {
  const hostHome=home||os.userInfo().homedir;
  const hostConfig=env.WEIXIN_HOST_CONFIG_HOME||(!env.WEIXIN_ROOT&&env.XDG_CONFIG_HOME);
  const base=hostConfig?expand(hostConfig,hostHome,hostHome):path.join(hostHome,'.config');
  const dataDir=path.join(fs.realpathSync(project),'data');
  return {configFile:path.join(dataDir,'config.json'),unitFile:path.join(base,'systemd','user',serviceName),dataDir};
}
export function loadConfig(file=process.env.WEIXIN_CONFIG,env=process.env,project=root) {
  const defaults=locations(env,undefined,project);
  if(file&&path.resolve(file)!==defaults.configFile)throw new Error(copy.config.configLocation);
  const source=fs.existsSync(defaults.configFile)?defaults.configFile:path.join(project,'config.json');
  if(fs.lstatSync(source).isSymbolicLink())throw new Error(copy.config.configSymlink);
  if(fs.existsSync(defaults.dataDir))secureTree(defaults.dataDir);
  const config=JSON.parse(fs.readFileSync(source,'utf8'));
  if(config.dataDir&&expand(config.dataDir,project)!==defaults.dataDir)throw new Error(copy.config.dataLocation);
  config.dataDir=defaults.dataDir;
  config.cwd=expand(config.cwd,project);
  if(config.piCommand&&config.piCommand!=='pi'&&config.piCommand!=='./runtime/bin/pi')throw new Error('Please use the Pi bundled in the install directory.');
  config.piCommand='./runtime/bin/pi';
  checkDataPath(config.dataDir);
  for(const key of ['runtimeTimeoutMs','shutdownTimeoutMs','maxRecordBytes','textLimit','healthIntervalMs','controlTimeoutMs','loginPollMs']){
    if(!Number.isSafeInteger(config[key])||config[key]<=0)throw new Error(copy.config.configInvalid(key));
  }
  const template=JSON.parse(fs.readFileSync(path.join(project,'config.json'),'utf8'));
  config.retention={...template.retention,...config.retention};
  for(const [key,value] of Object.entries(config.retention))if(!Number.isSafeInteger(value)||value<=0)throw new Error(copy.config.configInvalid('retention.'+key));
  config.rpc={...template.rpc,...config.rpc};
  delete config.tui;
  for(const [key,value] of Object.entries(config.rpc))if(!Number.isSafeInteger(value)||value<=0)throw new Error(copy.config.configInvalid('rpc.'+key));
  config.configFile=defaults.configFile;return config;
}
export function executable(command,env=process.env) {
  const candidates=command.includes('/')?[command]:(env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,command));
  for(const file of candidates){try{fs.accessSync(file,fs.constants.X_OK);if(fs.statSync(file).isFile())return path.resolve(file);}catch{}}
  throw new Error(copy.config.notExecutable(command));
}
export function privateDirectory(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw new Error(copy.config.dirOwnership(dir));
  fs.chmodSync(dir,0o700);fs.accessSync(dir,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
}
export function secureTree(dir) {
  privateDirectory(dir);
  for(const name of fs.readdirSync(dir)){
    const file=path.join(dir,name),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink()||stat.uid!==process.getuid())throw new Error(copy.config.symlinkInData(file));
    if(stat.isDirectory()){if(name.startsWith('browser-profile'))continue;secureTree(file);}
    else if(stat.isFile())fs.chmodSync(file,0o600);
    else if(!stat.isSocket())throw new Error(copy.config.unsupportedType(file));
  }
}
