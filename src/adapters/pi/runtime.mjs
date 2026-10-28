import {copy} from '../../copy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkNodeVersion,privateDirectory} from '../../config.mjs';
import {installRoot,inside} from '../../portable.mjs';
import {writePrivateFileSync} from '../../../vendor/weixin/engine/secure-file.js';

export function configure(config) {
  const next={...config};
  delete next.piVersion;
  next.piCommand=path.join(installRoot,'runtime/bin/pi');
  return next;
}
export function checkRuntime(config) {
  checkNodeVersion();
  if(config.cwd===path.join(path.dirname(config.dataDir),'workspace'))privateDirectory(config.cwd);
  if(!fs.statSync(config.cwd).isDirectory())throw new Error(copy.adapter.cwdMissing);
  fs.accessSync(config.cwd,fs.constants.R_OK|fs.constants.X_OK);
  const command=path.join(installRoot,'runtime/bin/pi');
  fs.accessSync(command,fs.constants.X_OK);
  const version=execFileSync(command,['--version'],{encoding:'utf8',timeout:config.runtimeTimeoutMs}).trim();
  return {command,node:path.join(installRoot,'runtime/bin/node'),label:'Pi Agent',version};
}

export function preparePi(project=installRoot){
  const dir=path.join(project,'data/pi');
  inside(dir,project);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'settings.json');inside(file,project);
  const settings=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const next={...settings,shellPath:path.join(project,'runtime/bin/bash'),enableInstallTelemetry:false};
  if(JSON.stringify(settings)!==JSON.stringify(next))writePrivateFileSync(file,JSON.stringify(next,null,2)+'\n');
}
