import QRCode from 'qrcode';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {loadConfig,serviceName} from './config.mjs';
import {install,uninstall,systemctl} from './deploy.mjs';
import {requirePortable,installRoot} from './portable.mjs';
import {followLogs} from './local-logs.mjs';
import {loadAdapter} from './adapters/index.mjs';
import {verifyBundle} from './verify-bundle.mjs';
import {requestControl} from './control.mjs';
import {copy} from './copy.mjs';
import {application} from './release.mjs';

export async function login(config,{request=requestControl,print=console.log,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  let previous='',lastStatus='';
  print(copy.cli.scanHint);
  while(true){
    const state=await request(config,'login');
    if(state.loggedIn){print(copy.cli.loginOk);return;}
    if(state.loginUrl&&state.loginUrl!==previous){
      print(previous?copy.cli.qrRefreshed:copy.cli.qrScan);
      print(await QRCode.toString(state.loginUrl,{type:'terminal',small:true}));
      print(copy.cli.qrLink+state.loginUrl);previous=state.loginUrl;
    }
    if(state.status!==lastStatus){print(copy.cli.status(state.status));lastStatus=state.status;}
    await sleep(config.loginPollMs);
  }
}
async function ready(config) {
  const deadline=Date.now()+config.controlTimeoutMs;
  while(true){
    try{return await requestControl(config,'status');}
    catch(error){if(Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,config.loginPollMs));}
  }
}
export async function main(command) {
  process.umask(0o077);
  requirePortable();
  if(['version','--version','-v'].includes(command)){console.log('Xiaolin ('+application.name+') '+application.version);return;}
  if(command==='help'){
    console.log('Xiaolin ('+application.name+') '+application.version+'\nShow version: ./xltx version\nInstall and start: ./xltx setup\nScan to log in: ./xltx login\nShow status: ./xltx status\nShow logs: ./xltx logs\nStart / stop / restart: ./xltx start|stop|restart\nCheck environment: ./xltx check\nVerify bundle: ./xltx verify\nConfigure model: ./xltx pi\nLog out of WeChat: ./xltx logout\nRemove the background service: ./xltx uninstall');return;
  }
  if(command==='verify'){console.log('Bundle verified: '+verifyBundle(installRoot)+' files.');return;}
  if(command==='check'){
    const config=loadConfig(),adapter=await loadAdapter(config),{label,version}=adapter.checkRuntime();
    console.log(copy.main.check(label,version,config.cwd));return;
  }
  if(command==='uninstall'){uninstall();console.log('The background service was removed. The data is still in the install directory, so you can delete the whole folder directly.');return;}
  if(command==='setup'){
    const result=await install();
    await ready(loadConfig(result.configFile));
    console.log(copy.cli.installed(result.configFile,result.dataDir));
    const linger=execFileSync('/usr/bin/loginctl',['show-user',String(process.getuid()),'-p','Linger','--value'],{encoding:'utf8',timeout:10000,env:{...process.env,LD_LIBRARY_PATH:undefined}}).trim();
    if(linger!=='yes')console.log(copy.cli.linger(process.getuid()));
    return;
  }
  if(['start','stop','restart'].includes(command)){
    systemctl([command,serviceName]);if(command!=='stop')await ready(loadConfig());console.log({start:copy.cli.started,stop:copy.cli.stopped,restart:copy.cli.restarted}[command]);return;
  }
  if(command==='logs'){
    const controller=new AbortController();
    const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    try{await followLogs(loadConfig().dataDir,{signal:controller.signal});}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}return;
  }
  const config=loadConfig();
  if(command==='login')return login(config);
  if(command==='logout'){console.log((await requestControl(config,'logout')).status);return;}
  if(command==='status'){
    const state=systemctl(['is-active',serviceName],{allowFailure:true}).trim()||'inactive';
    const active=copy.serviceState(state);
    console.log([copy.cli.serviceStatus(active),copy.cli.serviceConfig(config.configFile),copy.cli.serviceData(config.dataDir)].join('\n'));
    if(state==='active'){
      const running=await requestControl(config,'status');
      console.log([copy.cli.status(running.status),copy.cli.cwd(running.cwd),copy.cli.taskText(running.streaming,running.running)].join('\n'));
      if(running.error)console.log(copy.cli.connectionInfo(running.error));
    }
    return;
  }
  throw new Error(copy.cli.unknownCommand(command));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await main(process.argv[2]);}catch(error){if(error.signal==='SIGINT'){process.exitCode=130;}else{console.error(error.message);process.exitCode=1;}}
}
