import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BRAIN_RELEASE, installBrainVault, prepareBrainEngine, runBrainMemory } from "./equinox-local-brain-install.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { inspectPrivateStatePath, protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";

type BrainConnection = { vault: string; version: string; searchEnabled?: boolean; writeEnabled?: boolean; indexState?: string };
type VaultMetadata = {vault:string;version:string;indexState:string};
const MAX_SETTINGS_BYTES = 8192;
const VERSION = /^\d+\.\d+\.\d+$/u;
function invalid(message: string): Error { return Object.assign(new Error(message), { statusCode: 400 }); }
function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && path.isAbsolute(value) && path.parse(value).root !== value && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function inspectVault(vault: string): Promise<VaultMetadata> {
  // Registration is read-only: selecting a vault does not execute its Python,
  // change its hook configuration, or add it to agent filesystem permissions.
  try {
    const folder = await fs.lstat(vault);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("invalid folder");
    const canonical = await fs.realpath(vault);
    const entry = await fs.lstat(path.join(canonical, "beyin.py"));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("missing CLI");
    const {data: stamp} = await readBoundedNormalFile(path.join(canonical, ".beyin-version"), {maxBytes: 128, encoding:"utf8", requireSingleLink:true});
    const {data: raw} = await readBoundedNormalFile(path.join(canonical, ".beyin-runtime.json"), {maxBytes: MAX_SETTINGS_BYTES, encoding:"utf8", requireSingleLink:true});
    const pin = JSON.parse(raw as string);
    const version = (stamp as string).trim();
    if (!VERSION.test(version) || !version.startsWith("3.") || pin.schema !== 1 || !validPath(pin.state)) throw new Error("invalid V3 metadata");
    const relative = path.relative(canonical, path.resolve(pin.state));
    if (!relative || (!relative.startsWith(".."+path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("state inside vault");
    return {vault:canonical,version,indexState:path.resolve(pin.state)};
  } catch { throw invalid("Select an installed Avenox Beyin V3 vault containing beyin.py and its installation metadata."); }
}

export function createPluginCatalog(stateRoot: string) {
  const file = path.join(stateRoot, "plugins.json");
  async function read(): Promise<BrainConnection | null> {
    const security = await inspectPrivateStatePath(file, {type:"file",mode:"600",verifyWindowsAcl:verifyWindowsPrivateStateAcl});
    if (security.reason === "missing") return null;
    if (!security.safe) throw invalid("Plugin settings are unavailable or unsafe.");
    const {data} = await readBoundedNormalFile(file,{maxBytes:MAX_SETTINGS_BYTES,encoding:"utf8",requireSingleLink:true});
    const parsed = JSON.parse(data as string);
    if (parsed.schema !== 1 || (parsed.brain !== null && (!validPath(parsed.brain?.vault) || !VERSION.test(parsed.brain?.version)))) throw invalid("Plugin settings are invalid.");
    if(parsed.brain && (parsed.brain.searchEnabled!==undefined && typeof parsed.brain.searchEnabled!=="boolean" || parsed.brain.searchEnabled===true && !validPath(parsed.brain.indexState)))throw invalid("Plugin settings are invalid.");
    if(parsed.brain && (parsed.brain.writeEnabled!==undefined && typeof parsed.brain.writeEnabled!=="boolean" || parsed.brain.writeEnabled===true && !parsed.brain.searchEnabled))throw invalid("Plugin settings are invalid.");
    return parsed.brain;
  }
  async function save(brain: BrainConnection | null) {
    await read(); // Never replace an unsafe or malformed settings file.
    const temp = path.join(stateRoot, `.plugins-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify({schema:1,brain})+"\n", {flag:"wx",mode:0o600});
      if (process.platform === "win32") await protectWindowsPrivateStatePath({target:temp,type:"file"});
      await fs.rename(temp,file);
    } finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
  }
  async function status() {
    const brain = await read();
    if (!brain) return {brain:null, offeredVersion:BRAIN_RELEASE.version};
    const base={vault:brain.vault,version:brain.version,searchEnabled:brain.searchEnabled===true,writeEnabled:brain.writeEnabled===true};
    try {
      const actual=await inspectVault(brain.vault);
      return {brain:{...base,version:actual.version,available:true,searchCompatible:actual.version===BRAIN_RELEASE.version && (!brain.searchEnabled || actual.indexState===brain.indexState)},offeredVersion:BRAIN_RELEASE.version};
    } catch { return {brain:{...base,available:false,searchCompatible:false},offeredVersion:BRAIN_RELEASE.version}; }
  }
  async function engineConnection(brain:BrainConnection) {
    const actual=await inspectVault(brain.vault);
    if(actual.version!==BRAIN_RELEASE.version)throw invalid(`Agent memory currently requires Beyin ${BRAIN_RELEASE.version}. The connected vault has not been changed.`);
    const canonicalState=await fs.realpath(actual.indexState).catch(()=>null);
    if(!canonicalState || canonicalState!==actual.indexState || !(await fs.lstat(canonicalState)).isDirectory())throw invalid("The vault's local index folder is unavailable or redirected.");
    if(brain.searchEnabled && brain.indexState!==canonicalState)throw invalid("The vault's local index binding changed. Disable and re-enable memory access in Control Center.");
    return {vault:actual.vault,state:canonicalState};
  }
  return {status, async connect(value: unknown) {
    if (!validPath(value)) throw invalid("Choose an absolute vault folder.");
    if (await read()) throw invalid("Disconnect the current vault before connecting another.");
    const brain = await inspectVault(value);
    await save({vault:brain.vault,version:brain.version,searchEnabled:false});
    return status();
  }, async install(value:unknown) {
    if(!validPath(value))throw invalid("Choose an absolute vault folder.");
    if(await read())throw invalid("Disconnect the current vault before installing another.");
    await installBrainVault(value,stateRoot);
    const brain=await inspectVault(value);
    if(brain.version!==BRAIN_RELEASE.version)throw invalid("Installed vault version could not be confirmed.");
    await save({vault:brain.vault,version:brain.version,searchEnabled:false});
    return status();
  }, async setSearchEnabled(enabled:unknown) {
    if(typeof enabled!=="boolean")throw invalid("Choose whether agent memory search is enabled.");
    const brain=await read(); if(!brain)throw invalid("Connect a memory vault first.");
    if(!enabled) { await save({vault:brain.vault,version:brain.version,searchEnabled:false}); return status(); }
    const connection=await engineConnection(brain);
    await prepareBrainEngine(stateRoot);
    // Explicit human opt-in prepares the engine and syncs the source-backed index.
    const result=await runBrainMemory(stateRoot,{action:"sync",...connection});
    if(!["succeeded","degraded"].includes(result.status))throw invalid("The Brain index could not be refreshed.");
    await save({vault:brain.vault,version:BRAIN_RELEASE.version,searchEnabled:true,indexState:connection.state});
    return status();
  }, async setWriteEnabled(enabled:unknown) {
    if(typeof enabled!=="boolean")throw invalid("Choose whether agent memory writing is enabled.");
    const brain=await read(); if(!brain?.searchEnabled)throw invalid("Enable agent memory search first.");
    if(enabled)await engineConnection(brain);
    await save({...brain,writeEnabled:enabled});
    return status();
  }, async sync() {
    const brain=await read(); if(!brain?.searchEnabled)throw invalid("Enable agent memory search first.");
    const connection=await engineConnection(brain);
    const result=await runBrainMemory(stateRoot,{action:"sync",...connection});
    if(!["succeeded","degraded"].includes(result.status))throw invalid("The Brain index could not be refreshed.");
    return {plugins:await status(),indexStatus:result.status};
  }, async search(input:{query:string;project?:string;limit:number;budget:number}) {
    const brain=await read(); if(!brain?.searchEnabled)throw invalid("Equinox Brain memory search is disabled. The user can enable it in Control Center.");
    const {query,project,limit,budget}=input;
    if(typeof query!=="string" || !query.trim() || query.length>2000 ||
       (project!==undefined && (typeof project!=="string" || !project.trim() || project.length>160)) ||
       !Number.isInteger(limit) || limit<1 || limit>10 || !Number.isInteger(budget) || budget<1000 || budget>8000)throw invalid("Invalid bounded memory search request.");
    const connection=await engineConnection(brain);
    return runBrainMemory(stateRoot,{action:"search",...connection,query,...(project===undefined?{}:{project}),limit,budget});
  }, async readMemory(input:{id:string;project?:string;budget:number}) {
    const brain=await read(); if(!brain?.searchEnabled)throw invalid("Equinox Brain memory access is disabled.");
    const {id,project,budget}=input;
    if(typeof id!=="string" || !id.trim() || id.length>200 || (project!==undefined && (typeof project!=="string" || !project.trim() || project.length>160)) || !Number.isInteger(budget) || budget<1000 || budget>8000)throw invalid("Invalid memory read request.");
    return runBrainMemory(stateRoot,{action:"read",...await engineConnection(brain),id,budget,...(project===undefined?{}:{project})});
  }, async createMemory(input:{key:string;title:string;text:string;project?:string}) {
    const brain=await read(); if(!brain?.searchEnabled || !brain.writeEnabled)throw invalid("Equinox Brain memory writing is disabled. The user can enable it in Control Center.");
    const {key,title,text,project}=input;
    if(typeof key!=="string" || !/^[a-zA-Z0-9_-]{8,100}$/u.test(key) || typeof title!=="string" || !title.trim() || title.length>160 || typeof text!=="string" || !text.trim() || text.length>12000 || (project!==undefined && (typeof project!=="string" || !project.trim() || project.length>160)))throw invalid("Invalid memory note request.");
    return runBrainMemory(stateRoot,{action:"create",...await engineConnection(brain),key,title,text,...(project===undefined?{}:{project})});
  }, async disconnect() { await save(null); return status(); }};
}
