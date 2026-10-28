import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {verifyBundle} from '../src/verify-bundle.mjs';
import {application,releaseName,assertReleaseAvailable} from '../src/release.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const settings=JSON.parse(fs.readFileSync(path.join(root,'portable.json'),'utf8'));
const input=Object.fromEntries(process.argv.slice(2).map(value=>{const cut=value.indexOf('=');if(cut<1)throw new Error('Build argument format: --name=/path');return [value.slice(2,cut),value.slice(cut+1)];}));
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',timeout:settings.commandTimeoutMs,...options});
function executable(name){return fs.realpathSync(run('/usr/bin/which',[name]).trim());}
const node=fs.realpathSync(input.node||process.execPath);
function piPackageDirectory(){
  let dir=path.dirname(executable('pi'));
  while(dir!==path.dirname(dir)){
    const file=path.join(dir,'package.json');
    if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).name?.endsWith('/pi-coding-agent'))return dir;
    dir=path.dirname(dir);
  }
  throw new Error('Specify the Pi build source directory with --pi.');
}
const pi=input.pi?fs.realpathSync(input.pi):piPackageDirectory();
// Pi loads some modules dynamically at runtime (extension loading goes through
// jiti), so the package directory alone is not enough: ship its dependency
// tree beside it, otherwise every session dies with "Cannot find module".
function piModules(from){
  for(let dir=from;dir!==path.dirname(dir);dir=path.dirname(dir)){
    if(path.basename(dir)==='node_modules')return dir;
    const candidate=path.join(dir,'node_modules');
    if(fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory())return candidate;
  }
  throw new Error('Unable to locate Pi dependencies for '+from+'; install Pi inside a node_modules tree.');
}
const tools={bash:fs.realpathSync(input.bash||executable('bash')),busybox:fs.realpathSync(input.busybox||executable('busybox')),rg:fs.realpathSync(input.rg||executable('rg')),fd:fs.realpathSync(input.fd||executable('fd'))};
const browser={browsers:input.browser?fs.realpathSync(input.browser):undefined,libraries:input['browser-libs']?fs.realpathSync(input['browser-libs']):undefined,fonts:input.fonts?fs.realpathSync(input.fonts):undefined};
for(const [key,value] of Object.entries(browser))if(!value)throw new Error('Browser build input is required: --'+{browsers:'browser',libraries:'browser-libs',fonts:'fonts'}[key]+'=/path');
if(process.platform!==settings.platform||process.arch!==settings.arch)throw new Error('Build host does not match the target platform in portable.json.');
if(run(node,['--version']).trim()!=='v'+settings.nodeVersion)throw new Error('Node version does not match portable.json.');
const piPackage=JSON.parse(fs.readFileSync(path.join(pi,'package.json'),'utf8'));
if(piPackage.version!==settings.piVersion||!piPackage.name.endsWith('/pi-coding-agent'))throw new Error('Invalid Pi build source or version.');
// --into=<dir> assembles the installation directly into <dir> without producing
// a distributable archive; used when building and installing on the same host.
const into=input.into?path.resolve(input.into):undefined;
// <dir> is emptied before the result is moved in, so it must never be the source tree.
if(into&&(into===root||root.startsWith(into+path.sep)))throw new Error('--into must be outside the source tree: '+into);
const dist=path.join(root,'dist');
const name=releaseName(application,settings);
const destination=path.join(dist,name),archive=destination+'.tar.gz';
const record=path.join(root,'releases',name+'.json');
if(!into)assertReleaseAvailable([destination,archive,archive+'.sha256',record]);
const lockIdentity=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
if(lockIdentity.name!==application.name||lockIdentity.version!==application.version||lockIdentity.packages[''].name!==application.name||lockIdentity.packages[''].version!==application.version)throw new Error('Package and lock identity must match; use npm version to update both.');
// An archive build stages inside dist/; --into stages beside its destination so
// an existing dist/ holding release archives is never touched.
const stageRoot=into?path.dirname(into):dist;fs.mkdirSync(stageRoot,{recursive:true});
const stage=fs.mkdtempSync(path.join(stageRoot,'.package-'));
function copy(from,to){fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:true,verbatimSymlinks:true});}
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const buildSources={node:{version:settings.nodeVersion,sha256:hash(node)},pi:{name:piPackage.name,version:piPackage.version},tools:{}};
try{
  for(const name of ['src','vendor','install.sh','config.json','SYSTEM.md','messages.json','portable.json','package.json','package-lock.json','README.md'])copy(path.join(root,name),path.join(stage,name));
  fs.chmodSync(path.join(stage,'install.sh'),0o755);
  // Build input dependencies are checked against the committed application lock.
  const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
  for(const [relative,record] of Object.entries(lock.packages))if(relative){
    const pkg=JSON.parse(fs.readFileSync(path.join(root,relative,'package.json'),'utf8'));
    if(pkg.version!==record.version)throw new Error('Application dependency does not match the lock file: '+relative);
  }
  copy(path.join(root,'node_modules'),path.join(stage,'node_modules'));
  copy(pi,path.join(stage,'runtime/pi'));
  const modules=piModules(pi), piStage=path.join(stage,'runtime/pi/node_modules');
  copy(modules,piStage);
  // The package itself is already at runtime/pi; drop the nested copy and the
  // bin shims that would dangle once it is gone.
  fs.rmSync(path.join(piStage,path.relative(modules,pi)),{recursive:true,force:true});
  fs.rmSync(path.join(piStage,'.bin'),{recursive:true,force:true});
  // The browser is copied as a plain directory tree: its shared libraries are
  // resolved below from the dedicated library input, not from the build host.
  const browserStage=path.join(stage,'runtime/browser');
  copy(browser.browsers,path.join(browserStage,'chromium'));
  copy(browser.libraries,path.join(browserStage,'lib'));
  copy(browser.fonts,path.join(browserStage,'fonts'));
  // Type declarations include documentation examples that are not user messages.
  // Remove comment lines containing Han characters without changing executable dependency code.
  function cleanDeclarationComments(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())cleanDeclarationComments(file);
      else if(entry.isFile()&&entry.name.endsWith('.d.ts')){
        const original=fs.readFileSync(file,'utf8');
        const cleaned=original.split(/(?<=\n)/).filter(line=>!(/^\s*(?:\/\/|\/\*|\*)/.test(line)&&/\p{Script=Han}/u.test(line))).join('');
        if(cleaned!==original)fs.writeFileSync(file,cleaned);
      }
    }
  }
  cleanDeclarationComments(path.join(stage,'runtime/pi'));
  cleanDeclarationComments(path.join(stage,'node_modules'));
  const native=path.join(stage,'runtime/native'),bin=path.join(stage,'runtime/bin'),lib=path.join(stage,'runtime/lib');
  for(const dir of [native,bin,lib,path.join(stage,'runtime/licenses')])fs.mkdirSync(dir,{recursive:true});
  copy(node,path.join(native,'node'));
  const nodeHome=path.dirname(path.dirname(node));
  copy(path.join(nodeHome,'LICENSE'),path.join(stage,'runtime/licenses/NODE-LICENSE'));
  for(const [name,file] of Object.entries(tools)){
    copy(file,path.join(native,name));buildSources.tools[name]={sha256:hash(file)};
  }
  const elfFiles=[];
  const unscanned=new Set([browserStage]);
  function scan(dir,visit){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(unscanned.has(file))continue;if(entry.isDirectory())scan(file,visit);else visit(file,entry);}}
  scan(stage,(file,entry)=>{
    if(!entry.isFile())return;
    const fd=fs.openSync(file,'r'),magic=Buffer.alloc(4);try{fs.readSync(fd,magic,0,4,0);}finally{fs.closeSync(fd);}
    if(magic.equals(Buffer.from([127,69,76,70])))elfFiles.push(file);
  });
  // Bring the runtime's loader and every ELF library into the package too.
  for(const file of elfFiles){
    let output;try{output=run('/usr/bin/ldd',[file],{stdio:['ignore','pipe','pipe']});}catch(error){output=error.stdout?.toString()||'';if(!/statically linked|not a dynamic executable/.test(output+(error.stderr?.toString()||'')))throw error;}
    if(output.includes('not found'))throw new Error('Missing shared library: '+file+'\n'+output);
    for(const match of output.matchAll(/(?:=>\s+)?(\/[^\s]+)\s+\(/g)){
      const from=fs.realpathSync(match[1]),to=path.join(lib,path.basename(match[1]));
      if(fs.existsSync(to)&&hash(to)!==hash(from))throw new Error('Shared library name conflict: '+to);
      copy(from,to);
      if(path.basename(from).startsWith('ld-linux'))copy(from,path.join(lib,'ld.so'));
    }
  }
  for(const [name,source] of Object.entries({BASH:'/usr/share/doc/bash/copyright',BUSYBOX:'/usr/share/doc/busybox/copyright','GPL-2':'/usr/share/common-licenses/GPL-2','GPL-3':'/usr/share/common-licenses/GPL-3','LGPL-2.1':'/usr/share/common-licenses/LGPL-2.1','LIBTINFO':'/usr/share/doc/libtinfo6/copyright','LIBC':'/usr/share/doc/libc6/copyright','LIBGCC':'/usr/share/doc/libgcc-s1/copyright','LIBSTDCXX':'/usr/share/doc/libstdc++6/copyright'}))copy(source,path.join(stage,'runtime/licenses',name));
  for(const [name,url] of Object.entries({RIPGREP:'https://raw.githubusercontent.com/BurntSushi/ripgrep/master/COPYING',FD:'https://raw.githubusercontent.com/sharkdp/fd/master/LICENSE-MIT'})){
    const response=await fetch(url,{signal:AbortSignal.timeout(settings.commandTimeoutMs)});if(!response.ok)throw new Error('Unable to retrieve license: '+url);fs.writeFileSync(path.join(stage,'runtime/licenses',name),await response.text());
  }
  // The browser keeps its own libraries; verify they are complete rather than
  // mixing them with the runtime libraries collected above.
  const browserExecutable=(function find(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isFile()&&entry.name==='chrome-headless-shell')return file;
      if(entry.isDirectory()){const found=find(file);if(found)return found;}
    }
    return undefined;
  })(browserStage);
  if(!browserExecutable)throw new Error('Browser build input has no chrome-headless-shell executable.');
  const browserLibraries={...process.env,LD_LIBRARY_PATH:path.join(browserStage,'lib')},browserLinkage=run('/usr/bin/ldd',[browserExecutable],{env:browserLibraries,stdio:['ignore','pipe','pipe']});
  if(browserLinkage.includes('not found'))throw new Error('Browser shared libraries are incomplete:\n'+browserLinkage);
  const compilerTmp=path.join(stage,'.compiler-tmp');fs.mkdirSync(compilerTmp);
  run('/usr/bin/gcc',['-static','-O2','-Wall','-Wextra','-Werror',path.join(root,'native/launcher.c'),'-o',path.join(stage,'xltx')],{env:{...process.env,TMPDIR:compilerTmp}});
  fs.rmSync(compilerTmp,{recursive:true,force:true});
  const applets=run(tools.busybox,['--list']).trim().split('\n').filter(name=>name&&!name.includes('/'));
  for(const name of new Set(['node','pi',...Object.keys(tools),...applets]))fs.symlinkSync('../../xltx',path.join(bin,name));
  // No personal credentials, login state or development data is copied.
  fs.writeFileSync(path.join(stage,'runtime/build-info.json'),JSON.stringify({...buildSources,name:application.name,version:application.version,platform:settings.platform,arch:settings.arch,createdAt:new Date().toISOString()},null,2)+'\n');
  const files=[];
  scan(stage,(file,entry)=>{
    const relative=path.relative(stage,file),stat=fs.lstatSync(file);
    if(entry.isSymbolicLink()){
      if(!fs.realpathSync(file).startsWith(stage+path.sep))throw new Error('Build contains an external symlink: '+relative);
      files.push({path:relative,target:fs.readlinkSync(file)});
    }else if(entry.isFile())files.push({path:relative,mode:stat.mode&0o777,sha256:hash(file)});
    else throw new Error('Unsupported file type in package: '+relative);
  });
  fs.writeFileSync(path.join(stage,'runtime/manifest.json'),JSON.stringify({files},null,2)+'\n');
  verifyBundle(stage);
  run(path.join(stage,'xltx'),['check'],{env:{PATH:'/no-system-node-or-pi',HOME:path.join(stage,'unused-host-home')}});
  // Runtime smoke-check output is not shipped as user data.
  fs.rmSync(path.join(stage,'data'),{recursive:true,force:true});fs.rmSync(path.join(stage,'workspace'),{recursive:true,force:true});
  if(into){
    fs.rmSync(into,{recursive:true,force:true});fs.renameSync(stage,into);
    console.log(into);
  }else{
    fs.renameSync(stage,destination);
    run('/usr/bin/tar',['-czf',archive,'-C',dist,name]);
    fs.writeFileSync(archive+'.sha256',hash(archive)+'  '+path.basename(archive)+'\n');
    fs.mkdirSync(path.dirname(record),{recursive:true});
    fs.writeFileSync(record,JSON.stringify({name:application.name,version:application.version,artifact:path.relative(root,archive),sha256:hash(archive),bytes:fs.statSync(archive).size,nodeVersion:settings.nodeVersion,piVersion:settings.piVersion,platform:settings.platform,arch:settings.arch},null,2)+'\n',{flag:'wx'});
    console.log(archive);console.log('SHA256 '+hash(archive));
  }
}catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
