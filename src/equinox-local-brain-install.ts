import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { protectWindowsPrivateStatePath } from "./equinox-local-private-state.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

// Reviewed upstream release; never resolve `latest` or execute an unpinned URL.
export const BRAIN_RELEASE = Object.freeze({version:"3.17.0",bytes:780632,
  sha256:"8d665e30cd755e61d3b8d87bca5b5a70dfc5c985c3823a212b1c05618b1eea3b",
  url:"https://github.com/avenoxai/avenoxbeyin/releases/download/v3.17.0/beyin-v3-3.17.0.zip"});
const LICENSE = `MIT License

Copyright (c) 2026 Avenox

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
const execFile = promisify(execFileCallback);
function invalid(message:string) { return Object.assign(new Error(message),{statusCode:400}); }

function pythonEnvironment(): NodeJS.ProcessEnv {
  // The optional upstream engine never inherits runtime API keys, agent
  // session variables, Python injection environment or arbitrary PATH aliases.
  const env:NodeJS.ProcessEnv={};
  for (const [key,value] of Object.entries(process.env)) {
    if (["HOME","USERPROFILE","LOCALAPPDATA","APPDATA","SYSTEMROOT","WINDIR","SYSTEMDRIVE","TEMP","TMP","TMPDIR","LANG","LC_ALL"].includes(key.toUpperCase())) env[key]=value;
  }
  return env;
}
async function pythonCandidates(): Promise<{command:string;prefix:string[]}[]> {
  if (process.platform === "darwin") return ["/opt/homebrew/bin/python3","/usr/local/bin/python3","/Library/Frameworks/Python.framework/Versions/Current/bin/python3"].map(command=>({command,prefix:[]}));
  if (process.platform !== "win32") return [];
  const candidates:{command:string;prefix:string[]}[]=[];
  const windows=process.env.SystemRoot || process.env.WINDIR;
  const local=process.env.LOCALAPPDATA;
  if (windows && path.isAbsolute(windows)) candidates.push({command:path.join(windows,"py.exe"),prefix:["-3"]});
  if (local && path.isAbsolute(local)) {
    // Modern Python Install Manager stores real runtimes here. Avoid its
    // auto-installing aliases: probe only an existing interpreter binary.
    const managed=path.join(local,"Python");
    for(const entry of (await fs.readdir(managed,{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory()&&/^pythoncore-3\.\d{2}-(?:32|64|arm64)$/iu.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,12)) candidates.push({command:path.join(managed,entry.name,"python.exe"),prefix:[]});
    const root=path.join(local,"Programs","Python");
    candidates.push({command:path.join(root,"Launcher","py.exe"),prefix:["-3"]});
    for (const entry of (await fs.readdir(root,{withFileTypes:true}).catch(()=>[])).filter(e=>e.isDirectory()&&/^Python3\d{2}$/u.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,12)) candidates.push({command:path.join(root,entry.name,"python.exe"),prefix:[]});
  }
  return candidates;
}
export async function findBrainPython(): Promise<string> {
  for (const {command,prefix} of await pythonCandidates()) {
    try {
      const real=await fs.realpath(command);
      if (!(await fs.stat(real)).isFile()) continue;
      const {stdout}=await execFile(real,[...prefix,"-I","-X","utf8","-c","import sys, json; print(json.dumps({'path':sys.executable,'version':list(sys.version_info[:3])}))"],{windowsHide:true,timeout:3000,maxBuffer:8192,env:pythonEnvironment()});
      const result=JSON.parse(stdout);
      if (result.version?.[0]!==3 || result.version?.[1]<11 || typeof result.path!=="string" || !path.isAbsolute(result.path)) continue;
      const executable=await fs.realpath(result.path);
      if ((await fs.stat(executable)).isFile()) return executable;
    } catch { /* Try the next explicit standard installation location. */ }
  }
  throw invalid("Python 3.11 or newer is required. Install Python from python.org or a standard system installation before continuing.");
}

async function downloadRelease(): Promise<Buffer> {
  const signal=AbortSignal.timeout(30_000);
  const options:RequestInit={redirect:"manual",cache:"no-store",credentials:"omit",signal};
  let response=await fetch(BRAIN_RELEASE.url,options);
  if ([301,302,303,307,308].includes(response.status)) {
    const location=response.headers.get("location");
    if (!location) throw new Error("Missing release redirect.");
    const target=new URL(location,BRAIN_RELEASE.url);
    if (target.protocol!=="https:" || target.hostname!=="release-assets.githubusercontent.com" || target.port || target.username || target.password || !target.pathname.startsWith("/github-production-release-asset/")) throw new Error("Unexpected release redirect.");
    await response.body?.cancel();
    response=await fetch(target,{...options,redirect:"error"});
  }
  if (!response.ok || !response.body) throw new Error("Release download failed.");
  const reader=response.body.getReader(); const chunks:Buffer[]=[]; let length=0;
  try {
    while(true) { const result=await reader.read(); if(result.done)break; length+=result.value.length; if(length>BRAIN_RELEASE.bytes)throw new Error("Release exceeds the expected size."); chunks.push(Buffer.from(result.value)); }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const data=Buffer.concat(chunks,length);
  if(length!==BRAIN_RELEASE.bytes || createHash("sha256").update(data).digest("hex")!==BRAIN_RELEASE.sha256)throw new Error("Release integrity verification failed.");
  return data;
}
const EXTRACT = `import pathlib, stat, sys, zipfile
root = pathlib.Path(sys.argv[2])
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 256 or sum(e.file_size for e in entries) > 8 * 1024 * 1024:
        raise ValueError('archive bounds')
    seen = set()
    for entry in entries:
        name = entry.filename.rstrip('/')
        parts = name.split('/')
        if not name or any(not p or p in ('.', '..') or ':' in p or '\\\\' in p or p.endswith(('.', ' ')) for p in parts):
            raise ValueError('unsafe archive path')
        key = name.casefold()
        if key in seen or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise ValueError('duplicate or unsafe archive entry')
        seen.add(key)
    archive.extractall(root)
