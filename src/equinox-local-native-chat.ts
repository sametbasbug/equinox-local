import { chatGptConversationIdFromUrl } from "./telegram-chat-bridge-controller.js";

type BrowserTab = {id?:number;tabId?:number;url?:string;title?:string};
type Binding = {browserContext:"user";browserInstanceId:string;tabId:number;conversationId:string;canonicalUrl:string};
type Message = {id:string;role:"user"|"assistant";text:string;status:"sent"|"complete"|"uncertain";truncated?:boolean;richText?:string|null};
type BrowserBridge = {snapshot:()=>any;call:(method:string,args:object,options:{context:"user";timeoutMs:number})=>Promise<unknown>};
type ChatBridge = {
  inspectTurnIdentity:(args:{binding:Binding})=>Promise<any>;
  deliverText:(args:{binding:Binding;deliveryId:string;text:string;requireExactTab?:boolean})=>Promise<any>;
  readFinal:(args:{binding:Binding;userEpoch:string;previousAssistantTurnKey:string|null})=>Promise<any>;
  readRecent?:(args:{binding:Binding})=>Promise<any>;
  readLive?:(args:{binding:Binding;userEpoch:string})=>Promise<any>;
  startTaskChat?:(args:{taskId:string;checkpointRevision:number;initialMessage:string;
    modelChoice?:string;effortLevel?:number})=>Promise<any>;
};
type TaskStore = {
  checkpoint:(args:{title:string;objective:string;completed:string[];next:string[];references:{type:string;label:string;value:string}[]})=>Promise<any>;
  bindChat:(args:{taskId:string;binding:Binding})=>Promise<any>;
  cancel?:(taskId:string)=>Promise<any>;
  list:(args:{limit:number})=>Promise<any[]>;
  readInternal?:(taskId:string)=>Promise<{taskId:string;status:string;chatBinding?:Binding|null}>;
};
const MAX_MESSAGES = 30;
const MAX_TRANSCRIPT_CHARS = 96_000;
const MAX_ASSISTANT_CHARS = 12_000;
const MAX_DELIVERY_IDS = 2_048;
const MAX_NEW_CHAT_IDS = 512;
function invalid(message:string):never {const error:Error&{statusCode?:number}=new Error(message);error.statusCode=400;throw error;}
function safeTitle(value:unknown):string {return typeof value==="string"?value.replace(/[\x00-\x1f\x7f]/gu," ").trim().slice(0,120):"ChatGPT conversation";}
/** Current-user native Chat transport. The browser remains the ChatGPT session authority. */
export function createNativeChatController({browserBridge,chatBridge,taskStore}:{browserBridge:BrowserBridge;chatBridge:ChatBridge;taskStore?:TaskStore}) {
  let selected:Binding|null=null;
  let messages:Message[]=[];
  let history:Message[]=[];
  let historyPartial=false;
  let historyNotice:string|null=null;
  let historyPendingHydration=0;
  let pending:{userEpoch:string;previousAssistantTurnKey:string|null;deliveryId:string}|null=null;
  let awaitingNewChatIdentity:{conversationId:string;text:string;deliveryId:string}|null=null;
  let sending=false;
  let creating=false;
  let previousHistoryGeneration=false;
  let selecting=false;
  let blocked=false;
  let creationBlocked=false;
  let selectedRevision=0;
  let browsedProject:{projectId:string;tabId:number;browserInstanceId:string;checkedAt:number;
    threads:Array<{tabId:number;conversationId:string;title:string;canonicalUrl:string;
      opened:false;projectId:string;projectName:string;searchTicket:string}>}|null=null;
  let searched:{query:string;ticket:string;tabId:number;browserInstanceId:string;
    checkedAt:number;threads:Array<{tabId:number;conversationId:string;title:string;
      canonicalUrl:string;opened:false;projectId:null;projectName:null;excerpt:string;searchTicket:string}>}|null=null;

  // An ambiguous receipt belongs to the exact conversation; sidebar navigation
  // must never reset its send fence or permit a second uncertain message.
  const uncertainConversations=new Set<string>();
  const awaitingFirstTurns=new Map<string,{conversationId:string;text:string;deliveryId:string}>();
  // Internal exact-binding association. Task Capsule's public projection
  // intentionally omits browser instance and conversation identifiers.
  const associatedTasks=new Map<string,string>();
  const conversationKey=(binding:Binding)=>binding.browserInstanceId+":"+binding.conversationId;
  const restoreTaskBinding=async(binding:Binding)=>{
    if(!taskStore?.readInternal)return;
    // The public Task projection omits private instance and conversation IDs.
    // Resolve those only inside this trusted controller, never in UI payloads.
    const candidates=await taskStore.list({limit:100});
    const matches:string[]=[];
    for(const candidate of candidates){
      if(candidate?.chatBinding?.browserContext!=="user"||candidate.chatBinding.tabId!==binding.tabId
        ||typeof candidate.taskId!=="string"||candidate.status!=="active")continue;
      let record:Awaited<ReturnType<NonNullable<TaskStore["readInternal"]>>>;
      try{record=await taskStore.readInternal(candidate.taskId);}
      catch{continue;} // Missing/unreadable candidate must not hide other matches.
      const original=record?.chatBinding;
      if(record?.status==="active"&&original?.browserContext==="user"
        &&original.browserInstanceId===binding.browserInstanceId
        &&original.tabId===binding.tabId
        &&original.conversationId===binding.conversationId){
        matches.push(record.taskId);
        if(matches.length>1)break;
      }
    }
    if(matches.length===1)associatedTasks.set(conversationKey(binding),matches[0]!);
    else associatedTasks.delete(conversationKey(binding));
  };
  const currentTaskId=async(binding:Binding):Promise<string|null>=>{
    if(!taskStore?.readInternal)return null;
    const key=conversationKey(binding);
    // Task Capsules can be rebound while the selected conversation is open.
    // Re-check the bounded trusted in-memory store on each status read; never
    // trust a previously cached association when another active task matches.
    try{await restoreTaskBinding(binding);}
    catch{associatedTasks.delete(key);}
    return associatedTasks.get(key)??null;
  };
  const createAttempts=new Map<string,{text:string;modelChoice:string|null;
    effortLevel:number|null;promise:Promise<unknown>}>();
  const attempts=new Map<string,{text:string;conversationKey:string;promise:Promise<unknown>}>();
  const actionAttempts=new Map<string,{fingerprint:string;promise:Promise<unknown>}>();
  let mutatingAction=false;
  function appendMessage(message:Message) {
    messages.push(message);
    while(messages.length>MAX_MESSAGES||messages.reduce((sum,item)=>sum+item.text.length,0)>MAX_TRANSCRIPT_CHARS)messages.shift();
  }
  const call=(method:string,args:object,timeoutMs=6_000)=>browserBridge.call(method,args,{context:"user",timeoutMs});
  const context=()=>{
    const c=browserBridge.snapshot()?.contexts?.user;
    const id=c?.extension?.instanceId||c?.host?.instanceId;
    if(!c?.ready||typeof id!=="string"||id.length<8)throw new Error("Your Browser is not connected. Open Chrome with Equinox Browser enabled.");
    if(Number(c?.extension?.capabilityVersions?.chatBridge||0)<9)throw new Error("Equinox Browser needs the current Chat Bridge capability.");
    return id as string;
  };
  const list=async()=>{
    const browserInstanceId=context();
    const raw=await call("tabs.list",{});
    if(!Array.isArray(raw))throw new Error("Connected browser did not return a tab list.");
    type Thread={tabId:number;conversationId:string;title:string;canonicalUrl:string;
      opened:boolean;projectId:string|null;projectName:string|null};
    const open=new Map<string,Thread>();
    const duplicated=new Set<string>();
    for(const item of (raw as BrowserTab[]).slice(0,150)) {
      const tabId=Number(item?.id??item?.tabId);
      const conversationId=chatGptConversationIdFromUrl(item?.url);
      if(!conversationId||!Number.isSafeInteger(tabId)||tabId<1)continue;
      if(open.has(conversationId))duplicated.add(conversationId);
      else open.set(conversationId,{tabId,conversationId,title:safeTitle(item.title)||"ChatGPT conversation",
        canonicalUrl:String(item.url),opened:true,projectId:null,projectName:null});
    }
    // The provider's rendered navigation is the only source of historical
    // chats. It is a bounded, possibly incomplete view, not an account API.
    // Prefer the selected tab so a task-bound session stays the read authority.
    const observer=([...open.values()].find(t=>t.tabId===selected?.tabId)
      ||[...open.values()][0])?.tabId;
    const ordered=new Map<string,Thread>();
    let sidebarPartial=true;
    let projects:Array<{id:string;name:string}>=[];
    if(observer && Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge||0)>=13){
      try{
        const report=await call("chat_bridge.sidebar",{tabId:observer},12_000) as any;
        if(report?.tabId===observer&&Array.isArray(report.threads)){
          for(const entry of report.threads.slice(0,100)){
            const id=String(entry?.conversationId||"");
            if(!/^[a-zA-Z0-9-]{8,160}$/u.test(id)||duplicated.has(id)
              ||ordered.has(id)||typeof entry?.title!=="string"||typeof entry?.canonicalUrl!=="string"
              ||chatGptConversationIdFromUrl(entry.canonicalUrl)!==id)continue;
            const opened=open.get(id);
            ordered.set(id,opened
              ?{...opened,title:safeTitle(entry.title),projectId:entry.projectId||null,
                projectName:safeTitle(entry.projectName||"")||null}
              :{tabId:observer,conversationId:id,title:safeTitle(entry.title),
                canonicalUrl:entry.canonicalUrl,opened:false,
                projectId:entry.projectId||null,projectName:safeTitle(entry.projectName||"")||null});
          }
          if(Array.isArray(report.projects))projects=report.projects.slice(0,50)
            .filter((item:any)=>typeof item?.id==="string"&&/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(item.id)
              &&typeof item?.name==="string"&&item.name.trim())
            .map((item:any)=>({id:item.id,name:safeTitle(item.name)}));
          sidebarPartial=true;
        }
      }catch{
        // A redesign of ChatGPT's navigation must not make open tabs vanish.
      }
    }
    for(const thread of open.values())if(!duplicated.has(thread.conversationId)&&!ordered.has(thread.conversationId))
      ordered.set(thread.conversationId,thread);
    return{browserInstanceId,duplicateCount:duplicated.size,
      source:"visible-sidebar",partial:sidebarPartial,projects,
      threads:[...ordered.values()].slice(0,100).map(t=>({...t,
        selected:selected?.conversationId===t.conversationId&&selected?.tabId===t.tabId}))};
  };
  const search=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid chat search.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).length!==1||typeof body.query!=="string"
      ||body.query.trim().length<2||[...body.query].length>120
      ||/[\x00-\x1f\x7f]/u.test(body.query))invalid("Chat search requires 2–120 characters.");
    const browserInstanceId=context();
    if(Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge||0)<13)
      invalid("Update Equinox Browser to use full conversation search.");
    const current=selected;
    const observer=current?.tabId??(await list()).threads.find(thread=>thread.opened)?.tabId;
    if(!observer)invalid("Open ChatGPT in Chrome before searching your conversations.");
    const revision=selectedRevision;
    const report=await call("chat_bridge.search",{tabId:observer,query:body.query.trim()},20_000) as any;
    if(context()!==browserInstanceId||revision!==selectedRevision
      ||(current&&selected?.tabId!==current.tabId))
      invalid("The ChatGPT browser session or selected conversation changed during search.");
    if(report?.tabId!==observer||typeof report.ticket!=="string"
      ||!Array.isArray(report.items)||report.items.length>60)
      invalid("The provider did not confirm the current search result.");
    const threads:Array<{tabId:number;conversationId:string;title:string;canonicalUrl:string;
      opened:false;projectId:null;projectName:null;excerpt:string;searchTicket:string}>=[];
    const unique=new Set<string>();
    for(const item of report.items){
      if(typeof item?.conversationId!=="string"||typeof item?.canonicalUrl!=="string"
        ||chatGptConversationIdFromUrl(item.canonicalUrl)!==item.conversationId
        ||typeof item.title!=="string"||unique.has(item.conversationId))continue;
      unique.add(item.conversationId);
      threads.push({tabId:observer,conversationId:item.conversationId,title:safeTitle(item.title),
        canonicalUrl:item.canonicalUrl,opened:false,projectId:null,projectName:null,
        excerpt:typeof item.excerpt==="string"?item.excerpt.slice(0,250):"",searchTicket:report.ticket});
    }
    searched={query:body.query.trim(),ticket:report.ticket,tabId:observer,
      browserInstanceId,checkedAt:Date.now(),threads};
    return{query:searched.query,threads,partial:true,source:"provider-search-dialog"};
  };
  const project=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid ChatGPT project request.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).length!==1||typeof body.projectId!=="string"
      ||!/^g-p-[a-zA-Z0-9-]{8,100}$/u.test(body.projectId))
      invalid("Project browsing requires an observed ChatGPT project.");
    const available=await list();
    const choice=available.projects.find(item=>item.id===body.projectId);
    if(!choice)invalid("The selected project is not present in the current ChatGPT sidebar.");
    const browserInstanceId=available.browserInstanceId;
    const observer=selected?.tabId??available.threads.find(thread=>thread.opened)?.tabId;
    if(!observer)invalid("A connected ChatGPT conversation is required to browse projects.");
    const revision=selectedRevision;
    const report=await call("chat_bridge.project",{tabId:observer,projectId:body.projectId},16_000) as any;
    if(context()!==browserInstanceId||revision!==selectedRevision
      ||report?.tabId!==observer||report?.projectId!==body.projectId
      ||typeof report.ticket!=="string"||!Array.isArray(report.items))
      invalid("The project or Chrome session changed during browsing.");
    const threads:Array<{tabId:number;conversationId:string;title:string;canonicalUrl:string;
      opened:false;projectId:string;projectName:string;searchTicket:string}>=[];
    const seen=new Set<string>();
    for(const item of report.items.slice(0,100)){
      if(typeof item?.conversationId!=="string"||typeof item?.canonicalUrl!=="string"
        ||typeof item.title!=="string"||seen.has(item.conversationId)
        ||chatGptConversationIdFromUrl(item.canonicalUrl)!==item.conversationId)continue;
      seen.add(item.conversationId);
      threads.push({tabId:observer,conversationId:item.conversationId,title:safeTitle(item.title),
        canonicalUrl:item.canonicalUrl,opened:false,projectId:choice.id,
        projectName:choice.name,searchTicket:report.ticket});
    }
    browsedProject={projectId:choice.id,tabId:observer,browserInstanceId,
      checkedAt:Date.now(),threads};
    return{projectId:choice.id,name:choice.name,threads,partial:true,source:"visible-project"};
  };
  const conversationAction=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))
      invalid("Invalid ChatGPT conversation action request.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).some(k=>!["tabId","conversationId","action","expectedTitle","title","mutationId"].includes(k))
      ||!Number.isSafeInteger(body.tabId)||Number(body.tabId)<1
      ||typeof body.conversationId!=="string"||!/^[a-zA-Z0-9-]{8,160}$/u.test(body.conversationId)
      ||!["inspect","pin","rename"].includes(String(body.action))
      ||(body.action!=="inspect"&&(typeof body.expectedTitle!=="string"
        ||!body.expectedTitle.trim()||body.expectedTitle.length>120))
      ||(body.action==="rename"&&(typeof body.title!=="string"
        ||!body.title.trim()||body.title.length>120||/[\x00-\x1f\x7f]/u.test(body.title)))
      ||(body.action!=="rename"&&body.title!==undefined)
      ||(body.action==="inspect"&&(body.mutationId!==undefined||body.expectedTitle!==undefined))
      ||(body.action!=="inspect"&&(typeof body.mutationId!=="string"
        ||!/^cma-[a-f0-9-]{36}$/u.test(body.mutationId))))
      invalid("Conversation action requires exact identity, requested operation and valid title.");
    const fingerprint=JSON.stringify(body);
    const key=body.mutationId as string|undefined;
    if(key){
      const prior=actionAttempts.get(key);
      if(prior){
        if(prior.fingerprint!==fingerprint)
          invalid("Conversation action id cannot be reused for a different operation.");
        return prior.promise;
      }
      if(actionAttempts.size>=256)invalid("Conversation actions reached the current runtime limit.");
      if(mutatingAction||selecting||sending||creating||pending||blocked)
        invalid("Finish any pending ChatGPT action or delivery before changing conversations.");
      mutatingAction=true;
    }
    const perform=(async()=>{
      try{
        const available=await list();
        const tabId=Number(body.tabId),id=String(body.conversationId);
        const thread=available.threads.find(t=>t.tabId===tabId&&t.conversationId===id)
          ||(searched&&Date.now()-searched.checkedAt<90_000
            &&searched.browserInstanceId===available.browserInstanceId
            ?searched.threads.find(t=>t.tabId===tabId&&t.conversationId===id):null)
          ||(browsedProject&&Date.now()-browsedProject.checkedAt<90_000
            &&browsedProject.browserInstanceId===available.browserInstanceId
            ?browsedProject.threads.find(t=>t.tabId===tabId&&t.conversationId===id):null);
        if(!thread)invalid("The selected chat is not in the current provider history.");
        if(key&&body.expectedTitle!==thread.title)
          invalid("The selected chat title changed. Refresh its actions.");
        const revision=selectedRevision;
        const response=await call("chat_bridge.conversation_action",{
          tabId,conversationId:id,canonicalUrl:thread.canonicalUrl,
          ...("searchTicket" in thread?{searchTicket:thread.searchTicket}:{}),
          action:body.action,
          ...(key?{expectedTitle:thread.title}:{}),
          ...(body.action==="rename"?{title:String(body.title).trim()}:{}),
        },20_000) as any;
        if(context()!==available.browserInstanceId||selectedRevision!==revision
          ||response?.tabId!==tabId||response?.conversationId!==id
          ||response?.action!==body.action||response?.available!==true)
          throw new Error("The ChatGPT conversation action lost its exact identity.");
        if(key&&response.confirmed!==true)
          throw new Error("ChatGPT did not confirm this change. Check the provider before retrying.");
        return response;
      }finally{if(key)mutatingAction=false;}
    })();
    if(key)actionAttempts.set(key,{fingerprint,promise:perform});
    return perform;
  };
  const model=async(value:{action:"read"|"discover"|"choose"|"power"|"catalog";
    choice?:string;direction?:"left"|"right"})=>{
    if(value.action==="catalog"){
      const instance=context();
      if(Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge||0)<13)
        invalid("Equinox Browser must support Native Chat model discovery.");
      const info=await call("chat_bridge.model_catalog",{},15_000) as any;
      if(context()!==instance)invalid("The connected Browser changed during model discovery.");
      if(info?.available!==true||info?.discovered!==true||!Array.isArray(info.choices))
        invalid("ChatGPT did not confirm available new-chat models.");
      return info;
    }
    const target=selected;
    if(!target)return{available:false,reason:"no-conversation",choices:[]};
    if(Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge||0)<13)
      return{available:false,reason:"browser-upgrade-required",choices:[]};
    if(value.action!=="read"&&(selecting||sending||creating||pending||blocked||mutatingAction))
      invalid("Cannot change ChatGPT model settings while the conversation is busy or uncertain.");
    const revision=selectedRevision;
    const info=await call("chat_bridge.model",
      {tabId:target.tabId,conversationId:target.conversationId,...value},12_000) as any;
    if(revision!==selectedRevision||selected?.tabId!==target.tabId
      ||selected?.conversationId!==target.conversationId||selected?.browserInstanceId!==target.browserInstanceId)
      throw new Error("Model selection changed conversations; refresh the model controls.");
    if(info?.tabId!==target.tabId||info?.conversationId!==target.conversationId)
      throw new Error("Browser did not confirm the model selector's conversation.");
    return info;
  };
  const select=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid conversation selection.");
    const object=value as Record<string,unknown>;
    if(Object.keys(object).length!==2||typeof object.conversationId!=="string"||!Number.isSafeInteger(object.tabId))invalid("Invalid conversation selection.");
    if(selecting||sending||creating||pending||mutatingAction)
      invalid("Cannot switch conversations while an action or message is in flight.");
    selecting=true;
    try{
    const available=await list();
    const tab=available.threads.find(t=>t.tabId===object.tabId&&t.conversationId===object.conversationId)
      ||(searched&&Date.now()-searched.checkedAt<90_000
        &&searched.browserInstanceId===available.browserInstanceId
        ?searched.threads.find(t=>t.tabId===object.tabId&&t.conversationId===object.conversationId)
        :null)
      ||(browsedProject&&Date.now()-browsedProject.checkedAt<90_000
        &&browsedProject.browserInstanceId===available.browserInstanceId
        ?browsedProject.threads.find(t=>t.tabId===object.tabId&&t.conversationId===object.conversationId)
        :null);
    if(!tab)invalid("This ChatGPT conversation is no longer in recent history or the current search.");
    // For a historical sidebar row, navigate the one verified user browser
    // tab only after the bridge proves the exact link, no active generation and
    // no unsent Chrome draft/attachments. Never reuse another thread's state.
    if(!tab.opened){
      const result=await call("chat_bridge.open_history",
        {tabId:tab.tabId,conversationId:tab.conversationId,canonicalUrl:tab.canonicalUrl,
          searchTicket:"searchTicket" in tab?tab.searchTicket:undefined},18_000) as any;
      if(result?.tabId!==tab.tabId||result?.conversationId!==tab.conversationId
        ||result?.canonicalUrl!==tab.canonicalUrl)
        invalid("ChatGPT did not confirm the selected historical conversation.");
    }
    const next:Binding={browserContext:"user",browserInstanceId:available.browserInstanceId,tabId:tab.tabId,conversationId:tab.conversationId,canonicalUrl:tab.canonicalUrl};
    // A project-scoped URL may be needed to follow the browser's exact conversation identity.
    // Only the browser bridge, never the UI, supplies the canonical URL.
    const raw=await call("tabs.list",{});
    const source=(raw as BrowserTab[]).find(t=>Number(t.id??t.tabId)===tab.tabId&&chatGptConversationIdFromUrl(t.url)===tab.conversationId);
    if(!source?.url)invalid("Conversation identity changed during selection.");
    next.canonicalUrl=source.url;
    const inspected=await chatBridge.inspectTurnIdentity({binding:next});
    const confirmed=inspected?.binding;
    if(!confirmed||confirmed.browserContext!=="user"
      ||confirmed.browserInstanceId!==next.browserInstanceId
      ||confirmed.tabId!==next.tabId
      ||confirmed.conversationId!==next.conversationId)
      invalid("The selected Chrome tab changed during selection. Re-select the conversation.");
    // A conversation reopened in a different Chrome tab is a different
    // authenticated transport binding. Never reuse that tab's stale history,
    // preview or task-specific send state merely because its URL ID matches.
    const changed=selected?.conversationId!==next.conversationId
      ||selected?.browserInstanceId!==next.browserInstanceId
      ||selected?.tabId!==next.tabId
      ||selected?.canonicalUrl!==next.canonicalUrl;
    if(changed){
      selectedRevision++;
      messages=[];pending=null;
      awaitingNewChatIdentity=awaitingFirstTurns.get(conversationKey(next))??null;
      blocked=uncertainConversations.has(conversationKey(next))||Boolean(awaitingNewChatIdentity);
      history=[];historyPartial=false;historyPendingHydration=0;
      previousHistoryGeneration=false;
      historyNotice=awaitingNewChatIdentity
        ?"This New Chat is still waiting for its first response identity in Chrome."
        :blocked?"A previous delivery in this conversation is uncertain. Inspect it in Chrome before sending again.":null;
    }
    selected=next;
    if(changed){
      try{await restoreTaskBinding(next);}catch{
        // Task discovery is optional; errors must not break the Chat transport.
        associatedTasks.delete(conversationKey(next));
      }
      try{
        const value=await chatBridge.readRecent?.({binding:next});
        if(value?.tabId!==undefined && value.tabId!==next.tabId)
          throw new Error("Recent history came from another Chrome tab.");
        if(value&&Array.isArray(value.items)){
          history=value.items.slice(-24).map((item:any):Message=>({id:String(item.id).slice(0,220),role:item.role,
            text:String(item.text).slice(0,14000),status:"complete",truncated:item.truncated===true,
            richText:typeof item.richText==="string"&&item.role==="assistant"&&[...item.richText].length<=5000?item.richText:null}));
          historyPartial=value.partial===true;
          // Navigation may finish before ChatGPT hydrates its transcript.
          // Retry at most five subsequent normal reads without a new send.
          if(!history.length&&Number(value.observedTurns)===0)historyPendingHydration=5;
        }else historyNotice="Recent conversation history is not available with this Browser version.";
      }catch{historyNotice="Recent history unavailable. You can still send messages in this conversation.";}
    }
    return await read();
    }finally{selecting=false;}
  };
  const read=async()=>{
    if(!selected)return{selected:null,items:[],turn:"unbound",blocked:false,creationBlocked,limitedHistory:true};
    const initialBinding=selected;
    const startingRevision=selectedRevision;
    const sameSelection=()=>selectedRevision===startingRevision
      &&selected?.browserInstanceId===initialBinding.browserInstanceId
      &&selected?.conversationId===initialBinding.conversationId
      &&selected?.tabId===initialBinding.tabId;
    const staleResult=()=>({selected:{conversationId:selected!.conversationId,tabId:selected!.tabId,browserInstanceId:selected!.browserInstanceId},
      items:[],turn:"waiting",sending,blocked:true,preview:null,
      notice:"Conversation changed while reading. Refresh the selected conversation.",
      limitedHistory:true,historyCount:0,creationBlocked});
    let turn="idle";let notice:string|null=null;let preview:{text:string;truncated:boolean;richText?:string|null}|null=null;
    try{
      const inspected=await chatBridge.inspectTurnIdentity({binding:initialBinding});
      if(!sameSelection())return staleResult();
      const current=inspected?.binding as Binding|undefined;
      if(!current||current.browserContext!=="user"
          ||current.conversationId!==initialBinding.conversationId
          ||current.browserInstanceId!==initialBinding.browserInstanceId
          ||current.tabId!==initialBinding.tabId) {
        throw Object.assign(new Error("The selected Chrome tab changed. Select the conversation again from the sidebar."),
          {code:"CHAT_BRIDGE_TAB_CHANGED"});
      }
      selected=current;
      const generatingNow=inspected?.generationActive===true;
      turn=generatingNow?"generating":inspected?.status==="waiting"?"waiting":"ready";
      // Conversations selected while generating have no local send receipt.
      // Refresh their bounded history once when the observed generation ends.
      if(!generatingNow&&previousHistoryGeneration&&!pending&&!messages.length&&chatBridge.readRecent){
        previousHistoryGeneration=false;
        try{
          const fresh=await chatBridge.readRecent({binding:initialBinding});
          if(!sameSelection())return staleResult();
          if(fresh?.tabId!==undefined && fresh.tabId!==initialBinding.tabId)
            throw Object.assign(new Error("The selected Chrome tab changed while refreshing history."),{code:"CHAT_BRIDGE_TAB_CHANGED"});
          if(Array.isArray(fresh?.items)){
            history=fresh.items.slice(-24).map((item:any):Message=>({
              id:String(item.id).slice(0,220),role:item.role,text:String(item.text).slice(0,14000),
              status:"complete",truncated:item.truncated===true,
              richText:typeof item.richText==="string"&&item.role==="assistant"&&[...item.richText].length<=5000?item.richText:null,
            }));
            historyPartial=fresh.partial===true;
          }
        }catch{historyNotice="Recent conversation history could not be refreshed after generation.";}
      }
      if(generatingNow)previousHistoryGeneration=true;
      if(!generatingNow&&!pending&&historyPendingHydration>0&&chatBridge.readRecent){
        historyPendingHydration--;
        try{
          const fresh=await chatBridge.readRecent({binding:initialBinding});
          if(!sameSelection())return staleResult();
          if(Array.isArray(fresh?.items)&&fresh.items.length){
            history=fresh.items.slice(-24).map((item:any):Message=>({
              id:String(item.id).slice(0,220),role:item.role,text:String(item.text).slice(0,14000),
              status:"complete",truncated:item.truncated===true,
              richText:typeof item.richText==="string"&&item.role==="assistant"
                &&[...item.richText].length<=5000?item.richText:null,
            }));
            historyPartial=fresh.partial===true;
            historyPendingHydration=0;
          }
        }catch{/* A later explicit refresh can recover without replaying sends. */}
      }
      if(awaitingNewChatIdentity&&inspected?.status==="ready"&&typeof inspected.userEpoch==="string"&&inspected.userEpoch){
        // A fresh /c/ URL can precede the first user-turn epoch. Read-only
        // corroboration of the ONLY user message prevents accidentally claiming
        // a later manual Chrome turn as the opener. No prompt is resent.
        const awaiting=awaitingNewChatIdentity;
        if(selected.conversationId===awaiting.conversationId&&chatBridge.readRecent){
          try{
            const recent=await chatBridge.readRecent({binding:initialBinding});
            if(!sameSelection())return staleResult();
            if(recent?.tabId!==undefined && recent.tabId!==initialBinding.tabId) throw new Error("New Chat read another Chrome tab.");
            const users=Array.isArray(recent?.items)?recent.items.filter((item:any)=>item?.role==="user"):[];
            if(recent?.partial!==true&&users.length===1&&users[0].text?.trim()===awaiting.text){
              pending={userEpoch:inspected.userEpoch,previousAssistantTurnKey:null,deliveryId:awaiting.deliveryId};
              awaitingNewChatIdentity=null;
              awaitingFirstTurns.delete(conversationKey(selected));
              blocked=false;
              historyNotice=null;
            }
          }catch{/* Incomplete browser history is not proof of the first turn. */}
        }
        if(awaitingNewChatIdentity)notice="New Chat is waiting for exact first-turn identity confirmation in Chrome. No message will be resent.";
      }
      if(awaitingNewChatIdentity)turn="waiting";
      if(pending){
        const receipt=pending;
        const result=await chatBridge.readFinal({binding:initialBinding,userEpoch:receipt.userEpoch,previousAssistantTurnKey:receipt.previousAssistantTurnKey});
        if(!sameSelection())return staleResult();
        if(result?.tabId!==undefined && result.tabId!==initialBinding.tabId)
          throw Object.assign(new Error("The pending assistant response moved to another Chrome tab."),
            {code:"CHAT_BRIDGE_TAB_CHANGED"});
        if(result?.status==="ready"){
          if(typeof result.text!=="string"){
            throw Object.assign(new Error("The confirmed ChatGPT reply has no readable text payload."),{code:"CHAT_BRIDGE_READ_FAILED"});
          }
          // Polling and the post-send refresh can complete simultaneously.
          // Only the first reader that still owns this receipt may append it.
          if(pending===receipt){
            const reply=result.text;
            appendMessage({id:receipt.deliveryId+"-reply",role:"assistant",text:reply.slice(0,MAX_ASSISTANT_CHARS),status:"complete",
              truncated:result.truncated===true||reply.length>MAX_ASSISTANT_CHARS,
              richText:typeof result.richText==="string"&&[...result.richText].length<=14000?result.richText:null});
            pending=null;
          }
          turn="complete";
        }else turn=inspected?.generationActive===true?"generating":"waiting";
      }
      // Preview is ephemeral. Only read it while the browser observer reports
      // active generation, and never append it to completed transcript items.
      if(turn==="generating"&&inspected?.generationActive===true&&
         Number(browserBridge.snapshot()?.contexts?.user?.extension?.capabilityVersions?.chatBridge||0)>=11&&
         typeof inspected.userEpoch==="string"&&chatBridge.readLive){
        const live=await chatBridge.readLive({binding:initialBinding,userEpoch:inspected.userEpoch});
        if(!sameSelection())return staleResult();
        if(live?.tabId!==undefined && live.tabId!==initialBinding.tabId)
          throw Object.assign(new Error("The live assistant preview moved to another Chrome tab."),
            {code:"CHAT_BRIDGE_TAB_CHANGED"});
        if(live?.status==="generating"&&typeof live.text==="string"&&live.text)
          preview={text:live.text.slice(0,3200),truncated:live.truncated===true||live.text.length>3200,
            richText:typeof live.richText==="string"&&[...live.richText].length<=4000?live.richText:null};
        else if(live?.status==="drifted")throw Object.assign(new Error("Live Chat turn identity changed."),{code:"CHAT_BRIDGE_DRIFTED"});
      }
    }catch(error){
      // A late error from conversation A must not mark newly selected B as
      // uncertain or disconnected. The stale-response guard below owns it.
      if(sameSelection()){
        const code=(error as {code?:string})?.code;
        if(code==="CHAT_BRIDGE_TAB_CHANGED") {
          // A read-only tab move is recoverable by explicit reselection.
          // A pending/mutating send remains uncertain instead of migrating.
          if(pending||sending){
            pending=null;blocked=true;uncertainConversations.add(conversationKey(selected));
          }
          turn="disconnected";
        }else if(code==="CHAT_BRIDGE_DRIFTED"||code==="CHAT_BRIDGE_READ_FAILED"){
          pending=null;blocked=true;uncertainConversations.add(conversationKey(selected));turn="disconnected";
        }else if(pending){turn="waiting";}
        else turn="disconnected";
        notice=error instanceof Error?error.message:"Browser conversation is unavailable.";
      }
    }
    // Browser reads can finish after another sidebar selection. Never
    // attribute a previous conversation's text/preview to the new selection.
    if(!sameSelection())return staleResult();
    const taskId=turn==="disconnected" ? null : await currentTaskId(initialBinding);
    if(!sameSelection())return staleResult();
    return{selected:{conversationId:selected.conversationId,tabId:selected.tabId,browserInstanceId:selected.browserInstanceId},items:[...history,...messages].slice(-54),
      turn,sending,blocked,creationBlocked,taskId,
      preview,notice:notice||historyNotice,limitedHistory:historyPartial||!history.length,historyCount:history.length};
  };
  const send=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid chat delivery request.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).length!==2||typeof body.deliveryId!=="string"||!/^tgb-[a-f0-9-]{36}$/u.test(body.deliveryId)||typeof body.text!=="string"||!body.text.trim()||body.text.length>4000||/[\0]/u.test(body.text))invalid("Chat delivery must include a unique id and 1–4000 characters of text.");
    const key=body.deliveryId;
    const message=(body.text as string).trim();
    const prior=attempts.get(key);
    if(prior){
      if(prior.text!==message||!selected||prior.conversationKey!==conversationKey(selected))
        invalid("A delivery id cannot be reused for a different conversation or message.");
      return prior.promise;
    }
    // Retain every delivery identity for the lifetime of this backend.
    // Refuse new sends at the bound rather than evict old IDs and risk replay.
    if(attempts.size>=MAX_DELIVERY_IDS)invalid("This Chat session reached its bounded delivery limit. Restart the runtime before sending again.");
    if(selecting||sending||creating||pending||blocked||mutatingAction||!selected)
      invalid("Select an idle, unblocked ChatGPT conversation and finish any pending conversation action before sending.");
    const binding=selected;
    sending=true;
    const attempt=(async()=>{
      try{
        const result=await chatBridge.deliverText({binding,deliveryId:key,text:(body.text as string).trim(),requireExactTab:true});
        if(result?.confirmed!==true){
          blocked=true;
          uncertainConversations.add(conversationKey(binding));
          appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"uncertain"});
          return{confirmed:false,ambiguous:true};
        }
        appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"sent"});
        pending={userEpoch:result.userEpoch,previousAssistantTurnKey:result.previousAssistantTurnKey,deliveryId:key};
        return{confirmed:true,ambiguous:false};
      }catch(error){
        const code=(error as {code?:string})?.code;
        if(code==="CHAT_BRIDGE_NOT_READY"){
          // The bridge verified no native send crossed the Chrome mutation
          // boundary. Preserve the draft and allow a fresh explicit selection.
          const definitive:Error&{statusCode?:number}=new Error("Chat was not submitted: "+
            (error instanceof Error?error.message:"The selected Chrome tab is not ready."));
          definitive.statusCode=409;
          throw definitive;
        }
        if(code==="CHAT_BRIDGE_AMBIGUOUS"){
          blocked=true;
          uncertainConversations.add(conversationKey(binding));
          appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"uncertain"});
        }
        throw error;
      }finally{sending=false;}
    })();
    attempts.set(key,{text:message,conversationKey:conversationKey(binding),promise:attempt});
    return attempt;
  };
  // Explicit first-message creation. Reuse the existing Task Capsule + first-party
  // Task Chat starter, and retain request identities even after a failed attempt.
  // A restart cannot silently recreate an already recorded initiation request.
  const startNew=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid New Chat request.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).some(k=>!["creationId","text","model","effort"].includes(k))
      ||typeof body.creationId!=="string"||
      !/^nch-[a-f0-9-]{36}$/u.test(body.creationId)||typeof body.text!=="string"||
      !body.text.trim()||body.text.length>1500||/[\r\n\0]/u.test(body.text)
      ||(body.model!==undefined&&(typeof body.model!=="string"||!body.model.trim()||body.model.length>80))
      ||(body.effort!==undefined&&(!Number.isInteger(body.effort)||Number(body.effort)<0||Number(body.effort)>12)))
      invalid("The first Chat message must be a single line of 1–1500 characters and a unique creation id.");
    const key=body.creationId;
    const firstMessage=(body.text as string).trim();
    const modelChoice=typeof body.model==="string"?body.model.trim():null;
    const effortLevel=Number.isInteger(body.effort)?Number(body.effort):null;
    const prior=createAttempts.get(key);
    if(prior){
      if(prior.text!==firstMessage||prior.modelChoice!==modelChoice||prior.effortLevel!==effortLevel)
        invalid("A New Chat creation id cannot be reused with different message or model settings.");
      return prior.promise;
    }
    if(creationBlocked)invalid("A previous New Chat creation is uncertain. Check Chrome before restarting the Chat session; no new conversation will be opened automatically.");
    if(createAttempts.size>=MAX_NEW_CHAT_IDS)invalid("New Chat reached its request limit for this runtime.");
    if(!taskStore||!chatBridge.startTaskChat)invalid("New Chat is unavailable on this installation.");
    if(selecting||creating||sending||pending||blocked||mutatingAction)
      invalid("Finish the current conversation or pending action before starting New Chat.");
    creating=true;
    const attempt=(async()=>{
      let taskId:string|null=null;
      try{
        context();
        const existing=await taskStore.list({limit:100});
        if(existing.some(t=>Array.isArray(t.references)&&t.references.some((ref:any)=>ref.label==="Native Chat creation ID"&&ref.value===key)))
          invalid("This New Chat request was already recorded. Review existing Task Capsules instead of creating a duplicate.");
        const task=await taskStore.checkpoint({
          title:"Native Chat · "+new Date().toISOString().slice(0,16).replace("T"," "),
          objective:"User-initiated ChatGPT conversation through the Equinox Local native Chat window. The opening prompt stays in the user's ChatGPT conversation, not the Task Capsule.",
          completed:[],next:[],references:[{type:"note",label:"Native Chat creation ID",value:key}],
        });
        if(typeof task?.taskId!=="string"||!/^task-[a-z0-9-]{6,80}$/u.test(task.taskId))throw new Error("New Chat Task Capsule was not persisted.");
        const newTaskId=task.taskId as string;
        taskId=newTaskId;
        const opened=await chatBridge.startTaskChat!({taskId:newTaskId,checkpointRevision:task.checkpointRevision,
          initialMessage:firstMessage,...(modelChoice?{modelChoice}:{}),
          ...(effortLevel!==null?{effortLevel}:{})});
        if(opened?.confirmed!==true||!opened?.binding)throw new Error("New Chat could not confirm its exact ChatGPT binding.");
        const source=opened.binding as Binding;
        if(source.browserContext!=="user"||source.browserInstanceId!==context()||
          !Number.isSafeInteger(source.tabId)||source.tabId<1||
          !/^[A-Za-z0-9-]{8,160}$/u.test(source.conversationId)||
          chatGptConversationIdFromUrl(source.canonicalUrl)!==source.conversationId)
          throw new Error("New Chat returned a different browser conversation identity.");
        const saved=await taskStore.bindChat({taskId:newTaskId,binding:source});
        // bindChat persists and validates the full exact binding internally.
        // Its PUBLIC result exposes only browserContext and tabId by design.
        if(saved?.taskId!==newTaskId||saved?.chatBinding?.browserContext!==source.browserContext||saved?.chatBinding?.tabId!==source.tabId)
          throw new Error("New Chat Task Capsule binding could not be confirmed.");
        associatedTasks.set(conversationKey(source),newTaskId);
        selected={browserContext:"user",browserInstanceId:source.browserInstanceId,tabId:source.tabId,conversationId:source.conversationId,canonicalUrl:source.canonicalUrl};
        selectedRevision++;
        history=[];messages=[];historyNotice=null;historyPartial=false;blocked=false;pending=null;awaitingNewChatIdentity=null;
        const messageId=key.replace(/^nch-/u,"tgb-");
        appendMessage({id:messageId,role:"user",text:(body.text as string).trim(),status:"sent"});
        if(typeof opened.userEpoch==="string"&&opened.userEpoch){
          pending={userEpoch:opened.userEpoch,previousAssistantTurnKey:null,deliveryId:messageId};
        }else {
          // A confirmed new tab/conversation can still precede its first turn's
          // DOM epoch. Keep sends blocked, but resolve from exact read-only
          // Browser history on a later status poll instead of locking forever.
          awaitingNewChatIdentity={conversationId:source.conversationId,text:firstMessage,deliveryId:messageId};
          awaitingFirstTurns.set(conversationKey(selected),awaitingNewChatIdentity);
          blocked=true;
          historyNotice="New Chat opened. Waiting to verify its first turn in Chrome; no message will be resent.";
        }
        return{confirmed:true,taskId:newTaskId,chat:await read()};
      }catch(error){
        if(taskId&&(error as {code?:string})?.code==="CHAT_BRIDGE_CREATE_NOT_STARTED"&&taskStore?.cancel){
          // The starter confirmed no submit boundary was crossed and closed its new tab.
          // Keep a cancelled durable creation ID, rather than an orphaned active task.
          let cancelled=false;
          try{await taskStore.cancel(taskId);cancelled=true;}catch{/* Uncertain cleanup must remain blocked. */}
          if(cancelled){
            const definitive:Error&{statusCode?:number}=new Error("New Chat was not submitted: "+(error instanceof Error?error.message:"The initial composer was not ready."));
            definitive.statusCode=409;
            throw definitive;
          }
        }
        if(taskId){
          // The first tab/prompt may already exist. Switching to another known
          // conversation must not authorize a second unknown New Chat.
          creationBlocked=true;
          blocked=true;
        }
        throw error;
      }finally{creating=false;}
    })();
    createAttempts.set(key,{text:firstMessage,modelChoice,effortLevel,promise:attempt});
    return attempt;
  };

  return Object.freeze({list,search,project,conversationAction,select,read,send,startNew,model});
}
