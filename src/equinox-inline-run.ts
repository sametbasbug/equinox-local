import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const INLINE_RUN_URI = "ui://equinox-local/run/v1.html";

/**
 * One component instance belongs to one real provider tool call. Its input
 * and result come directly from the host; no runtime-wide history or guessed
 * conversation attribution, and no extra fetches or duplicate execution.
 */
const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Equinox Local run</title>
<style>
:root{color-scheme:light dark;--fg:#222735;--muted:#788092;--line:#dee3ec;--surface:#f8f9fc;--code:#f0f2f7;--accent:#725baf;--ok:#168052;--bad:#b74444;--pending:#9a7020;font:13px/1.5 system-ui,sans-serif}
:root[data-theme="dark"]{--fg:#ebeef5;--muted:#a5adbf;--line:#383d4c;--surface:#1d222d;--code:#151922;--accent:#ae9cdd;--ok:#71cba2;--bad:#ff9696;--pending:#e1b45b}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--fg:#e6e7eb;--muted:#a4a7b0;--line:#41434b;--surface:#24262d;--code:#1e2025;--accent:#b9a7f3;--ok:#71cba2;--bad:#ff9696;--pending:#e1b45b}}
*{box-sizing:border-box}body{margin:0;padding:2px 0;color:var(--fg);background:transparent}
details{border:1px solid var(--line);border-radius:9px;background:var(--surface);overflow:hidden}
summary{display:grid;grid-template-columns:22px minmax(0,1fr) auto 14px;align-items:start;gap:9px;padding:11px 12px;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}summary:hover{background:var(--code)}
summary:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.icon{display:grid;place-items:center;width:22px;height:22px;color:var(--accent);border-radius:5px;background:var(--code);font:600 13px ui-monospace,monospace}
.title{min-width:0}.eyebrow{font-size:10px;color:var(--muted);margin-bottom:3px;font-weight:670;letter-spacing:.075em}.command{font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.status{white-space:nowrap;font-size:11px;color:var(--pending);padding-top:3px}.status[data-kind=ok]{color:var(--ok)}.status[data-kind=bad]{color:var(--bad)}.status[data-kind=neutral]{color:var(--muted)}
.arrow{color:var(--muted);font-size:16px;line-height:22px;text-align:center}details[open] .arrow{transform:rotate(90deg)}
.body{border-top:1px solid var(--line);padding:10px 12px;display:grid;gap:9px}.field{display:grid;gap:4px}.field-label{font-size:11px;color:var(--muted);font-weight:600}
pre{margin:0;padding:9px 10px;background:var(--code);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--fg)}
.facts{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11px;color:var(--muted)}.facts strong{color:var(--fg);font-weight:600}.empty{color:var(--muted);font-size:12px;padding:5px 0}
@media(max-width:360px){summary{grid-template-columns:20px minmax(0,1fr) 13px;gap:6px}.status{grid-column:2;grid-row:2;padding:0}.arrow{grid-column:3;grid-row:1}}
</style></head><body>
<details id="run"><summary><span class="icon" aria-hidden="true">›_</span><span class="title"><div class="eyebrow" id="operation">Equinox Local</div><div class="command" id="command">Waiting for tool input…</div></span><span class="status" id="status" role="status">Running</span><span class="arrow" aria-hidden="true">›</span></summary><div class="body" id="body"></div></details>
<script>
(function(){
 const $=id=>document.getElementById(id);
 let input=null,result=null,initialized=false,lastHeight=0,hostTheme=null,locale=null;
 const send=(method,params)=>parent.postMessage({jsonrpc:"2.0",method,params},"*");
 function lang(){return (locale||document.documentElement.lang||navigator.language||"en").toLowerCase().startsWith("tr")}
 const tr=(en,turkish)=>lang()?turkish:en;
 function context(ctx){
   if(!ctx||typeof ctx!=="object")return;
   if(ctx.theme==="light"||ctx.theme==="dark"){hostTheme=ctx.theme;document.documentElement.dataset.theme=hostTheme}
   if(typeof ctx.locale==="string"){locale=ctx.locale;document.documentElement.lang=locale}
 }
 function size(){
   if(!initialized)return;
   const height=Math.ceil(document.body.getBoundingClientRect().height);
   if(height>0&&height!==lastHeight){lastHeight=height;send("ui/notifications/size-changed",{height})}
 }
 function contentText(x){
   if(!x)return "";
   if(typeof x.text==="string")return x.text;
   if(typeof x.structuredContent?.text==="string")return x.structuredContent.text;
   if(Array.isArray(x.content)){const texts=x.content.filter(a=>a?.type==="text"&&typeof a.text==="string").map(a=>a.text);if(texts.length)return texts.join("\n")}
   if(x.structuredContent!==undefined&&x.structuredContent!==null)return stringify(x.structuredContent);
   return "";
 }
 function decoded(text){
   if(!text)return null;
   try{return JSON.parse(text)}catch{}
   // The transport can append a turn-budget notice after the actual JSON.
   // Do not synthesize data or guess from prose; parse only a complete prefix.
   const marker=text.lastIndexOf("\n\n[Equinox Local");
   if(marker>0)try{return JSON.parse(text.slice(0,marker))}catch{}
   return null;
 }
 function stringify(value){try{return JSON.stringify(value,null,2)}catch{return String(value)}}
 function field(label,value){
   if(value===undefined||value===null||value==="")return;
   const el=document.createElement("div");el.className="field";
   const title=document.createElement("span");title.className="field-label";title.textContent=label;
   const pre=document.createElement("pre");pre.textContent=typeof value==="string"?value:stringify(value);
   el.append(title,pre);$("body").append(el);
 }
 function fact(box,label,value){if(value===undefined||value===null||value==="")return;const el=document.createElement("span");const strong=document.createElement("strong");strong.textContent=String(value);el.append(document.createTextNode(label+" "),strong);box.append(el)}
 function render(){
   const op=typeof input?.operation==="string"?input.operation:"";
   const args=input?.arguments&&typeof input.arguments==="object"?input.arguments:{};
   const terminal=op==="terminal_exec";
   const txt=contentText(result);
   const payload=decoded(txt);
   const hasResult=result!==null;
   const failed=Boolean(result?.isError||payload?.ok===false||(Number.isInteger(payload?.exitCode)&&payload.exitCode!==0));
   const background=payload?.promoted===true&&payload?.completed===false;
   $("operation").textContent="EQUINOX LOCAL · "+(terminal?tr("Terminal","Terminal"):op?op.replace(/_/g," "):tr("Tool call","Araç çağrısı"));
   $("command").textContent=terminal&&typeof args.command==="string"?args.command:op||tr("Waiting for tool input…","Araç girdisi bekleniyor…");
   $("status").textContent=!hasResult?tr("Running","Çalışıyor"):Number.isInteger(payload?.exitCode)?tr("Exit","Çıkış")+" "+payload.exitCode:background?tr("Background","Arka planda"):failed?tr("Failed","Başarısız"):tr("Completed","Tamamlandı");
   $("status").dataset.kind=!hasResult?"pending":failed?"bad":background?"neutral":"ok";
   $("body").replaceChildren();
   if(terminal){
     const facts=document.createElement("div");facts.className="facts";
     fact(facts,tr("Project","Proje"),payload?.projectName||args.project);
     fact(facts,tr("Directory","Dizin"),payload?.initialCwd||args.cwd);
     fact(facts,tr("Shell","Kabuk"),args.shell);
     fact(facts,tr("Duration","Süre"),Number.isFinite(payload?.durationMs)?payload.durationMs+" ms":null);
     if(facts.childNodes.length)$("body").append(facts);
     field(tr("Command","Komut"),args.command);
     if(payload&&typeof payload==="object"&&!Array.isArray(payload)){
       field("stdout",payload.stdout);field("stderr",payload.stderr);
       if(payload.spawnError)field(tr("Launch error","Başlatma hatası"),payload.spawnError);
       if(!payload.stdout&&!payload.stderr&&!payload.spawnError&&hasResult){const e=document.createElement("div");e.className="empty";e.textContent=tr("No terminal output.","Terminal çıktısı yok.");$("body").append(e)}
       if(payload.stdoutTruncated||payload.stderrTruncated||payload.combinedOutputTruncated){const e=document.createElement("div");e.className="empty";e.textContent=tr("Local returned a truncated result.","Local çıktıyı kısalttı.");$("body").append(e)}
     }else if(hasResult)field(tr("Result","Sonuç"),txt||result?.structuredContent);
   }else{
     if(Object.keys(args).length)field(tr("Arguments","Argümanlar"),args);
     if(hasResult)field(tr("Result","Sonuç"),txt||result?.structuredContent);
   }
   if(!hasResult&&!$("body").childNodes.length){const e=document.createElement("div");e.className="empty";e.textContent=tr("Waiting for the tool result…","Araç sonucu bekleniyor…");$("body").append(e)}
   size();
 }
 function legacy(){
   const o=window.openai;if(!o)return;
   context({theme:o.theme,locale:o.locale});
   if(o.toolInput&&typeof o.toolInput==="object")input=o.toolInput;
   if(o.toolOutput!==undefined&&o.toolOutput!==null)result={structuredContent:o.toolOutput};
   if(o.toolResponseMetadata?.mcp_tool_result)result=o.toolResponseMetadata.mcp_tool_result;
   render();
 }
 window.addEventListener("message",event=>{
   if(event.source!==parent)return;
   const m=event.data;if(!m||m.jsonrpc!=="2.0")return;
   if(m.id===1&&m.result){context(m.result.hostContext);initialized=true;send("ui/notifications/initialized",{});render();return}
   if(m.method==="ui/notifications/tool-input"){input=m.params?.arguments||null;render()}
   if(m.method==="ui/notifications/tool-result"){result=m.params?.result||m.params||{};render()}
   if(m.method==="ui/notifications/host-context-changed"){context(m.params);render()}
   if(m.method==="ui/notifications/tool-cancelled"){result={isError:true,content:[{type:"text",text:tr("Tool call cancelled.","Araç çağrısı iptal edildi.")}]};render()}
   if(m.method==="ping"&&m.id!==undefined)parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},"*");
   if(m.method==="ui/resource-teardown"&&m.id!==undefined)parent.postMessage({jsonrpc:"2.0",id:m.id,result:{}},"*");
 });
 window.addEventListener("openai:set_globals",legacy);
 new ResizeObserver(size).observe(document.body);
 parent.postMessage({jsonrpc:"2.0",id:1,method:"ui/initialize",params:{protocolVersion:"2026-01-26",appInfo:{name:"Equinox Local run",version:"1.0.0"},appCapabilities:{}}},"*");
 $("run").addEventListener("toggle",size);
 legacy();render();
})();
</script></body></html>`;

export function registerInlineRunResource(server: McpServer): void {
  server.registerResource("Equinox Local run", INLINE_RUN_URI, {}, async () => ({
    contents: [{
      uri: INLINE_RUN_URI,
      mimeType: "text/html;profile=mcp-app",
      text: HTML,
      _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));
}