`;

export async function installBrainVault(vault:string,stateRoot:string): Promise<void> {
  const directory=await fs.lstat(vault).catch(()=>null);
  if (!directory?.isDirectory() || directory.isSymbolicLink()) throw invalid("Select a new empty folder for the memory vault.");
  const canonical=await fs.realpath(vault);
  const ownedRoot=await fs.realpath(stateRoot);
  const relative=path.relative(ownedRoot,canonical);
  if (!relative || (!relative.startsWith(".."+path.sep) && relative!==".." && !path.isAbsolute(relative))) throw invalid("Choose a vault outside Equinox Local's managed state folder.");
  if ((await fs.readdir(canonical)).length) throw invalid("New vault installation requires an empty folder. Use Connect existing for an existing Beyin vault.");
  const python=await findBrainPython();
  const staging=await fs.mkdtemp(path.join(stateRoot,".brain-install-"));
  try {
    if(process.platform==="win32") await protectWindowsPrivateStatePath({target:staging,type:"directory"});
    const archive=path.join(staging,"release.zip");
    const packageRoot=path.join(staging,"package");
    await fs.writeFile(archive,await downloadRelease(),{flag:"wx",mode:0o600});
    await fs.mkdir(packageRoot,{mode:0o700});
    await execFile(python,["-I","-X","utf8","-c",EXTRACT,archive,packageRoot],{cwd:staging,env:pythonEnvironment(),windowsHide:true,timeout:15000,maxBuffer:64*1024});
    // Recheck the user's target after network work. Upstream owns the local
    // installer and state binding; EL never overwrites an existing vault.
    if(await fs.realpath(vault)!==canonical || (await fs.readdir(canonical)).length) throw invalid("The selected folder changed. Choose an empty folder again.");
    await execFile(python,["-I","-X","utf8",path.join(packageRoot,"scripts","install_v3.py"),"--vault",canonical],{cwd:staging,env:pythonEnvironment(),windowsHide:true,timeout:60000,maxBuffer:256*1024});
    await fs.writeFile(path.join(canonical,"AVENOX-BEYIN-LICENSE.txt"),LICENSE,{flag:"wx",mode:0o600});
  } catch(error) {
    if((error as {statusCode?:number})?.statusCode===400)throw error;
    throw invalid("Brain installation could not finish. Any created vault files have been preserved; inspect the folder before retrying.");
  } finally { await fs.rm(staging,{recursive:true,force:true}); }
}

// Use the reviewed source archive instead of importing executable code from
// a user-selected existing vault. The cache is data, verified on every use.
function releaseCache(stateRoot:string) { return path.join(stateRoot, `brain-${BRAIN_RELEASE.version}.zip`); }
async function cachedRelease(stateRoot:string):Promise<Buffer> {
  const {data}=await readBoundedNormalFile(releaseCache(stateRoot),{minBytes:BRAIN_RELEASE.bytes,maxBytes:BRAIN_RELEASE.bytes,requireSingleLink:true});
  if(createHash("sha256").update(data).digest("hex")!==BRAIN_RELEASE.sha256)throw invalid("Brain engine integrity check failed.");
  return data;
}
export async function brainEngineDiagnostics(stateRoot:string) {
  const python = await findBrainPython().then(async executable => {
    const {stdout}=await execFile(executable,["-I","-X","utf8","-c","import sys; print('.'.join(map(str,sys.version_info[:3])))"],{windowsHide:true,timeout:3000,maxBuffer:256,env:pythonEnvironment()});
    const version=stdout.trim(); return /^\d+\.\d+\.\d+$/u.test(version)?version:null;
  }).catch(()=>null);
  const archive=await cachedRelease(stateRoot).then(()=>"verified" as const).catch(error=>(error as NodeJS.ErrnoException).code==="ENOENT"?"not-prepared" as const:"invalid" as const);
  return {python,archive};
}
export async function prepareBrainEngine(stateRoot:string):Promise<void> {
  await findBrainPython();
  try { await cachedRelease(stateRoot); return; }
  catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw invalid("The cached Brain engine is invalid."); }
  const data=await downloadRelease();
  const file=releaseCache(stateRoot);
  await fs.writeFile(file,data,{flag:"wx",mode:0o600});
  if(process.platform==="win32")await protectWindowsPrivateStatePath({target:file,type:"file"});
}
const MEMORY = `import json, pathlib, sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'template/.claude/scripts'))
from beyin_v3 import MemoryStore, _status_allowed
request = json.load(sys.stdin)
fields = ('id','source','title','text','kind','status','visibility','updated_at','text_truncated','revision','source_sha256','owner','next_action')
def remote(record):
    return record.get('visibility') in ('public','internal') and record.get('remote_allowed') is not False
