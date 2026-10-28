import fs from 'node:fs';

export const application=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
export function releaseName(pkg,settings){
  if(pkg.name!=='xltx'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version))throw new Error('Release requires xltx and a major.minor.patch version.');
  for(const value of [settings.platform,settings.arch])if(typeof value!=='string'||!/^[a-z0-9]+$/.test(value))throw new Error('Invalid release platform or architecture.');
  return `${pkg.name}-${pkg.version}-${settings.platform}-${settings.arch}`;
}
export function assertReleaseAvailable(files){
  for(const file of files)if(fs.existsSync(file))throw new Error('Release already exists; increase package.json version: '+file);
}
