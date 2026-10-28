import {copy} from './copy.mjs';
export function splitWeixinText(text,limit=1200) {
  if(!Number.isInteger(limit)||limit<2)throw new Error(copy.output.badLimit);
  const chunks=[];let current='';
  for(const char of String(text||'')) {
    if(current.length+char.length>limit){const newline=current.lastIndexOf('\n');const cut=newline>=limit/2?newline+1:current.length;chunks.push(current.slice(0,cut));current=current.slice(cut);}
    current+=char;
  }
  if(current)chunks.push(current);return chunks;
}
