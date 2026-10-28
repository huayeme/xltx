import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {splitWeixinText} from './output.mjs';
import {writePrivateFileSync} from '../vendor/weixin/engine/secure-file.js';
import {createWeixinChannel,clearWeixinLogin} from '../vendor/weixin/channels/weixin.js';
import {copy} from './copy.mjs';
import {msg} from './messages.mjs';

export function createWeixinBridge({dir,defaultCwd,onMessage,log=console.error,textLimit=1200,createChannel=createWeixinChannel,retryMs=2000,classifyMessage=()=>({}),onAccountChanged=async()=>{},decorate=answer=>({answer}),resolveReference=()=>undefined,referenceProtection=()=>({files:[],dirs:[],ids:[]}),referenceExists=()=>true}) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const file=path.join(dir,'bridge.json');
  let saved={enabled:true,executions:{}};
  if(fs.existsSync(file))saved={...saved,...JSON.parse(fs.readFileSync(file,'utf8'))};
  let channel,starting,closed=false,generation=0,error='',busy=false,queue=Promise.resolve();
  const pending=new Set(),immediateJobs=new Set(),holds=new Map();
  let workGeneration=0,activeJobs=0;
  function stamp(next,time=Date.now()){
    let changed=false;
    for(const group of [next.executions,next.references,next.uncertainDeliveries,...Object.values(next.outbox||{}).map(answer=>answer.items||[])]){
      for(const item of Object.values(group||{}))if(!Number.isFinite(item.createdAt)){item.createdAt=time;changed=true;}
    }
    return changed;
  }
  const write=next=>{stamp(next);writePrivateFileSync(file,JSON.stringify(next,null,2)+'\n');saved=next;};
  const outboxCount=()=>Object.values(saved.outbox||{}).reduce((total,answer)=>total+(answer.items?.length||0),0);
  let migrated=stamp(saved,fs.existsSync(file)?fs.statSync(file).mtimeMs:Date.now())||Object.hasOwn(saved,'token');
  delete saved.token;
  for(const [chatId,answer] of Object.entries(saved.outbox||{})){
    if(answer.items)continue;
    const texts=answer.texts||splitWeixinText(answer.text,textLimit).map(text=>({id:randomUUID(),text,reference:answer.reference}));
    saved.outbox[chatId]={items:[
      ...texts.map(item=>({...item,kind:'text'})),
      ...(answer.files||[]).map(file=>({id:randomUUID(),kind:'file',file,reference:answer.reference})),
    ]};
    migrated=true;
  }
  for(const [chatId,answer] of Object.entries(saved.outbox||{})){
    const items=[];
    for(const item of answer.items){
      if(item.status==='queued')items.push(item);
      else {
        const reason=item.status==='sending'?'Service interrupted; delivery could not be confirmed':'Legacy record lacks delivery status; delivery could not be confirmed';
        saved.uncertainDeliveries={...saved.uncertainDeliveries,[item.id]:{...item,chatId,status:'uncertain',reason}};
        migrated=true;
      }
    }
    if(items.length)saved.outbox[chatId]={items};
    else delete saved.outbox[chatId];
  }
  if(migrated)write(saved);
  function finishDelivery(chatId,item,result,reason){
    const next={...saved,outbox:{...saved.outbox}};
    if(reason)next.uncertainDeliveries={...next.uncertainDeliveries,[item.id]:{...item,chatId,status:'uncertain',reason}};
    if(result?.message_id&&item.reference)next.references={...next.references,[`${chatId}:${chatId}:${result.message_id}`]:item.reference};
    const items=(next.outbox[chatId]?.items||[]).filter(queued=>queued.id!==item.id);
    if(items.length)next.outbox[chatId]={items};
    else delete next.outbox[chatId];
    write(next);
  }

  let sending=false,deliveryAbort,cleaning=false,deliveryDone=Promise.resolve();
  async function flushDelivery() {
    if(sending||cleaning||closed||!channel||!saved.enabled)return;
    sending=true;
    let resolveDelivery;
    deliveryDone=new Promise(resolve=>{resolveDelivery=resolve;});
    const controller=new AbortController();deliveryAbort=controller;
    const work=workGeneration;
    try {
      for(const [chatId,answer] of Object.entries(saved.outbox||{})) {
        const current=channel,turn=generation;
        const check=()=>{if(closed||channel!==current||generation!==turn||work!==workGeneration||!saved.enabled)throw new Error(msg('bridge.connectionChanged'));};
        for(const item of answer.items){
          if(cleaning)return;
          check();
          if(item.status!=='queued'){
            finishDelivery(chatId,item,undefined,'Previous delivery could not be confirmed');
            continue;
          }
          let submitted=false;
          const beforeSubmit=()=>{
            check();
            const pending=saved.outbox[chatId];
            if(!pending?.items.some(queued=>queued.id===item.id))throw new Error(msg('bridge.connectionChanged'));
            write({...saved,outbox:{...saved.outbox,[chatId]:{items:pending.items.map(queued=>queued.id===item.id?{...queued,status:'sending'}:queued)}}});
            submitted=true;
          };
          try {
            const result=item.kind==='text'
              ?await current.send(chatId,item.text,beforeSubmit,controller.signal)
              :await current.sendFile(chatId,{...item.file,data:Buffer.from(item.file.data,'base64')},controller.signal,beforeSubmit);
            check();
            finishDelivery(chatId,item,result);
          } catch(cause){
            check();
            if(!submitted||cause.deliveryNotSent){
              const pending=saved.outbox[chatId];
              if(pending)write({...saved,outbox:{...saved.outbox,[chatId]:{items:pending.items.map(queued=>queued.id===item.id?{...queued,status:'queued'}:queued)}}});
              throw cause;
            }
            finishDelivery(chatId,item,undefined,cause.message||'Delivery could not be confirmed');
            log('[weixin-delivery-uncertain]',item.id,cause.message);
          }
        }
      }
    } catch(cause){log('[weixin-delivery]',cause.message);}
    finally{sending=false;if(deliveryAbort===controller)deliveryAbort=undefined;resolveDelivery();}
  }
  const retryTimer=setInterval(()=>void flushDelivery(),retryMs);
  const delivery=(chatId,work=workGeneration)=>async answer=>{
    if(closed||!saved.enabled||work!==workGeneration)throw new Error(msg('bridge.stopped'));
    const decorated=decorate(answer);
    answer=decorated.answer||answer;
    const items=[
      ...(saved.outbox?.[chatId]?.items||[]),
      ...splitWeixinText(answer.text,textLimit).map(text=>({id:randomUUID(),kind:'text',status:'queued',text,reference:answer.reference})),
      ...(answer.files||[]).map(file=>({id:randomUUID(),kind:'file',status:'queued',file:{...file,data:Buffer.from(file.data).toString('base64')},reference:answer.reference})),
    ];
    if(!items.length)return;
    write({...saved,outbox:{...saved.outbox,[chatId]:{items}}});
    decorated.done?.();
    void flushDelivery();
  };
  function retentionStore(){
    const entries=[];
    const add=(group,key,value)=>entries.push({id:JSON.stringify([group,key]),createdAt:group==='references'&&!referenceExists(value)?0:value.createdAt,bytes:Buffer.byteLength(JSON.stringify(value))});
    for(const group of ['executions','references','uncertainDeliveries'])for(const [key,value] of Object.entries(saved[group]||{}))add(group,key,value);
    for(const [chatId,answer] of Object.entries(saved.outbox||{}))for(const item of answer.items)add('outbox',[chatId,item.id],item);
    return {file,permanentBytes:()=>Buffer.byteLength(JSON.stringify({...saved,executions:{},references:{},uncertainDeliveries:{},outbox:{}},null,2)+'\n'),entries,remove(ids){
      const next={...saved};
      for(const id of ids){
        const [group,key]=JSON.parse(id);
        if(group==='outbox'){
          const [chatId,itemId]=key;
          next.outbox={...next.outbox};
          const items=(next.outbox[chatId]?.items||[]).filter(item=>item.id!==itemId);
          if(items.length)next.outbox[chatId]={items};else delete next.outbox[chatId];
        } else {next[group]={...next[group]};delete next[group][key];}
      }
      write(next);
    }};
  }
  async function startChannel() {
    let current;
    const notices={
      imageFailed:reason=>msg('channel.imageFailed',reason),
      mediaFailed:()=>msg('channel.mediaFailed'),
      reason:(kind,status)=>{try{return msg('channel.reasons.'+kind,status);}catch{return kind;}},
    };
    try {
      current=createChannel({enabled:true,messages:notices,
        async onLogin({userId,previousUserId}){
          if(closed||channel!==current||!saved.enabled)throw new Error(msg('bridge.connectionChanged'));
          generation++;workGeneration++;
          const dropped=outboxCount();
          write({...saved,outbox:{},references:{},executions:{}});
          if(dropped)void delivery(userId)({text:msg('bridge.discardedOnReconnect')}).catch(cause=>log('[weixin-delivery]',cause.message));
          if(previousUserId!==userId)await onAccountChanged(userId);
          if(closed||channel!==current||!saved.enabled)throw new Error(msg('bridge.connectionChanged'));
        },
      },message=>log(message),dir);
      channel=current;
      current.setMessageHandler(message=>{
        if(closed||channel!==current||!saved.enabled)return;
        const key=`${message.userId}:${message.messageId}`;
        if(pending.has(key))return;
        const execution=saved.executions[key];
        if(execution){
          if(execution.input!=='written')void delivery(message.chatId)({text:execution.input==='commandUncertain'?execution.notice:msg('bridge.uncertain')}).catch(cause=>log('[weixin-input]',cause.message));
          return;
        }
        const {immediate,interrupt}=classifyMessage(message);
        if(interrupt){
          const dropped=outboxCount();
          workGeneration++;
          deliveryAbort?.abort();
          write({...saved,outbox:{}});
          if(dropped)void delivery(message.chatId)({text:msg('bridge.interrupted')}).catch(cause=>log('[weixin-delivery]',cause.message));
        }
        // Delivered replies are indexed as `${chatId}:${chatId}:${message_id}`;
        // the lookup must use the same shape, or quoting a reply inside a group
        // chat (member and chat differ) never finds what it points at.
        const referenceId=message.quoteId?`${message.chatId}:${message.chatId}:${message.quoteId}`:undefined;
        const reference=referenceId?(saved.references?.[referenceId]||resolveReference(referenceId)):undefined;
        const held={files:(message.media||[]).map(item=>item.path).filter(Boolean),dirs:[],ids:[]};
        if(reference){
          const protection=referenceProtection(reference);
          held.files.push(...protection.files);held.dirs.push(...protection.dirs);held.ids.push(...protection.ids);
          held.ids.push(referenceId,JSON.stringify(['references',referenceId]));
        }
        if(held.files.length||held.dirs.length||held.ids.length)holds.set(key,held);
        pending.add(key);const turn=generation,work=workGeneration;
        const run=async()=>{
          let active=false;
          try {
            if(closed||channel!==current||turn!==generation||work!==workGeneration||!saved.enabled)return;
            active=true;busy=++activeJobs>0;
            write({...saved,executions:{...saved.executions,[key]:{input:'admitted'}}});
            const publish=delivery(message.chatId,work);
            const input={...message,reference};
            const answer=await onMessage(input,publish,()=>{
              if(work!==workGeneration)throw new Error(msg('bridge.connectionChanged'));
              write({...saved,executions:{...saved.executions,[key]:{input:'submitting'}}});
            });
            if(work!==workGeneration)return;
            write({...saved,executions:{...saved.executions,[key]:{input:'written'}}});
            if(answer?.text||answer?.files?.length)await publish(answer);
            error='';
          } catch(cause) {
            if(work!==workGeneration)return;
            if(cause.commandUncertain){
              error=msg('bridge.commandUncertain',cause.message);
              write({...saved,executions:{...saved.executions,[key]:{input:'commandUncertain',notice:error}}});
              log('[weixin-command]',cause.message);
              await delivery(message.chatId,work)({text:error}).catch(()=>{});
              return;
            }
            if(cause.commandResult){
              write({...saved,executions:{...saved.executions,[key]:{input:'written'}}});
              error=msg('bridge.commandFailed',cause.message);
              await delivery(message.chatId,work)({text:error}).catch(()=>{});
              return;
            }
            const uncertain=!cause.notSubmitted&&saved.executions[key]?.input!=='admitted';
            if(!uncertain){const executions={...saved.executions};delete executions[key];write({...saved,executions});}
            error=uncertain?msg('bridge.uncertainWithReason',cause.message):msg('bridge.notSubmitted',cause.message);log('[weixin-input]',cause.message);
            await delivery(message.chatId,work)({text:error}).catch(()=>{});
          } finally{if(active)busy=--activeJobs>0;pending.delete(key);holds.delete(key);}
        };
        if(immediate){const job=run();immediateJobs.add(job);void job.finally(()=>immediateJobs.delete(job)).catch(cause=>log('[weixin-command]',cause.message));}
        else queue=queue.then(run).catch(cause=>log('[weixin-queue]',cause.message));
      });
      await current.start();
      if(channel!==current)await current.stop();
    } catch(cause) {
      if(channel===current)channel=undefined;
      error=cause.message;await current?.stop().catch(()=>{});throw cause;
    }
  }
  async function start(){if(closed)throw new Error(msg('bridge.closed'));if(starting)return starting;if(channel)return;starting=startChannel();try{await starting;}finally{starting=undefined;}}
  async function stop(){generation++;const old=channel;channel=undefined;await old?.stop();}
  return {
    protection(){
      const files=[],dirs=[],ids=[];
      if(channel?.isBusy?.())dirs.push(path.join(dir,'media'));
      if(sending)dirs.push(path.join(dir,'.delivery-')+path.sep);
      for(const hold of holds.values()){files.push(...hold.files);dirs.push(...hold.dirs);ids.push(...hold.ids);}
      for(const key of pending)ids.push(JSON.stringify(['executions',key]));
      return {files,dirs,ids};
    },
    async prepareCleanup(){cleaning=true;await deliveryDone;},
    finishCleanup(){cleaning=false;},
    retentionStore,
    loginUrl:()=>channel?.loginUrl()||'',
    async notify(text){
      if(closed||!saved.enabled)throw new Error(msg('bridge.stopped'));
      const current=channel;
      if(!current)throw new Error(msg('bridge.closed'));
      const userId=current.userId?.();
      if(!userId)throw new Error(msg('bridge.notLoggedIn'));
      await delivery(userId)({text});
    },
    async status(){
      const state=starting?'starting':channel?.status()||(error?'failed':'disconnected');
      return {enabled:saved.enabled,cwd:defaultCwd,state,status:copy.channelStatus(state),failed:state==='failed',loggedIn:state==='signed-in',busy,error,connected:state==='signed-in'};
    },
    async configure({action}) {
      if(closed)throw new Error(msg('bridge.closed'));
      if(!['connect','disconnect','logout'].includes(action))throw new Error(msg('bridge.unknownAction'));
      if(busy)throw new Error(msg('bridge.busyConfigure'));
      if(action==='connect'){write({...saved,enabled:true});await start();}
      else {workGeneration++;write({...saved,enabled:false,...(action==='logout'?{outbox:{},references:{}}:{})});await stop();if(action==='logout')clearWeixinLogin(dir);}
      return this.status();
    },
    async restore(){if(saved.enabled){if(channel?.status()==='failed')await stop();await start();}},
    async close(){clearInterval(retryTimer);workGeneration++;closed=true;deliveryAbort?.abort();await stop();await queue;await Promise.allSettled(immediateJobs);},
  };
}