def visible_exact(store, record_id, project):
    records = store._records()
    eligible, _ = store._eligible('internal', project, records=records)
    retired = store._superseded_ids(records)
    return next((r for r in eligible if r['id'] == record_id and r['id'] not in retired and _status_allowed(r, None) and remote(r)), None)
if request['action'] == 'sync':
    from beyin_v3_sync import SyncEngine
    result = SyncEngine(request['vault'], request['state']).sync()
    print(json.dumps({'status':result.get('status', 'succeeded')}, ensure_ascii=False))
elif request['action'] == 'lifecycle_sync':
    from beyin_v3_preferences import read, claim_check
    prefs = read(request['vault'])
    if prefs['context_mode'] == 'off' or not prefs['auto_sync'] or not claim_check(request['state'],prefs,request['event']):
        print(json.dumps({'status':'skipped'}))
    else:
        from beyin_v3_sync import SyncEngine
        result = SyncEngine(request['vault'],request['state']).sync()
        print(json.dumps({'status':result.get('status','succeeded')}))
elif request['action'] in ('search','context'):
    budget = request['budget']
    context_mode = None
    if request['action'] == 'context':
        from beyin_v3_preferences import read
        prefs = read(request['vault'])
        context_mode = prefs['context_mode']
        if context_mode == 'off':
            print(json.dumps({'records':[],'citations':[],'abstained':True,'contextMode':'off','reason':'Manual profile disables contextual assistance; explicit brain_search remains available.'}))
            sys.exit(0)
        budget = min(budget,prefs['context_chars'])
    store = MemoryStore(request['state'], request['vault'], read_only=True)
    result = store.retrieve(request['query'], project=request.get('project'), audience='internal', limit=request['limit'], budget_chars=budget, explicit=True)
    # No unrestricted metadata or private/untrusted sources cross the MCP boundary.
    records = [{k:r[k] for k in fields if k in r} for r in result['records'] if remote(r)]
    print(json.dumps({'records':records,'citations':[{'id':r['id'],'source':r['source']} for r in records],'abstained':not records,'truncated':result.get('truncated',False) or len(records)!=len(result['records']),'stale_count':result.get('stale_count',0),**({'contextMode':context_mode,'budget':budget} if context_mode is not None else {})},ensure_ascii=False))
