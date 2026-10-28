import fs from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {portableSettings} from './portable.mjs';

export function createLocalLog(dataDir,options=portableSettings){
  const dir=path.join(dataDir,'logs'),file=path.join(dir,'service.log');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  let size=fs.existsSync(file)?fs.statSync(file).size:0;
  function rotate(){
    for(let i=options.logKeepFiles-1;i>=1;i--){
      const previous=path.join(dir,'service.log.'+i),next=path.join(dir,'service.log.'+(i+1));
      if(i===options.logKeepFiles-1)fs.rmSync(next,{force:true});
      if(fs.existsSync(previous))fs.renameSync(previous,next);
    }
    if(fs.existsSync(file))fs.renameSync(file,file+'.1');
    size=0;
  }
  return chunk=>{
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    size=fs.existsSync(file)?fs.statSync(file).size:0;
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk));
    // Bound even a single oversized Pi/tool record without retaining it in memory.
    for(let offset=0;offset<data.length;){
      if(size>=options.logMaxBytes)rotate();
      const part=data.subarray(offset,offset+options.logMaxBytes-size);
      fs.appendFileSync(file,part,{mode:0o600});size+=part.length;offset+=part.length;
    }
  };
}
export function redirectLogs(dataDir){
  const append=createLocalLog(dataDir);
  const original=process.stderr.write.bind(process.stderr);
  const write=(chunk,encoding,callback)=>{
    if(typeof encoding==='function')callback=encoding;
    try{append(Buffer.isBuffer(chunk)?chunk:Buffer.from(String(chunk),typeof encoding==='string'?encoding:'utf8'));callback?.();return true;}
    catch(error){original('Failed to write the local log: '+error.message+'\n');process.exitCode=1;throw error;}
  };
  process.stdout.write=write;process.stderr.write=write;
}
export async function followLogs(dataDir,{signal,print=chunk=>process.stdout.write(chunk),pollMs=portableSettings.logPollMs}={}){
  const file=path.join(dataDir,'logs/service.log');let inode,position=0,decoder=new StringDecoder('utf8');
  while(!signal?.aborted){
    let fd;
    try{
      fd=fs.openSync(file,'r');const stat=fs.fstatSync(fd);
      if(inode!==stat.ino||position>stat.size){inode=stat.ino;position=0;decoder=new StringDecoder('utf8');}
      const buffer=Buffer.alloc(65536);
      while(position<stat.size){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,stat.size-position),position);if(!count)break;position+=count;print(decoder.write(buffer.subarray(0,count)));}
    }catch(error){if(error.code!=='ENOENT')throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
    await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,pollMs);signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
    });
  }
}
