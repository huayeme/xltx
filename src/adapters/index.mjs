import {copy} from '../copy.mjs';
const adapters={pi:()=>import('./pi/index.mjs')};

export async function loadAdapter(config) {
  const name=config.backend||'pi';
  const load=adapters[name];
  if(typeof load!=='function'||!Object.hasOwn(adapters,name))throw new Error(copy.adapter.unknownBackend(name));
  const adapter=await load();
  const options=adapter.configure(config);
  return {
    checkRuntime:()=>adapter.checkRuntime(options),
    create:settings=>adapter.create(options,settings),
  };
}