elif request['action'] == 'read':
    store = MemoryStore(request['state'], request['vault'], read_only=True)
    record = visible_exact(store, request['id'], request.get('project'))
    if record is None:
        print(json.dumps({'found':False}))
    else:
        item = {k:record[k] for k in fields if k in record}
        text = item.get('text', '')
        item['text'] = text[:request['budget']]
        item['text_truncated'] = len(text) > request['budget']
        print(json.dumps({'found':True,'record':item,'citation':{'id':item['id'],'source':item['source']}},ensure_ascii=False))
elif request['action'] == 'create':
    from beyin_v3_sync import SyncEngine
    from beyin_v3_secrets import redact
    import hashlib
    engine = SyncEngine(request['vault'], request['state'])
    # Always screen EL agent writes without changing the shared vault's preferences.
    if any(redact(request[field], engine.state)[1] for field in ('title','text','project') if request.get(field)):
        print(json.dumps({'status':'refused','reason':'Potential secret detected; remove it before saving.'}))
        sys.exit(0)
    key = 'el-' + hashlib.sha256(request['key'].encode('ascii')).hexdigest()
    record_id = key
    source = 'notes/' + key + '.md'
    metadata = {'id':record_id,'title':request['title'],'kind':'note','revision':1,'status':'active','visibility':'internal','facts':{'origin':'Equinox Local / ChatGPT Web'}}
    if request.get('project'):
        metadata['project'] = request['project']
    result = engine.note_create(source, request['text'], metadata, idempotency_key=key)
    print(json.dumps({'status':result['status'],'id':record_id,'source':source,'sha256':result['sha256'],'secrets_redacted':result.get('secrets_redacted',0)},ensure_ascii=False))
elif request['action'] == 'diagnostics':
    store = MemoryStore(request['state'],request['vault'],read_only=True)
    from beyin_v3_preferences import read
    preferences = read(request['vault'])
    with store._connect() as db:
        healthy = db.execute('PRAGMA quick_check(1)').fetchone()[0] == 'ok'
    print(json.dumps({'indexHealthy':healthy,'preferencesValid':True}))
elif request['action'] in ('preferences','profile'):
    from beyin_v3_preferences import read, save, PROFILES
    prefs = save(request['vault'], {}, profile=request['profile']) if request['action'] == 'profile' else read(request['vault'])
    profile = next((name for name,values in PROFILES.items() if all(prefs.get(k)==v for k,v in values.items() if k!='secret_filter')), 'custom')
    print(json.dumps({'profile':profile,'autoSync':prefs['auto_sync'],'contextMode':prefs['context_mode'],'contextChars':prefs['context_chars'],'intervalMinutes':prefs['interval_minutes'],'secretFilter':prefs['secret_filter']}))
