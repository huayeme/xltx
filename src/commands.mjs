import {msg} from './messages.mjs';
const names=new Set(['new','fork','stop','session','model','thinking','compact','verbose']);
export const messageKey=message=>`${message.userId}:${message.chatId}:${message.messageId}`;
export function parseCommand(message) {
  const text=String(message.text||'').trim();
  if(!text.startsWith('/'))return null;
  const match=/^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text);
  const name=match?.[1]?.toLowerCase()||'';
  return {name,argument:(match?.[2]||'').trim(),known:names.has(name)};
}
export function commandPolicy(message) {
  const command=parseCommand(message);
  const interrupt=command?.name==='stop'&&!command.argument&&!message.media?.length;
  return {immediate:!!command&&(!command.known||interrupt||command.name==='verbose'),interrupt};
}
export function createCommandLayer(getBackend) {
  return async function handle(message,publish,beforeSubmit) {
    const command=parseCommand(message);
    if(command&&!command.known)return {text:msg('command.unknown')};
    const backend=getBackend();
    if(!command)return backend.send({...message,sourceId:messageKey(message)},publish,beforeSubmit);
    if(message.media?.length)return {text:msg('command.attachment')};
    const {name,argument}=command;
    if(['new','fork','stop','session'].includes(name)&&argument)return {text:msg('command.noArgument',name)};
    if(name==='stop')return backend.stop();
    if(name==='fork'){
      if(!message.hasQuote||!message.quoteId)return {text:msg('command.forkNeedsQuote')};
      const referenceId=`${message.userId}:${message.chatId}:${message.quoteId}`;
      const reference=message.reference||backend.reference(referenceId);
      if(!reference)return {text:msg('command.forkNoReference')};
      return backend.command({name,argument,reference,referenceId},publish,beforeSubmit);
    }
    return backend.command({name,argument},publish,beforeSubmit);
  };
}
