import {msg} from '../../messages.mjs';
import {PiRpc} from './rpc.mjs';
export {configure,checkRuntime} from './runtime.mjs';

export function create(config,settings) {
  const backend=new PiRpc(config,settings);
  return {
    get closed(){return backend.closed;},
    get awaitingInput(){return backend.dialogs.length>0;},
    send:(message,publish,beforeSubmit)=>backend.send(message,publish,beforeSubmit),
    command:(command,publish,beforeSubmit)=>backend.command(command,publish,beforeSubmit),
    reference:sourceId=>backend.reference(sourceId),
    referenceProtection:reference=>backend.referenceProtection(reference),
    referenceExists:reference=>backend.referenceExists(reference),
    async stop(){await backend.stop();return {text:msg('stop')};},
    status:()=>backend.status(),
    close:()=>backend.close(),
    resetSession:()=>backend.resetSession(),
    protection:()=>backend.protection(),
    pendingNotice:()=>backend.pendingNotice(),
    clearNotice:()=>backend.clearNotice(),
    releaseSession:()=>backend.releaseSession(),
    detachSession:file=>backend.detachSession(file),
    forgetMissingSession:()=>backend.forgetMissingSession(),
    retentionStore:()=>backend.retentionStore(),
    kill:()=>backend.kill(),
  };
}
