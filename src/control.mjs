import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import {copy} from './copy.mjs';

export const socketFile=config=>path.join(config.dataDir,'control.sock');
export function requestControl(config,command) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(socketFile(config));let buffer='';
    const finish=(error,value)=>{socket.destroy();error?reject(error):resolve(value);};
    socket.setTimeout(config.controlTimeoutMs,()=>finish(new Error(copy.control.timeout)));
    socket.once('error',()=>finish(new Error(copy.control.unavailable)));
    socket.once('connect',()=>socket.write(JSON.stringify({command})+'\n'));
    socket.setEncoding('utf8');
    socket.on('data',data=>{buffer+=data;if(buffer.length>config.maxRecordBytes)return finish(new Error(copy.control.tooLarge));const end=buffer.indexOf('\n');if(end<0)return;try{const result=JSON.parse(buffer.slice(0,end));result.error?finish(new Error(result.error)):finish(null,result);}catch(error){finish(error);}});
    socket.once('end',()=>{if(!socket.destroyed)finish(new Error(copy.control.truncated));});
  });
}
export async function serveControl(config,handler) {
  const file=socketFile(config);

  if(fs.existsSync(file)){if(!fs.lstatSync(file).isSocket())throw new Error(copy.control.pathBusy);fs.unlinkSync(file);}
  const clients=new Set();
  const server=net.createServer(socket=>{
    clients.add(socket);socket.once('close',()=>clients.delete(socket));let buffer='',handled=false;
    socket.setEncoding('utf8');socket.setTimeout(config.controlTimeoutMs,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('data',async data=>{
      if(handled)return;buffer+=data;
      if(buffer.length>config.maxRecordBytes){socket.destroy();return;}
      if(!buffer.includes('\n'))return;handled=true;
      try{const request=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));const result=await handler(request.command,request);socket.end(JSON.stringify(result)+'\n');}
      catch(error){socket.end(JSON.stringify({error:error.message})+'\n');}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(file,resolve);});
  fs.chmodSync(file,0o600);
  return async()=>{for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));};
}
