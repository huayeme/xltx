import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {installRoot,requirePortable} from '../../portable.mjs';
import {preparePi} from './runtime.mjs';
import {forwardedArguments} from './arguments.mjs';
requirePortable();
preparePi();
const packageDir=path.join(installRoot,'runtime/pi');
const pkg=JSON.parse(fs.readFileSync(path.join(packageDir,'package.json'),'utf8'));
const bin=typeof pkg.bin==='string'?pkg.bin:pkg.bin?.pi;
if(typeof bin!=='string')throw new Error('Bundled Pi does not declare a launch entry.');
const entry=fs.realpathSync(path.resolve(packageDir,bin));
if(!entry.startsWith(packageDir+path.sep))throw new Error('Pi launch entry is outside the install directory.');
const args=process.argv.slice(2);
// Only extensions shipped inside the installation directory are loaded.
const extensions=['browser','schedule'].map(name=>path.join(installRoot,'src/extensions',name,'index.mjs'));
for(const extension of extensions)if(!fs.existsSync(extension))throw new Error('Bundled extension missing: '+path.relative(installRoot,extension));
// Management subcommands dispatch on argv[0] and have their own option parser.
// Prompt/RPC runs keep Pi's default context files, system prompt and project
// trust behaviour; only the bundled extension is added.
process.argv=[process.execPath,entry,...forwardedArguments(args,extensions)];
await import(pathToFileURL(entry).href);
