import fs from 'node:fs';
import path from 'node:path';
import {copy} from './copy.mjs';

export function createRetention({dataDir,maxBytes,maxAgeMs}) {
  const root=fs.realpathSync(dataDir);
  const permanentFiles=new Set(['config.json','environment.json','tasks.json','rpc-state.json','tui-state.json','weixin/wechat-state.json','weixin/bridge.json'].map(file=>path.join(root,file)));
  const settingsDirs=['pi','home','config','state','share','browser-profile','browser-profile-task'].map(dir=>path.join(root,dir)+path.sep);
  const permanent={has:file=>permanentFiles.has(file)||settingsDirs.some(dir=>file.startsWith(dir))};
  function stat(file) {
    try{return fs.lstatSync(file);}
    catch(error){if(error.code==='ENOENT')return undefined;throw error;}
  }
  function scan(dir=root,files=[]) {
    let names;
    try{names=fs.readdirSync(dir);}
    catch(error){if(error.code==='ENOENT')return files;throw error;}
    for(const name of names){
      const file=path.join(dir,name),info=stat(file);
      if(!info)continue;
      if(info.isSymbolicLink())throw new Error(copy.retention.symlink(file));
      if(info.isDirectory()){if(name.startsWith('browser-profile'))continue;scan(file,files);continue;}
      if(info.isFile())files.push({file,bytes:info.size,createdAt:info.mtimeMs});
    }
    return files;
  }
  function select(candidates,total,now) {
    const selected=new Set(candidates.filter(item=>now-item.createdAt>=maxAgeMs));
    let remaining=total;
    for(const item of selected)remaining-=item.bytes;
    for(const item of candidates){
      if(remaining<=maxBytes)break;
      if(selected.has(item))continue;
      selected.add(item);remaining-=item.bytes;
    }
    return [...selected];
  }
  function fixedBytes(files,stores) {
    const present=new Set(files.map(item=>item.file)),recordFiles=new Set(stores.map(store=>store.file));
    const permanentBytes=files.filter(item=>permanent.has(item.file)&&!recordFiles.has(item.file)).reduce((sum,item)=>sum+item.bytes,0);
    const containerBytes=stores.reduce((sum,store)=>sum+(present.has(store.file)?store.permanentBytes():0),0);
    return permanentBytes+containerBytes;
  }
  function plan(stores,protection={}) {
    const {files=[],dirs=[],ids=[]}=protection;
    const keepFiles=new Set(files),keepIds=new Set(ids);
    const keepDirs=dirs.map(dir=>dir.endsWith(path.sep)?dir:dir+path.sep);
    const held=item=>permanent.has(item.file)||keepFiles.has(item.file)||keepDirs.some(dir=>item.file.startsWith(dir));
    const all=scan(),recordFiles=new Set(stores.map(store=>store.file));
    const candidates=all.filter(item=>!held(item)&&!recordFiles.has(item.file));
    for(const store of stores)for(const entry of store.entries)if(!keepIds.has(entry.id))candidates.push({...entry,store});
    candidates.sort((a,b)=>a.createdAt-b.createdAt);
    const total=all.reduce((sum,item)=>sum+item.bytes,0);
    const fixed=fixedBytes(all,stores);
    const selected=select(candidates,total,Date.now());
    return {candidates,selected,fixed,total,stores,files:selected.filter(item=>item.file).map(item=>item.file)};
  }
  function apply(plan,beforeRemove=()=>{}) {
    const remaining=new Set(plan.candidates);
    function remove(items) {
      const groups=new Map();
      for(const item of items){
        if(item.store){
          if(!groups.has(item.store))groups.set(item.store,[]);
          groups.get(item.store).push(item.id);
        } else {
          const relative=path.relative(root,item.file);
          if(relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||permanent.has(item.file))throw new Error(copy.retention.path(item.file));
          beforeRemove(item.file);
          try{fs.unlinkSync(item.file);}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
        remaining.delete(item);
      }
      for(const [store,ids] of groups)store.remove(ids);
    }
    remove(plan.selected);
    let files=scan(),total=files.reduce((sum,item)=>sum+item.bytes,0);
    while(total>maxBytes&&remaining.size){
      const items=select([...remaining],total,Date.now());
      if(!items.length)break;
      remove(items);
      files=scan();total=files.reduce((sum,item)=>sum+item.bytes,0);
    }
    if(total>maxBytes&&fixedBytes(files,plan.stores)>maxBytes)throw new Error(copy.retention.full);
    const deferred=total>maxBytes;
    function prune(dir=root){
      let names;
      try{names=fs.readdirSync(dir);}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      for(const name of names){
        const file=path.join(dir,name),info=stat(file);
        if(info?.isDirectory())prune(file);
      }
      if(dir===root)return;
      let empty;
      try{empty=!fs.readdirSync(dir).length;}
      catch(error){if(error.code==='ENOENT')return;throw error;}
      if(empty)fs.rmdirSync(dir);
    }
    prune();
    return {total,deferred};
  }
  return {plan,apply};
}
