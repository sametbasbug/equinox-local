/**
 * Presentation-only isolated-world bridge. Every row is anchored to the
 * original host-created invocation frame and response-body, never a runtime
 * log, inferred conversation, or reconstructed tool call. Only verified local
 * history projections may restore empty exact slots. No privileged IPC,
 * arbitrary script, network request or tool execution.
 */
export function decorateNativeToolActivity(update: {pathname: string; language: "en" | "tr"; recording?: boolean} | null, generation: number): void {
  const world = window as Window & {__equinoxRunTimeline?: {generation: number; dispose: () => void;
    refresh: (pathname: string, language: "en" | "tr", generation: number, recording: boolean) => boolean;
    restore: (input: unknown) => void;
    take: () => {pathname:string; items: {owner:string;id:string;signature:string}[]};
    discardPending: (clearRestored?:boolean) => void;
    inspect: () => {frames: number; candidates: number; requests: number; replies: number; accepted: number}}};
  if (world.__equinoxRunTimeline && world.__equinoxRunTimeline.generation > generation) return;
  if (update && (location.origin !== "https://chatgpt.com" || location.pathname !== update.pathname)) return;
  // Reapplying appearance or reopening the same hidden view is not a new
  // transcript. Keep the verified rows and their disclosure state.
  if (update && world.__equinoxRunTimeline?.refresh(update.pathname,update.language,generation,update.recording===true)) return;
  world.__equinoxRunTimeline?.dispose();
  if (!update) { delete world.__equinoxRunTimeline; return; }
  const route = location.origin + location.pathname;
  const sameRoute = () => location.origin + location.pathname === route;
  let language=update.language;
  let recording=update.recording===true;
  const pending=new Map<string,{owner:string;id:string;signature:string}>();
  const tr = (en: string, turkish: string) => language === "tr" ? turkish : en;
  const selector = "[data-response-body] > [data-mcp-app-portal-target] iframe";
  type Presentation = {body: Element; id: string; owner: string | null;
    host?: HTMLDivElement; row?: HTMLDetailsElement; group?: HTMLButtonElement; operation?: string; status?: string; signature?: string; collapsedSlot?: Element; fromDisk?:boolean};
  type Entry = Presentation & {frame: HTMLIFrameElement; portal: Element; src: string; origin: string; nonce: string; timers: number[]};
  const entries = new Map<HTMLIFrameElement, Entry>();
  // Only data received from a verified live invocation is retained. Keep
  // this bounded to the current document/route and exact provider turn and
  // response identifiers, never reconstruct from a general execution log.
  const retained = new Map<string, Presentation>();
  const ownerOf = (body: Element): string | null => {
    const turn=body.closest("[data-turn-key]");
    const scope=body.closest("[data-content-search-turn-key]");
    const transcript=body.closest("[data-chatgpt-conversation-selection-target]");
    const conversation=transcript?.getAttribute("data-chatgpt-conversation-selection-target");
    const turnId=turn?.getAttribute("data-turn-key");
    const scopeId=scope?.getAttribute("data-content-search-turn-key");
    const users=turn?.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]');
    const userId=users?.length===1?users[0]?.getAttribute("data-chatgpt-search-message-ids"):null;
    if(!conversation||!turnId||!scopeId||!userId||!turn?.contains(scope??null)||
      !location.pathname.endsWith("/c/"+conversation)||turnId!==userId)return null;
    return JSON.stringify([conversation,turnId,scopeId,userId]);
  };
  const keyOf = (e: Presentation) => e.owner ? JSON.stringify([e.owner,e.id]) : null;
  const record = (e:Presentation) => {
    const key=keyOf(e);
    if(!recording||!key||!e.owner||!e.signature||e.operation!=="terminal_exec"||!e.status||e.status==="running")return;
    pending.set(key,{owner:e.owner,id:e.id,signature:e.signature});
    while(pending.size>120){const first=pending.keys().next().value;if(first===undefined)break;pending.delete(first);}
  };
  const expanded = new WeakMap<Element, boolean>();
  let scheduled = 0;
  let disposed = false;
  let frames=0,candidates=0,requests=0,replies=0,accepted=0;
  const valid = (e: Entry) => !disposed && sameRoute() && e.frame.isConnected && e.body.isConnected &&
    e.frame.src === e.src && e.body.getAttribute("data-response-body") === e.id &&
    (!e.owner || ownerOf(e.body)===e.owner) &&
    e.portal.parentElement === e.body && e.portal.contains(e.frame);
  // WindowProxy exposes child references across origins without granting DOM
  // access. The observed provider shell has exactly one inner resource frame.
  // Do not enumerate arbitrary descendants or deliver data to them.
  const resourceWindow = (e: Entry): Window | null => {
    try {
      const outer=e.frame.contentWindow;
      if(!outer)return null;
      if(outer.length===0)return outer;
      return outer.length===1 ? outer.frames[0] ?? null : null;
    } catch {return null;}
  };
  const request = (e: Entry) => {
    if (!valid(e)) return;
    const target=resourceWindow(e);
    if(!target)return;
    requests=Math.min(10000,requests+1);
    // An inner sandbox may have an opaque origin. Only an opaque random
    // challenge is sent with wildcard targeting, never command/result data.
    target.postMessage({type:"equinox-native-run/request-v1",nonce:e.nonce},target===e.frame.contentWindow?e.origin:"*");
  };
  const detach = (e: Presentation) => {
    e.host?.remove();
    e.collapsedSlot?.removeAttribute("data-equinox-run-collapsed");
    delete e.collapsedSlot;
    e.body.removeAttribute("data-equinox-native-run");
  };
  const forget = (e: Entry, keep = true) => {
    for (const timer of e.timers) window.clearTimeout(timer);
    detach(e);
    entries.delete(e.frame);
    const key=keyOf(e);
    if(!keep||!key||!e.host||!e.row||!e.status||e.status==="running")return;
    // Store the presentation only, not a detached provider frame or window.
    // A detached group button closes over its original entry. Drop it
    // before retaining the row, so no provider iframe is kept alive.
    if(e.group){e.group.onclick=null;e.group.remove();delete e.group;}
    const {id,owner,host,row,operation,status,signature}=e;
    const saved: Presentation={body:document.createElement("div"),id,owner,host,row};
    if(operation!==undefined)saved.operation=operation;
    if(status!==undefined)saved.status=status;
    if(signature!==undefined)saved.signature=signature;
    const previous=retained.get(key);
    if(previous)detach(previous);
    retained.set(key,saved);
    while(retained.size>120) {
      const first=retained.keys().next().value;
      if(first===undefined)break;
      const item=retained.get(first);
      if(item)detach(item);
      retained.delete(first);
    }
  };
  function reconcileRetained() {
    for(const [key,e] of retained) {
      const live=[...entries.values()].find(x=>keyOf(x)===key && valid(x));
      if(live) {
        // An exact remounted original has priority. Restore the live
        // presentation only after it receives its own verified reply.
        detach(e);
        if(live.row)retained.delete(key);
        continue;
      }
      const slots=[...document.querySelectorAll("[data-response-body]")].filter(body=>
        body.getAttribute("data-response-body")===e.id && ownerOf(body)===e.owner);
      const body=slots.length===1?slots[0]:null;
      if(!body || body.querySelector("[data-mcp-app-portal-target],iframe") ||
        [...body.childNodes].some(n=>n!==e.host&&(n.nodeType===Node.ELEMENT_NODE||Boolean(n.textContent?.trim())))) {
        detach(e);continue;
      }
      if(e.body!==body) {detach(e);e.body=body;}
      if(e.host&&!e.host.isConnected)body.append(e.host);
      body.setAttribute("data-equinox-native-run","");
    }
  }
  function reconcileGroups() {
    const ready: Presentation[] = [
      ...[...entries.values()].filter(e => e.host?.isConnected && e.row && valid(e)),
      ...[...retained.values()].filter(e=>e.host?.isConnected&&e.row&&ownerOf(e.body)===e.owner),
    ].sort((a,b) => a.body.compareDocumentPosition(b.body) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const groups: Presentation[][] = [];
    const slot = (e: Presentation) => {
      const p=e.body.parentElement;
      return p?.parentElement?.getAttribute("data-spacing")==="activity" && p.children.length===1 ? p : e.body;
    };
    for (const e of ready) {
      const last=groups.at(-1)?.at(-1), previous=last&&slot(last), current=slot(e);
      let adjacent=false;
      if(previous && previous.parentElement===current.parentElement &&
         current.parentElement?.getAttribute("data-spacing")==="activity") {
        let next=previous.nextElementSibling;
        while(next && next!==current && !next.textContent?.trim() && !next.querySelector("iframe,button,img,video,canvas,svg")) next=next.nextElementSibling;
        adjacent=next===current;
      }
      if(adjacent) groups.at(-1)!.push(e); else groups.push([e]);
    }
    for(const e of ready) {
      e.collapsedSlot?.removeAttribute("data-equinox-run-collapsed");
      delete e.collapsedSlot;
      e.host!.classList.remove("eq-run-nested");
    }
    for (const group of groups) {
      const first=group[0]!;
      for (const e of group.slice(1)) {e.group?.remove();delete e.group;}
      if(group.length===1) {
        first.group?.remove();delete first.group;first.row!.hidden=false;
        continue;
      }
      const open=expanded.get(first.body) ?? group.some(e=>e.status==="running");
      const commands=group.filter(e=>e.operation==="terminal_exec").length;
      const other=group.length-commands;
      const title=[commands?tr(commands===1?"1 command":commands+" commands",commands+" komut"):"",
        other?tr(other===1?"1 tool call":other+" tool calls",other+" araç çağrısı"):""].filter(Boolean).join(" · ");
      if(!first.group) {
        first.group=document.createElement("button");
        first.group.type="button";first.group.className="eq-run-group";
        first.host!.prepend(first.group);
      }
      const button=first.group;
      button.textContent=title;
      button.setAttribute("aria-expanded",String(open));
      button.onclick=()=>{expanded.set(first.body,button.getAttribute("aria-expanded")!=="true");reconcileGroups();};
      for(const e of group) {
        e.row!.hidden=!open;
        e.host!.classList.add("eq-run-nested");
        if(!open && e!==first) {
          e.collapsedSlot=slot(e);
          e.collapsedSlot.setAttribute("data-equinox-run-collapsed","");
        }
      }
    }
  }
  function statusLabel(state: string) {
    return state==="running"?tr("Running","Çalışıyor"):state==="failed"?tr("Failed","Başarısız"):
      state==="cancelled"?tr("Cancelled","İptal"):state==="background"?tr("Background","Arka planda"):
      state==="success"?tr("Success","Başarılı"):tr("Completed","Tamamlandı");
  }
  function localizeRow(e: Presentation) {
    if(!e.row||!e.signature)return;
    // The signature was produced from our bounded, validated projection.
    const data=JSON.parse(e.signature) as {state:string;command:string;truncated:boolean;exit:number|null;duration:number|null};
    const status=e.row.querySelector(".eq-run-status");
    const heading=e.row.querySelector(".eq-run-detail-label");
    const footer=e.row.querySelector(".eq-run-footer");
    const waiting=e.row.querySelector(".eq-run-waiting");
    if(status)status.textContent=statusLabel(data.state);
    if(heading)heading.textContent=data.command?"Shell":tr("Result","Sonuç");
    if(waiting)waiting.textContent=tr("Waiting for result…","Sonuç bekleniyor…");
    if(footer)footer.textContent=[
      data.truncated?tr("Output truncated","Çıktı kısaltıldı"):"",
      data.exit!==null?tr("Exit ","Çıkış ")+data.exit:"",
      data.duration!==null?data.duration+" ms":"",statusLabel(data.state)].filter(Boolean).join(" · ");
  }
  function onMessage(event: MessageEvent) {
    if(disposed||!sameRoute()||event.data?.type!=="equinox-native-run/v1")return;
    replies=Math.min(10000,replies+1);
    const e=[...entries.values()].find(x=>{
      const source=resourceWindow(x);
      return source!==null&&source===event.source&&x.nonce===event.data.nonce&&
        (event.origin===x.origin||(source!==x.frame.contentWindow&&event.origin==="null"));
    });
    if(!e||!valid(e))return;
    e.owner ??= ownerOf(e.body);
    const d=event.data.data;
    if(!d||typeof d.operation!=="string"||!/^[a-z][a-z0-9_]{0,159}$/.test(d.operation)||
      !["running","success","complete","failed","cancelled","background"].includes(d.state))return;
    const str=(v:unknown,n:number)=>typeof v==="string"?v.slice(0,n):"";
    const command=str(d.command,12000);
    if(d.operation==="terminal_exec"&&!command)return;
    const data={operation:d.operation as string,state:d.state as string,command,stdout:str(d.stdout,24000),stderr:str(d.stderr,24000),
      result:str(d.result,24000),error:str(d.error,24000),truncated:d.truncated===true,
      exit:Number.isSafeInteger(d.exitCode)?Number(d.exitCode):null,
      duration:typeof d.durationMs==="number"&&Number.isFinite(d.durationMs)&&d.durationMs>=0?Math.round(d.durationMs):null};
    accepted=Math.min(10000,accepted+1);
    const signature=JSON.stringify(data);
    if(signature===e.signature&&e.host?.isConnected)return;
    renderRow(e,data,signature,true);
    record(e);
    const key=keyOf(e);
    if(key&&retained.has(key)) {
      const previous=retained.get(key)!;
      previous.host?.remove();
      previous.collapsedSlot?.removeAttribute("data-equinox-run-collapsed");
      retained.delete(key);
    }
    reconcileRetained();
    reconcileGroups();
  }
  type RunData={operation:string;state:string;command:string;stdout:string;stderr:string;result:string;error:string;truncated:boolean;exit:number|null;duration:number|null};
  function renderRow(e:Presentation,data:RunData,signature:string,attach:boolean) {
    const command=data.command;
    const wasOpen=e.row?.open??false;
    const wasFocused=e.row?.querySelector("summary")===document.activeElement;
    if(!e.host) {
      e.host=document.createElement("div");e.host.className="eq-run-host";e.host.setAttribute("data-equinox-activity-ui","");
    }
    if(attach&&!e.host.isConnected)e.body.append(e.host);
    e.row?.remove();
    const row=document.createElement("details");row.className="eq-run-row";row.open=wasOpen;
    const summary=document.createElement("summary");
    const icon=document.createElement("span");icon.className="eq-run-icon";icon.setAttribute("aria-hidden","true");
    icon.textContent=data.operation==="terminal_exec"?"›_":"◇";
    const name=document.createElement("span");name.className="eq-run-label";name.textContent=command||data.operation.replace(/_/g," ");
    name.title=name.textContent;
    const status=document.createElement("span");status.className="eq-run-status";status.dataset.kind=data.state;
    status.textContent=statusLabel(data.state);
    summary.append(icon,name,status);row.append(summary);
    const detail=document.createElement("div");detail.className="eq-run-detail";
    const heading=document.createElement("div");heading.className="eq-run-detail-label";heading.textContent=command?"Shell":tr("Result","Sonuç");detail.append(heading);
    const pre=(value:string)=>{if(value){const el=document.createElement("pre");el.textContent=value;detail.append(el);}};
    pre(command?"$ "+command:"");pre(data.stdout);
    if(data.stderr)pre("stderr\n"+data.stderr);
    pre(data.error);pre(data.result);
    if(data.state==="running"){
      const waiting=document.createElement("pre");waiting.className="eq-run-waiting";
      waiting.textContent=tr("Waiting for result…","Sonuç bekleniyor…");detail.append(waiting);
    }
    const footer=document.createElement("div");footer.className="eq-run-footer";
    detail.append(footer);row.append(detail);e.host.append(row);
    e.row=row;e.operation=data.operation;e.status=data.state;e.signature=signature;
    localizeRow(e);
    if(attach)e.body.setAttribute("data-equinox-native-run","");
    if(wasFocused&&!row.hidden)summary.focus({preventScroll:true});
  }
  function restore(input:unknown) {
    if(disposed||!sameRoute()||!recording||!Array.isArray(input)||input.length>240)return;
    for(const raw of input){
      if(!raw||typeof raw.owner!=="string"||typeof raw.id!=="string"||typeof raw.signature!=="string")continue;
      const e:Presentation={body:document.createElement("div"),owner:raw.owner,id:raw.id,fromDisk:true};
      const key=keyOf(e);
      if(!key||retained.has(key)||[...entries.values()].some(x=>keyOf(x)===key&&x.row))continue;
      try{
        const data=JSON.parse(raw.signature) as RunData;
        if(data.operation!=="terminal_exec"||data.state==="running"||!data.command)continue;
        renderRow(e,data,raw.signature,false);
        retained.set(key,e);
      }catch{/* invalid cached presentation */}
    }
    while(retained.size>240){const first=retained.keys().next().value;if(first===undefined)break;const old=retained.get(first);if(old)detach(old);retained.delete(first);}
    reconcileRetained();reconcileGroups();
  }
  function scan() {
    scheduled=0;
    if(disposed)return;
    if(!sameRoute()){dispose();return;}
    let changed=false;
    for(const e of entries.values()) {
      if(!valid(e)){forget(e);changed=true;}
      else if(!e.owner){e.owner=ownerOf(e.body);if(e.owner)record(e);}
    }
    const mounted=Array.from(document.querySelectorAll<HTMLIFrameElement>(selector)).slice(-120);
    frames=Math.max(frames,mounted.length);
    for(const frame of mounted) {
      if(entries.has(frame))continue;
      const portal=frame.closest("[data-mcp-app-portal-target]"), body=portal?.parentElement;
      const id=body?.getAttribute("data-response-body");
      if(!body||!portal||!id||body.querySelectorAll(selector).length!==1)continue;
      let origin:string;
      try{origin=new URL(frame.src).origin;}catch{continue;}
      if(!/^https:\/\/connector-id-[a-f0-9-]+\.web-sandbox\.oaiusercontent\.com$/u.test(origin)||
        frame.closest("[data-mcp-app-origin-generated]")?.getAttribute("data-mcp-app-origin-generated")!==origin)continue;
      const e:Entry={frame,body,portal,id,owner:ownerOf(body),src:frame.src,origin,nonce:crypto.randomUUID(),timers:[]};
      candidates=Math.min(10000,candidates+1);
      entries.set(frame,e);
      for(const delay of [0,300,1200,4000,9000,16000])e.timers.push(window.setTimeout(()=>request(e),delay));
    }
    if(changed || retained.size) {
      reconcileRetained();
      reconcileGroups();
    }
  }
  function schedule(){if(!disposed&&!scheduled)scheduled=requestAnimationFrame(scan);}
  const observer=new MutationObserver(records=>{
    if(records.some(r=>!(r.target instanceof Element)||!r.target.closest("[data-equinox-activity-ui]")))schedule();
  });
  function onLoad(event: Event){if(event.target instanceof HTMLIFrameElement){const e=entries.get(event.target);if(e)request(e);else schedule();}}
  function dispose(){if(disposed)return;disposed=true;observer.disconnect();if(scheduled)cancelAnimationFrame(scheduled);
    window.removeEventListener("message",onMessage);window.removeEventListener("load",onLoad,true);
    for(const e of entries.values())forget(e,false);
    for(const e of retained.values())detach(e);
    retained.clear();pending.clear();}
  world.__equinoxRunTimeline={generation,dispose,restore,discardPending(clearRestored=false){
    pending.clear();
    if(clearRestored){
      for(const [key,e] of retained)if(e.fromDisk){detach(e);retained.delete(key);}
      reconcileGroups();
    }
  },take(){
    const items=[...pending.entries()].slice(0,32);
    for(const [key] of items)pending.delete(key);
    return {pathname:location.pathname,items:items.map(([,item])=>item)};
  },refresh(pathname,nextLanguage,nextGeneration,nextRecording) {
    if(disposed||!sameRoute()||location.pathname!==pathname)return false;
    this.generation=nextGeneration;
    recording=nextRecording;if(!recording)pending.clear();
    if(language!==nextLanguage){
      language=nextLanguage;
      for(const e of entries.values())localizeRow(e);
      for(const e of retained.values())localizeRow(e);
      reconcileGroups();
    }
    schedule();
    return true;
  },inspect:()=>({frames,candidates,requests,replies,accepted})};
  window.addEventListener("message",onMessage);
  window.addEventListener("load",onLoad,true);
  observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src","data-response-body","data-mcp-app-portal-target","data-mcp-app-origin-generated","data-spacing"]});
  scan();
}
