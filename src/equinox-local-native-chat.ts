import { chatGptConversationIdFromUrl } from "./telegram-chat-bridge-controller.js";

type BrowserTab = {id?:number;tabId?:number;url?:string;title?:string};
type Binding = {browserContext:"user";browserInstanceId:string;tabId:number;conversationId:string;canonicalUrl:string};
type Message = {id:string;role:"user"|"assistant";text:string;status:"sent"|"complete"|"uncertain";truncated?:boolean};
type BrowserBridge = {snapshot:()=>any;call:(method:string,args:object,options:{context:"user";timeoutMs:number})=>Promise<unknown>};
type ChatBridge = {
  inspectTurnIdentity:(args:{binding:Binding})=>Promise<any>;
  deliverText:(args:{binding:Binding;deliveryId:string;text:string})=>Promise<any>;
  readFinal:(args:{binding:Binding;userEpoch:string;previousAssistantTurnKey:string|null})=>Promise<any>;
};
const MAX_MESSAGES = 30;
const MAX_TRANSCRIPT_CHARS = 96_000;
const MAX_ASSISTANT_CHARS = 12_000;
const MAX_DELIVERY_IDS = 2_048;
function invalid(message:string):never {const error:Error&{statusCode?:number}=new Error(message);error.statusCode=400;throw error;}
function safeTitle(value:unknown):string {return typeof value==="string"?value.replace(/[\x00-\x1f\x7f]/gu," ").trim().slice(0,120):"ChatGPT conversation";}

