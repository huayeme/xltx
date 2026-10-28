const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
if(process.env.WEIXIN_ROOT!==root)throw new Error('Please start with xltx from inside the install directory.');
// The local loader is /proc/self/exe. Node children must re-enter our launcher,
// not try to use the loader as though it were Node.
Object.defineProperty(process,'execPath',{value:path.join(root,'runtime/bin/node'),configurable:true});
const file=path.join(root,'data/environment.json');
if(fs.existsSync(file)){
  if(fs.lstatSync(file).isSymbolicLink())throw new Error('The environment config cannot be a symlink.');
  const env=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!env||typeof env!=='object'||Array.isArray(env))throw new Error('The environment config must be an object.');
  for(const [key,value] of Object.entries(env)){
    if(!/^[A-Z][A-Z0-9_]*_API_KEY$/.test(key)&&!['HTTP_PROXY','HTTPS_PROXY','NO_PROXY'].includes(key))throw new Error('The environment config does not support this entry: '+key);
    if(typeof value!=='string'||value.includes('\0'))throw new Error('The environment config value must be a string: '+key);
    process.env[key]=value;
  }
}