elif request['action'] in ('edit','task_create','task_update','receipt'):
    from beyin_v3_sync import SyncEngine, parse
    from beyin_v3_secrets import redact
    import hashlib
    engine = SyncEngine(request['vault'], request['state'])
    store = engine.store
    action = request['action']
    if any(redact(request[field], engine.state)[1] for field in ('title','text','project','new','owner','nextAction','summary') if request.get(field)):
        print(json.dumps({'status':'refused','reason':'Potential secret detected; remove it before saving.'}))
        sys.exit(0)
    if action == 'edit':
        record = visible_exact(store, request['id'], request.get('project'))
        if record is None or record.get('kind') != 'note' or not record['source'].startswith(('notes/','knowledge/')):
            raise ValueError('current visible human note required')
        note = engine.note_read(record['source'])
        if not note['exists'] or note['sha256'] != request['sha256']:
            raise ValueError('source changed; reread the note')
        metadata, body = parse(note['content'])
        old, new = request['old'], request['new']
        if body.count(old) != 1 or note['content'].count(old) != 1:
            raise ValueError('body anchor must be unique')
        candidate = note['content'].replace(old,new,1)
        if parse(candidate)[0] != metadata or redact(candidate,engine.state)[1]:
            raise ValueError('metadata changes or secrets are not allowed')
        result = engine.note_edit({'source':record['source'],'expected_sha256':request['sha256'],'edits':[{'old':old,'new':new}]})
        print(json.dumps({'status':result['status'],'id':record['id'],'source':record['source'],'sha256':result['sha256']}))
    elif action == 'task_create':
        record_id = 'el-task-' + hashlib.sha256(request['key'].encode('ascii')).hexdigest()
        source = 'tasks/' + record_id + '.md'
        metadata = {'id':record_id,'title':request['title'],'kind':'task','revision':1,'status':'inbox','owner':request['owner'],'visibility':'internal','facts':{'origin':'Equinox Local / ChatGPT Web'}}
        if request.get('project'):
            metadata['project'] = request['project']
        if request.get('nextAction'):
            metadata['next_action'] = request['nextAction']
        result = engine.task_create(source,request['text'],metadata)
        print(json.dumps({'status':'succeeded','id':record_id,'source':source,'revision':result['revision']}))
    elif action == 'task_update':
        record = visible_exact(store,request['id'],request.get('project'))
        if record is None or record.get('kind') != 'task' or not record['source'].startswith('tasks/'):
            raise ValueError('current visible task required')
        changes = {'status':request['status']}
        if 'nextAction' in request:
            changes['next_action'] = request['nextAction']
        result = engine.update_task(record['id'],request['revision'],changes)
        print(json.dumps({'status':'succeeded','taskStatus':result['status'],'id':record['id'],'source':record['source'],'revision':result['revision']}))
    else:
        refs = []
        for record_id in request['refs']:
            record = visible_exact(store,record_id,request.get('project'))
            if record is None:
                raise ValueError('current visible evidence required')
            refs.append(record['source'])
        event_id = 'el-receipt-' + hashlib.sha256(request['key'].encode('ascii')).hexdigest()
        # Upstream lacks a ChatGPT harness enum. Its neutral manual receipt
        # explicitly attributes the origin without impersonating another client.
        result = engine.receipt(event_id,'Equinox Local / ChatGPT Web: '+request['summary'],refs,'manual')
        print(json.dumps({'status':result['status'],'id':event_id,'source':result['source']}))
else:
    raise ValueError('unsupported operation')
`;
export async function runBrainMemory(stateRoot:string,request: {action:"sync"|"search"|"read"|"create"|"edit"|"task_create"|"task_update"|"receipt"|"preferences"|"profile"|"diagnostics"|"context"|"lifecycle_sync";vault:string;state:string;query?:string;project?:string;limit?:number;budget?:number;id?:string;key?:string;title?:string;text?:string;sha256?:string;old?:string;new?:string;owner?:string;nextAction?:string;status?:string;revision?:number;summary?:string;refs?:string[];profile?:string;event?:"SessionStart"|"UserPromptSubmit"}):Promise<any> {
  const data=await cachedRelease(stateRoot).catch(()=>{throw invalid("Enable Brain memory access in Control Center to prepare the verified engine.");});
  const python=await findBrainPython();
  const staging=await fs.mkdtemp(path.join(stateRoot,".brain-memory-"));
  try {
    if(process.platform==="win32")await protectWindowsPrivateStatePath({target:staging,type:"directory"});
    const archive=path.join(staging,"release.zip"),packageRoot=path.join(staging,"package");
    await fs.writeFile(archive,data,{flag:"wx",mode:0o600});
    await fs.mkdir(packageRoot,{mode:0o700});
    await execFile(python,["-I","-X","utf8","-c",EXTRACT,archive,packageRoot],{cwd:staging,env:pythonEnvironment(),windowsHide:true,timeout:15000,maxBuffer:65536});
    // Request JSON travels over stdin, not the OS-visible process command line.
    const stdout=await new Promise<string>((resolve,reject)=>{
      const child=execFileCallback(python,["-I","-X","utf8","-c",MEMORY,packageRoot],{cwd:staging,env:pythonEnvironment(),windowsHide:true,timeout:45000,maxBuffer:256*1024,encoding:"utf8"},(error,out)=>error?reject(error):resolve(out));
      child.stdin?.on("error",()=>{}); child.stdin?.end(JSON.stringify(request));
    });
    return JSON.parse(stdout);
  } catch { throw invalid("Brain operation could not finish. Check the vault, Python installation and local index in Control Center."); }
  finally { await fs.rm(staging,{recursive:true,force:true}); }
}