/** Current-user native Chat transport. The browser remains the ChatGPT session authority. */
export function createNativeChatController({browserBridge,chatBridge}:{browserBridge:BrowserBridge;chatBridge:ChatBridge}) {
  let selected:Binding|null=null;
  let messages:Message[]=[];
  let pending:{userEpoch:string;previousAssistantTurnKey:string|null;deliveryId:string}|null=null;
  let sending=false;
  let blocked=false;
  const attempts=new Map<string,Promise<unknown>>();
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
    const tabs=new Map<string,{tabId:number;conversationId:string;title:string;canonicalUrl:string}>();
    const duplicated=new Set<string>();
    for(const item of (raw as BrowserTab[]).slice(0,150)) {
      const tabId=Number(item?.id??item?.tabId);
      const conversationId=chatGptConversationIdFromUrl(item?.url);
      if(!conversationId||!Number.isSafeInteger(tabId)||tabId<1)continue;
      const canonicalUrl=String(item.url);
      if(tabs.has(conversationId))duplicated.add(conversationId);
      else tabs.set(conversationId,{tabId,conversationId,title:safeTitle(item.title)||"ChatGPT conversation",canonicalUrl});
    }
    return {browserInstanceId,duplicateCount:duplicated.size,
      threads:[...tabs.values()].filter(t=>!duplicated.has(t.conversationId)).slice(0,35).map(t=>({conversationId:t.conversationId,tabId:t.tabId,title:t.title,selected:selected?.conversationId===t.conversationId}))};
  };
  const select=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid conversation selection.");
    const object=value as Record<string,unknown>;
    if(Object.keys(object).length!==2||typeof object.conversationId!=="string"||!Number.isSafeInteger(object.tabId))invalid("Invalid conversation selection.");
    if(sending||pending)invalid("Cannot change conversation while a message is in flight.");
    const available=await list();
    const tab=available.threads.find(t=>t.tabId===object.tabId&&t.conversationId===object.conversationId);
    if(!tab)invalid("This ChatGPT conversation is no longer available in Your Browser.");
    const next:Binding={browserContext:"user",browserInstanceId:available.browserInstanceId,tabId:tab.tabId,conversationId:tab.conversationId,canonicalUrl:`https://chatgpt.com/c/${tab.conversationId}`};
    // A project-scoped URL may be needed to follow the browser's exact conversation identity.
    // Only the browser bridge, never the UI, supplies the canonical URL.
    const raw=await call("tabs.list",{});
    const source=(raw as BrowserTab[]).find(t=>Number(t.id??t.tabId)===tab.tabId&&chatGptConversationIdFromUrl(t.url)===tab.conversationId);
    if(!source?.url)invalid("Conversation identity changed during selection.");
    next.canonicalUrl=source.url;
    await chatBridge.inspectTurnIdentity({binding:next});
    if(selected?.conversationId!==next.conversationId||selected?.browserInstanceId!==next.browserInstanceId){messages=[];pending=null;blocked=false;attempts.clear();}
    selected=next;
    return await read();
  };
  const read=async()=>{
    if(!selected)return{selected:null,items:[],turn:"unbound",blocked:false,limitedHistory:true};
    let turn="idle";let notice:string|null=null;
    try{
      const inspected=await chatBridge.inspectTurnIdentity({binding:selected});
      const current=inspected?.binding as Binding|undefined;
      if(current&&current.conversationId===selected.conversationId&&current.browserInstanceId===selected.browserInstanceId)selected=current;
      turn=inspected?.generationActive===true?"generating":inspected?.status==="waiting"?"waiting":"ready";
      if(pending){
        const result=await chatBridge.readFinal({binding:selected,userEpoch:pending.userEpoch,previousAssistantTurnKey:pending.previousAssistantTurnKey});
        if(result?.status==="ready"){
          const reply=String(result.text);
          appendMessage({id:pending.deliveryId+"-reply",role:"assistant",text:reply.slice(0,MAX_ASSISTANT_CHARS),status:"complete",
            truncated:result.truncated===true||reply.length>MAX_ASSISTANT_CHARS});
          pending=null;turn="complete";
        }else turn="generating";
      }
    }catch(error){
      const code=(error as {code?:string})?.code;
      if(code==="CHAT_BRIDGE_DRIFTED"||code==="CHAT_BRIDGE_READ_FAILED"){
        // A terminal response identity mismatch must never be replayed or
        // silently rebound to a different Chrome conversation.
        pending=null;blocked=true;turn="disconnected";
      }else if(pending){turn="waiting";}
      else turn="disconnected";
      notice=error instanceof Error?error.message:"Browser conversation is unavailable.";
    }
    return{selected:{conversationId:selected.conversationId,tabId:selected.tabId},items:messages,turn,sending,blocked,notice,limitedHistory:true};
  };
  const send=async(value:unknown)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid chat delivery request.");
    const body=value as Record<string,unknown>;
    if(Object.keys(body).length!==2||typeof body.deliveryId!=="string"||!/^tgb-[a-f0-9-]{36}$/u.test(body.deliveryId)||typeof body.text!=="string"||!body.text.trim()||body.text.length>4000||/[\0]/u.test(body.text))invalid("Chat delivery must include a unique id and 1–4000 characters of text.");
    const key=body.deliveryId;
    if(attempts.has(key))return attempts.get(key)!;
    // Retain every delivery identity for the lifetime of this backend.
    // Refuse new sends at the bound rather than evict old IDs and risk replay.
    if(attempts.size>=MAX_DELIVERY_IDS)invalid("This Chat session reached its bounded delivery limit. Restart the runtime before sending again.");
    if(sending||pending||blocked||!selected)invalid("Select an idle, unblocked ChatGPT conversation before sending. Confirm any uncertain delivery in Chrome.");
    const binding=selected;
    sending=true;
    const attempt=(async()=>{
      try{
        const result=await chatBridge.deliverText({binding,deliveryId:key,text:(body.text as string).trim()});
        if(result?.confirmed!==true){
          blocked=true;
          appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"uncertain"});
          return{confirmed:false,ambiguous:true};
        }
        appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"sent"});
        pending={userEpoch:result.userEpoch,previousAssistantTurnKey:result.previousAssistantTurnKey,deliveryId:key};
        return{confirmed:true,ambiguous:false};
      }catch(error){
        const code=(error as {code?:string})?.code;
        if(code==="CHAT_BRIDGE_AMBIGUOUS"){
          blocked=true;
          appendMessage({id:key,role:"user",text:(body.text as string).trim(),status:"uncertain"});
        }
        throw error;
      }finally{sending=false;}
    })();
    attempts.set(key,attempt);
    return attempt;
  };
  return Object.freeze({list,select,read,send});
}
