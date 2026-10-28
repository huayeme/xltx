import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateDirectory} from '../../config.mjs';
import {writePrivateFileSync} from '../../../vendor/weixin/engine/secure-file.js';
import {checkRuntime} from './runtime.mjs';
import {createBranch,referenceProtection,referenceExists,sessionPath,storedSessionPath,prepareSession} from './history.mjs';
import {RpcConnection} from './rpc-client.mjs';
import {copy} from '../../copy.mjs';
import {msg,words} from '../../messages.mjs';

const verboseModes=new Set(['on','off','nothinking','notools']);
const verboseDone={on:'command.verboseOn',off:'command.verboseOff',nothinking:'command.verboseNoThinking',notools:'command.verboseNoTools'};
const commandError=message=>Object.assign(new Error(message),{commandResult:true});
const textOf=content=>typeof content==='string'?content:(content||[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
export class PiRpc {
  constructor(config,{log=console.error}={}) {
    this.config=config;this.log=log;this.closed=false;this.connection=null;this.starting=null;this.stopping=null;
    this.epoch=0;this.queue=Promise.resolve();this.events=Promise.resolve();this.replies=Promise.resolve();this.publisher=null;this.inputs=[];this.dialogs=[];
    this.stateFile=path.join(config.dataDir,'rpc-state.json');
    const legacy=path.join(config.dataDir,'tui-state.json');
    const source=fs.existsSync(this.stateFile)?this.stateFile:legacy;
    this.saved=fs.existsSync(source)?JSON.parse(fs.readFileSync(source,'utf8')):{};
    if(this.saved.sessionFile)this.saved.sessionFile=sessionPath(config,this.saved.sessionFile);
    if(this.saved.cwd)this.saved.cwd=config.cwd;
    this.streaming=false;this.compacting=false;this.lastReference=undefined;this.jobs=0;this.eventJobs=0;this.notice='';this.attachments=new Set();this.protected=new Set();this.protectedIds=new Set();
  }
  status(){return {running:!!this.connection&&!this.connection.ended,streaming:this.streaming,cwd:this.saved.cwd||this.config.cwd,sessionFile:this.saved.sessionFile||''};}
  save(state){
    this.saved={verbose:this.saved.verbose,preferences:{model:state.model?{provider:state.model.provider,id:state.model.id}:this.saved.preferences?.model,thinkingLevel:state.thinkingLevel??this.saved.preferences?.thinkingLevel},sessionFile:state.sessionFile,sessionId:state.sessionId,cwd:this.config.cwd,persisted:!!state.sessionFile&&fs.existsSync(state.sessionFile)};
    this.persistSaved(this.saved);
  }
  persistSaved(state){
    const stored={...state,sessionFile:storedSessionPath(this.config,state.sessionFile),cwd:state.cwd?path.relative(path.dirname(this.config.dataDir),this.config.cwd):undefined};
    writePrivateFileSync(this.stateFile,JSON.stringify(stored)+'\n');this.saved=state;
  }
  referenceProtection(reference){return referenceProtection(reference,this.config);}
  referenceExists(reference){return referenceExists(reference,this.config);}
  reference(sourceId){
    const file=path.join(this.config.dataDir,'input-references.json');
    return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8'))[sourceId]:undefined;
  }
  async ensure(){
    if(this.stopping)await this.stopping;
    if(this.closed)throw new Error(msg('rpc.closed'));
    if(this.starting)return this.starting;
    if(this.connection&&!this.connection.ended)return;
    this.starting=this.start();
    try{await this.starting;}finally{this.starting=null;}
  }
  async start(){
    privateDirectory(this.config.dataDir);
    const sessions=path.join(this.config.dataDir,'sessions');privateDirectory(sessions);
    let runtime;
    try{runtime=checkRuntime(this.config);}catch(error){throw new Error(msg('rpc.startFailed',error.message));}
    if(this.saved.persisted&&!fs.existsSync(this.saved.sessionFile))throw new Error(msg('rpc.sessionMissing'));
    const args=['--mode','rpc','--session-dir',sessions];
    const resuming=!!this.saved.sessionFile&&fs.existsSync(this.saved.sessionFile);
    if(resuming){prepareSession(this.config,this.saved.sessionFile);args.push('--session',this.saved.sessionFile);}
    else args.push('--session-id',this.saved.sessionId||randomUUID());
    const epoch=this.epoch;
    const connection=new RpcConnection(runtime.command,args,{cwd:this.config.cwd,maxRecordBytes:this.config.maxRecordBytes,timeoutMs:this.config.runtimeTimeoutMs,log:this.log,
      onEvent:event=>this.receive(event,connection,epoch),
      onExit:error=>{
        if(this.connection!==connection)return;
        this.streaming=false;this.compacting=false;this.inputs=[];this.attachments.clear();this.protected.clear();this.protectedIds.clear();this.clearDialogs();
        if(epoch===this.epoch&&!this.closed)this.enqueue(async()=>{await this.publish({text:msg('rpc.reconnect',error.message)},this.publisher,epoch);});
      },
    });
    this.connection=connection;
    try{
      const failures=[];
      if(!resuming&&this.saved.preferences){
        const {model,thinkingLevel}=this.saved.preferences;
        if(model)await connection.request('set_model',{provider:model.provider,modelId:model.id}).catch(error=>failures.push(model.provider+'/'+model.id+' ('+error.message+')'));
        if(thinkingLevel)await connection.request('set_thinking_level',{level:thinkingLevel}).catch(error=>failures.push(thinkingLevel+' ('+error.message+')'));
      }
      const state=await connection.request('get_state',{},()=>{},this.config.rpc.startTimeoutMs);
      this.save(state);
      if(failures.length)this.notice=msg('preference.failed',failures.join('; '),state.model?state.model.provider+'/'+state.model.id:msg('session.modelUnset'),state.thinkingLevel||msg('preference.none'));
    }
    catch(error){connection.kill();await connection.exited;throw error;}
  }
  enqueue(operation){
    this.eventJobs++;
    this.events=this.events.then(operation).catch(error=>this.log('[pi-rpc-event]',error.message)).finally(()=>this.eventJobs--);
  }
  async publish(answer,publisher,epoch){if(!this.closed&&epoch===this.epoch&&publisher)await publisher(answer);}
  clearDialogs(){for(const dialog of this.dialogs)clearTimeout(dialog.timer);this.dialogs=[];}
  receive(event,connection,epoch){
    if(epoch!==this.epoch||connection!==this.connection)return;
    if(event.type==='agent_start')this.streaming=true;
    if(event.type==='agent_settled'){this.streaming=false;this.attachments.clear();}
    if(event.type==='compaction_start')this.compacting=true;
    if(event.type==='compaction_end')this.compacting=false;
    const publisher=this.publisher;
    if(event.type==='message_end'&&['user','assistant'].includes(event.message?.role)){
      const snapshot=Promise.all([connection.request('get_entries'),connection.request('get_state')]);
      void snapshot.catch(()=>{});
      const inputText=textOf(event.message.content);
      const source=event.message.role==='user'?this.inputs.find(input=>input.text===inputText||input.hasImages&&inputText.startsWith(input.text)):undefined;
      if(source)this.inputs=this.inputs.filter(input=>input!==source);
      this.enqueue(async()=>{
        let entries=[],state=this.saved;
        try{[{entries},state]=await snapshot;}catch(error){this.log('[pi-rpc-reference]',error.message);}
        if(epoch!==this.epoch)return;
        if(state!==this.saved)this.save(state);
        const entry=entries.findLast(item=>item.type==='message'&&item.message.role===event.message.role&&item.message.timestamp===event.message.timestamp&&JSON.stringify(item.message.content)===JSON.stringify(event.message.content));
        const reference=entry&&state.sessionFile?{sessionFile:storedSessionPath(this.config,state.sessionFile),entryId:entry.id}:undefined;
        if(reference)this.lastReference=reference;
        if(source&&reference){
          const file=path.join(this.config.dataDir,'input-references.json');
          const references=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
          references[source.sourceId]={...reference,createdAt:Date.now()};writePrivateFileSync(file,JSON.stringify(references)+'\n');
        }
        if(event.message.role==='assistant'){
          const parts=event.message.content||[];
          const text=parts.filter(part=>part.type==='text'||part.type==='thinking'&&!['off','nothinking'].includes(this.saved.verbose)).map(part=>part.type==='thinking'?part.thinking:part.text).filter(Boolean).join('\n');
          const files=parts.filter(part=>part.type==='image').map((part,index)=>({name:copy.result.imageName(index,part.mimeType==='image/jpeg'?'jpg':part.mimeType?.split('/')[1]||'png'),data:Buffer.from(part.data,'base64')}));
          const error=event.message.errorMessage;
          if(text||files.length||error)await this.publish({text:[text,error].filter(Boolean).join('\n'),files,reference},publisher,epoch);
        }
      });
    } else if(event.type==='tool_execution_start'){
      this.enqueue(()=>['off','notools'].includes(this.saved.verbose)?undefined:this.publish({text:event.toolName+'\n'+JSON.stringify(event.args),reference:this.lastReference},publisher,epoch));
    } else if(event.type==='tool_execution_end'){
      this.enqueue(()=>['off','notools'].includes(this.saved.verbose)?undefined:this.publish({text:[event.toolName,textOf(event.result?.content)].filter(Boolean).join('\n'),files:(event.result?.content||[]).filter(part=>part.type==='image').map((part,index)=>({name:copy.result.toolImageName(index,part.mimeType?.split('/')[1]||'png'),data:Buffer.from(part.data,'base64')})),reference:this.lastReference},publisher,epoch));
    } else if(event.type==='extension_ui_request'){
      if(['select','confirm','input','editor'].includes(event.method)){
        const dialog={...event};
        if(event.timeout)dialog.timer=setTimeout(()=>{this.dialogs=this.dialogs.filter(item=>item!==dialog);},event.timeout);
        this.dialogs.push(dialog);
        const instructions=event.method==='select'?(event.options||[]).map((option,index)=>`${index+1}. ${option}`).join('\n')+'\n'+msg('ask.selectHint'):event.method==='confirm'?msg('ask.confirmHint'):msg('ask.inputHint');
        this.enqueue(()=>this.publish({text:[event.title,event.message,event.prefill,instructions].filter(Boolean).join('\n')},publisher,epoch));
      } else {
        const text=event.message||event.statusText||event.widgetLines?.join('\n');
        if(text)this.enqueue(()=>this.publish({text},publisher,epoch));
      }
    } else if(event.type==='extension_error'||event.type==='auto_retry_start'||event.type==='auto_retry_end'&&event.finalError||event.type==='compaction_end'&&event.errorMessage){
      this.enqueue(()=>this.publish({text:event.error||event.errorMessage||event.finalError},publisher,epoch));
    }
  }
  operation(action,publish){
    const epoch=this.epoch;
    const operation=this.queue.then(async()=>{
      if(epoch!==this.epoch)throw new Error(msg('rpc.stopped'));
      this.publisher=publish;
      await this.ensure();
      if(epoch!==this.epoch)throw new Error(msg('rpc.stopped'));
      return action(this.connection,epoch);
    });
    this.jobs++;
    const tracked=operation.finally(()=>this.jobs--).then(value=>{this.protected.clear();this.protectedIds.clear();return value;},error=>{throw error;});
    this.queue=tracked.catch(()=>{});return tracked;
  }
  async reply(message,publish,beforeSubmit){
    this.publisher=publish;
    const connection=this.connection;
    if(message.media?.length)throw new Error(msg('ask.textOnly'));
    const dialog=this.dialogs[0],text=String(message.text||'').trim();
    if(!dialog)throw new Error(msg('ask.ended'));
    const response={type:'extension_ui_response',id:dialog.id};
    if(dialog.method==='confirm'){
      if(!words('ask.confirmAnswers').includes(text.toLowerCase()))throw new Error(msg('ask.confirm'));
      response.confirmed=words('ask.affirmativeAnswers').includes(text.toLowerCase());
    } else if(dialog.method==='select'){
      response.value=dialog.options?.includes(text)?text:dialog.options?.[Number(text)-1];
      if(!response.value)throw new Error(msg('ask.select'));
    } else response.value=String(message.text||'');
    await connection.write(response,beforeSubmit);clearTimeout(dialog.timer);this.dialogs=this.dialogs.filter(item=>item!==dialog);return {};
  }
  send(message,publish,beforeSubmit=()=>{}){
    if(this.dialogs.length){
      const epoch=this.epoch;
      const reply=this.replies.then(()=>{if(this.closed||epoch!==this.epoch)throw new Error(msg('ask.cancelled'));return this.reply(message,publish,beforeSubmit);});
      this.jobs++;
      const tracked=reply.finally(()=>this.jobs--);
      this.replies=tracked.catch(()=>{});return tracked;
    }
    return this.operation(async(connection,epoch)=>{
      this.publisher=publish;
      const images=[],attachments=[];
      for(const media of message.media||[]){
        let file=media.path;
        if(!file&&media.data){const dir=path.join(this.config.dataDir,'attachments');privateDirectory(dir);file=path.join(dir,randomUUID()+'-'+path.basename(media.name||'file'));fs.writeFileSync(file,media.data,{mode:0o600});}
        if(!file)throw new Error(msg('rpc.attachMissing'));
        this.attachments.add(file);
        const stat=fs.statSync(file);
        if(!stat.isFile())throw new Error(msg('rpc.attachMissing'));
        if(media.kind==='image')images.push({type:'image',data:fs.readFileSync(file).toString('base64'),mimeType:media.mediaType||'image/png'});
        else attachments.push(file);
      }
      const text=[message.quoteText?'Quoted content:\n'+message.quoteText:'',String(message.text||''),...attachments].filter(Boolean).join('\n');
      const source={sourceId:message.sourceId,text,hasImages:images.length>0};this.inputs.push(source);
      let result;
      try{result=await connection.request('prompt',{message:text,images,streamingBehavior:'steer'},beforeSubmit);}
      catch(error){this.inputs=this.inputs.filter(item=>item!==source);if(error.rpcRejected)error.notSubmitted=true;throw error;}
      if(result?.disposition==='handled')this.inputs=this.inputs.filter(item=>item!==source);
      if(epoch===this.epoch)this.save(await connection.request('get_state'));
      return {};
    },publish);
  }
  command(command,publish,beforeSubmit=()=>{}){
    if(command.name==='verbose'){
      const mode=this.saved.verbose||'on';
      if(command.argument==='status')return {text:msg('command.verboseStatus',mode,['off','nothinking'].includes(mode)?msg('command.verboseHidden'):msg('command.verboseShown'),['off','notools'].includes(mode)?msg('command.verboseHidden'):msg('command.verboseShown'))};
      if(!verboseModes.has(command.argument))return {text:msg('command.verboseUsage')};
      const next={...this.saved,verbose:command.argument};
      this.persistSaved(next);
      return {text:msg(verboseDone[command.argument])};
    }
    if(command.name==='fork'&&command.reference){
      for(const file of this.referenceProtection(command.reference).files)this.protected.add(file);
      if(command.referenceId)this.protectedIds.add(command.referenceId);
    }
    return this.operation(async(connection,epoch)=>{
      this.publisher=publish;
      await this.events;
      const state=await connection.request('get_state');
      if(command.name!=='session'&&(state.isStreaming||state.isCompacting))throw commandError(msg('rpc.busy'));
      if(epoch!==this.epoch)throw commandError(msg('rpc.stopped'));
      let submitted=false;
      const submit=()=>{beforeSubmit();submitted=true;};
      const request=(type,fields={})=>connection.request(type,fields,submit);
      let text;
      try{
        const {name,argument=''}=command;
        if(name==='new'){
          if((await request('new_session')).cancelled)throw commandError(msg('rpc.newCancelled'));
          this.inputs=[];this.lastReference=undefined;this.clearDialogs();text=msg('rpc.newDone');
        } else if(name==='fork'){
          const next=createBranch(this.config,command.reference,file=>{submit();this.protected.add(file);});
          if(epoch!==this.epoch)throw commandError(msg('rpc.stopped'));
          if((await request('switch_session',{sessionPath:next})).cancelled){fs.rmSync(next,{force:true});throw commandError(msg('rpc.forkCancelled'));}
          this.inputs=[];this.lastReference=undefined;this.clearDialogs();text=msg('rpc.forkDone');
        } else if(name==='session'){
          const stats=await request('get_session_stats'),tokens=stats.tokens,context=stats.contextUsage;
          text=[msg('session.title',state.sessionName||state.sessionId),msg('session.model',state.model?state.model.provider+'/'+state.model.id:msg('session.modelUnset')),state.isStreaming?msg('session.busy'):msg('session.idle'),msg('session.tokens',tokens.total),msg('session.io',tokens.input,tokens.output),msg('session.cache',tokens.cacheRead,tokens.cacheWrite),msg('session.cost',stats.cost.toFixed(6)),context?msg('session.context',context.tokens,context.contextWindow):''].filter(Boolean).join('\n');
        } else if(name==='model'){
          if(!argument){const {models}=await request('get_available_models');text=[msg('session.modelsTitle',state.model?state.model.provider+'/'+state.model.id:msg('session.modelUnset')),...models.map(model=>model.provider+'/'+model.id),msg('session.modelsHint')].join('\n');}
          else {const cut=argument.indexOf('/');if(cut<=0)throw commandError(msg('rpc.modelUsage'));await request('set_model',{provider:argument.slice(0,cut),modelId:argument.slice(cut+1)});text=msg('rpc.modelDone',argument);}
        } else if(name==='thinking'){
          const {levels}=await request('get_available_thinking_levels');
          if(!argument)text=[msg('session.thinkingTitle',state.thinkingLevel),msg('session.thinkingOptions',levels.join(' / ')),msg('session.thinkingHint')].join('\n');
          else {if(!levels.includes(argument))throw commandError(msg('rpc.thinkingInvalid',levels.join(' / ')));await request('set_thinking_level',{level:argument});text=msg('rpc.thinkingDone',argument);}
        } else if(name==='compact'){await request('compact',{customInstructions:argument||undefined});text=msg('rpc.compacted');}
        else throw commandError(msg('command.unknown'));
        await this.events;
        if(epoch!==this.epoch)throw commandError(msg('rpc.stopped'));
        this.save(await connection.request('get_state'));return {text};
      } catch(error){
        if(!submitted)error.commandResult=true;
        else if(!error.commandResult&&!error.rpcRejected)error.commandUncertain=true;
        throw error;
      }
    },publish).catch(error=>{
      if(error.rpcRejected)return {text:error.message};
      throw error;
    });
  }
  async stop(){
    this.epoch++;this.publisher=null;this.inputs=[];this.attachments.clear();this.protected.clear();this.protectedIds.clear();this.clearDialogs();
    if(this.stopping)return this.stopping;
    this.stopping=(async()=>{
      const connection=this.connection;
      const stopping=connection?.terminate(this.config.shutdownTimeoutMs);
      if(this.starting)await this.starting.catch(()=>{});
      await stopping;
      if(this.connection!==connection)await this.connection?.terminate(this.config.shutdownTimeoutMs);
      this.streaming=false;this.compacting=false;
    })();
    try{await this.stopping;}finally{this.stopping=null;}
  }
  canCleanup(){return !this.streaming&&!this.compacting&&!this.starting&&!this.stopping&&!this.jobs&&!this.eventJobs;}
  protection(){
    const files=[...this.attachments,...this.protected],ids=[...this.protectedIds];
    const sessionFile=this.saved.sessionFile,held=!!sessionFile&&(!this.canCleanup()||!!this.dialogs.length);
    if(held)files.push(sessionFile);
    for(const input of this.inputs)ids.push(input.sourceId);
    if(held){
      const file=path.join(this.config.dataDir,'input-references.json');
      if(fs.existsSync(file)){
        const references=JSON.parse(fs.readFileSync(file,'utf8'));
        for(const [id,reference] of Object.entries(references))if(this.referenceProtection(reference).files.includes(sessionFile))ids.push(id);
      }
    }
    const dirs=this.canCleanup()?[]:['tmp','cache'].map(dir=>path.join(this.config.dataDir,dir));
    return {files,dirs,ids};
  }
  pendingNotice(){return this.notice;}
  clearNotice(){this.notice='';}
  async releaseSession(){if(this.dialogs.length)return;if(this.canCleanup())await this.stop();}
  detachSession(file){
    if(this.saved.sessionFile!==file)return;
    this.saved={verbose:this.saved.verbose,preferences:this.saved.preferences};
    this.persistSaved(this.saved);
    this.lastReference=undefined;
  }
  forgetMissingSession(){
    if(this.saved.sessionFile&&!fs.existsSync(this.saved.sessionFile))this.detachSession(this.saved.sessionFile);
    if(this.lastReference&&!this.referenceExists(this.lastReference))this.lastReference=undefined;
  }
  retentionStore(){
    const file=path.join(this.config.dataDir,'input-references.json');
    const references=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
    const fallback=fs.existsSync(file)?fs.statSync(file).mtimeMs:Date.now();
    let changed=false;
    for(const reference of Object.values(references))if(!Number.isFinite(reference.createdAt)){reference.createdAt=fallback;changed=true;}
    if(changed)writePrivateFileSync(file,JSON.stringify(references)+'\n');
    return {file,permanentBytes:()=>Buffer.byteLength('{}\n'),entries:Object.entries(references).map(([id,reference])=>({id,createdAt:this.referenceExists(reference)?reference.createdAt:0,bytes:Buffer.byteLength(JSON.stringify(reference))})),remove(ids){
      const next=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const id of ids)delete next[id];
      writePrivateFileSync(file,JSON.stringify(next)+'\n');
    }};
  }
  async resetSession(){
    await this.close();
    this.saved={verbose:this.saved.verbose};
    this.persistSaved(this.saved);
  }
  kill(){this.connection?.kill();}
  async close(){this.closed=true;this.epoch++;this.publisher=null;this.attachments.clear();this.protected.clear();this.protectedIds.clear();this.clearDialogs();if(this.starting)await this.starting.catch(()=>{});await this.connection?.close(this.config.shutdownTimeoutMs);await this.queue;await this.replies;await this.events;}
}
