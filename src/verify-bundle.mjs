import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function verifyBundle(project){
  const root=fs.realpathSync(project);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'runtime/manifest.json'),'utf8'));
  for(const entry of manifest.files){
    const file=path.resolve(root,entry.path),relative=path.relative(root,file);
    if(!relative||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||relative==='..')throw new Error('Invalid bundle path.');
    const stat=fs.lstatSync(file);
    if(entry.target!==undefined){
      if(!stat.isSymbolicLink()||fs.readlinkSync(file)!==entry.target)throw new Error('Bundle link verification failed: '+entry.path);
      if(!fs.realpathSync(file).startsWith(root+path.sep))throw new Error('Bundle link points outside the directory: '+entry.path);
    }else{
      if(!stat.isFile())throw new Error('Bundle file type mismatch: '+entry.path);
      const actual=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if(actual!==entry.sha256||(stat.mode&0o111)!==(entry.mode&0o111))throw new Error('Bundle file verification failed: '+entry.path);
    }
  }
  return manifest.files.length;
}
