import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const installRoot=fileURLToPath(new URL('../',import.meta.url));
const bundledFile=path.join(installRoot,'messages.json');

const messagesFile=path.join(installRoot,'data','messages.json');

function parse(file){
  try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return undefined;}
}

function merge(base,override){
  if(Array.isArray(override))return override.every(item=>typeof item==='string')?override.slice():base;
  if(override&&typeof override==='object'){
    const next=base&&typeof base==='object'&&!Array.isArray(base)?{...base}:{};
    for(const [key,value] of Object.entries(override))next[key]=merge(next[key],value);
    return next;
  }
  return typeof override==='string'?override:base;
}

function lookup(tree,key){
  return key.split('.').reduce((node,part)=>node&&typeof node==='object'&&!Array.isArray(node)?node[part]:undefined,tree);
}

function format(template,values){
  return template.replace(/\{(\d+)\}/g,(token,index)=>Number(index)<values.length?String(values[Number(index)]):token);
}

const bundled=parse(bundledFile);
if(!bundled||typeof bundled!=='object')throw new Error('The bundled message file messages.json is missing or invalid.');
let override;
if(fs.existsSync(messagesFile)){
  override=parse(messagesFile);
  if(!override||typeof override!=='object')console.error('[messages]','data/messages.json is not valid JSON, using the bundled messages');
}
const messages=merge(bundled,override||{});

export function msg(key,...values){
  const template=lookup(messages,key);
  if(typeof template==='string')return format(template,values);
  const fallback=lookup(bundled,key);
  if(typeof fallback!=='string')throw new Error('Message key is missing: '+key);
  return format(fallback,values);
}

export function words(key){
  const value=lookup(messages,key);
  if(Array.isArray(value)&&value.every(item=>typeof item==='string'))return value.slice();
  const fallback=lookup(bundled,key);
  if(!Array.isArray(fallback))throw new Error('Message list is missing: '+key);
  return fallback.slice();
}

export function seedMessages(dataDir=path.dirname(messagesFile)){
  const file=path.join(dataDir,'messages.json');
  if(fs.existsSync(file))return file;
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  fs.writeFileSync(file,fs.readFileSync(bundledFile,'utf8'),{mode:0o600});
  return file;
}
