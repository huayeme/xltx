import {msg} from '../../messages.mjs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export class RpcConnection {
  constructor(command,args,{cwd,env=process.env,maxRecordBytes,timeoutMs,log,onEvent,onExit}) {
    this.pending=new Map();this.timeoutMs=timeoutMs;this.maxRecordBytes=maxRecordBytes;this.ended=false;
    this.child=spawn(command,args,{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    let buffer='',stderr='';
    const fail=error=>{for(const request of this.pending.values())request.finish(error);};
    this.child.stdin.on('error',error=>fail(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',data=>{stderr=(stderr+data).slice(-maxRecordBytes);log('[pi-rpc]',data.trim());});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',data=>{
      buffer+=data;
      try {
        let end;
        while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);
          if(Buffer.byteLength(line)>maxRecordBytes)throw new Error(msg('rpc.responseTooLarge'));
          if(!line)continue;
          const record=JSON.parse(line);
          if(record.type==='response'){
            const request=this.pending.get(record.id);
            if(request){
              if(record.success)request.finish(null,record.data);
              else {const error=new Error(record.error||msg('rpc.rejected'));error.rpcRejected=true;request.finish(error);}
            }
          } else onEvent(record);
        }
        if(Buffer.byteLength(buffer)>maxRecordBytes)throw new Error(msg('rpc.responseTooLarge'));
      } catch(error){fail(error);this.kill();}
    });
    this.exited=new Promise(resolve=>{
      let spawnError;
      this.child.once('error',error=>{spawnError=error;fail(error);});
      this.child.once('close',(code,signal)=>{
        this.ended=true;
        const error=spawnError||new Error(msg('rpc.exited',signal||code,stderr?': '+stderr:''));
        fail(error);onExit(error);resolve();
      });
    });
  }
  write(record,beforeSubmit=()=>{}) {
    if(this.ended||this.child.stdin.destroyed)throw new Error(msg('rpc.connectionClosed'));
    const line=JSON.stringify(record)+'\n';
    if(Buffer.byteLength(line)>this.maxRecordBytes)throw new Error(msg('rpc.inputTooLarge'));
    beforeSubmit();
    return new Promise((resolve,reject)=>this.child.stdin.write(line,error=>error?reject(error):resolve()));
  }
  request(type,fields={},beforeSubmit=()=>{},timeoutMs=this.timeoutMs) {
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=timeoutMs>0?setTimeout(()=>{finish(new Error(msg('rpc.controlTimeout')));this.kill();},timeoutMs):undefined;
      const finish=(error,value)=>{if(!this.pending.delete(id))return;if(timer)clearTimeout(timer);error?reject(error):resolve(value);};
      this.pending.set(id,{finish});
      try {void this.write({id,type,...fields},beforeSubmit).catch(error=>finish(error));}
      catch(error){finish(error);}
    });
  }
  kill(){if(this.ended)return;try{process.kill(-this.child.pid,'SIGKILL');}catch{this.child.kill('SIGKILL');}}
  async terminate(timeoutMs) {
    if(this.ended)return;
    try{process.kill(-this.child.pid,'SIGTERM');}catch{this.child.kill('SIGTERM');}
    const timer=setTimeout(()=>this.kill(),timeoutMs);
    try{await this.exited;}finally{clearTimeout(timer);}
  }
  async close(timeoutMs) {
    if(this.ended)return;
    this.child.stdin.end();
    const timer=setTimeout(()=>this.kill(),timeoutMs);
    try{await this.exited;}finally{clearTimeout(timer);}
  }
}
