import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const installRoot=fileURLToPath(new URL('../',import.meta.url));
export const portableSettings=JSON.parse(fs.readFileSync(new URL('../portable.json',import.meta.url),'utf8'));
export function inside(file,base=installRoot){
  const relative=path.relative(base,path.resolve(file));
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Path must be inside the install directory: '+file);
  // Check every existing ancestor, not only the final component.
  let current=path.resolve(base);
  for(const part of relative.split(path.sep).filter(Boolean)){
    current=path.join(current,part);
    if(fs.existsSync(current)||fs.lstatSync(current,{throwIfNoEntry:false})){
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('Paths outside the install directory cannot be reached through symlinks: '+current);
    }
  }
  return path.resolve(file);
}
export function requirePortable(project=installRoot){
  if(process.env.WEIXIN_ROOT!==path.resolve(project))throw new Error('Please start with ./xltx from inside the install directory.');
  for(const file of ['runtime/bin/node','runtime/bin/pi','runtime/manifest.json']){
    const full=path.join(project,file);
    if(!fs.existsSync(full))throw new Error('The bundled runtime is incomplete: '+file);
    const resolved=fs.realpathSync(full);
    if(!resolved.startsWith(path.resolve(project)+path.sep))throw new Error('The bundled runtime cannot point outside the install directory: '+file);
  }
}
