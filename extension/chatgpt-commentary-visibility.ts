// Shared MAIN-world document_start script for Browser and native Assistant.
// Only exact ChatGPT conversation stream and history responses are eligible.
// No token, request body or conversation is retained.
(() => {
  if (location.origin !== "https://chatgpt.com" || window.top !== window) return;
  const nativeFetch = window.fetch;
  const encoder = new TextEncoder();
  const MAX_FRAME = 1024 * 1024;
  function isPublicProgress(message: any): boolean {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const metadata = message.metadata;
    return typeof message.id === "string" && message.id.length > 0
      && message.author?.role === "assistant"
      && (message.channel === "commentary" || metadata?.message_channel === "commentary")
      && (message.recipient === undefined || message.recipient === "all")
      && message.content?.content_type === "text"
      && Array.isArray(message.content.parts)
      && metadata && typeof metadata === "object"
      // ChatGPT also sets is_thinking_preamble_message=true on public
      // commentary progress. It is NOT proof of private analysis; role,
      // commentary channel and recipient=all establish public visibility.
      && metadata.message_type === "next"
      && message.end_turn !== true
      && metadata.is_visually_hidden !== true
      && metadata.is_hidden !== true;
  }

  function changeFrame(frame: string, state: { currentPublicProgress: boolean }): string {
    // SSE records must contain one complete JSON data field, not multiline
    // fragments or unrecognized control/event framing.
    const lines = frame.split(/\r?\n/u);
    const data = lines.filter((line) => line.startsWith("data: "));
    if (data.length !== 1) return frame;
    const raw = data[0]!.slice(6);
    if (!raw.startsWith("{") || raw.length > MAX_FRAME) return frame;
    let payload: any;
    try { payload = JSON.parse(raw); } catch { return frame; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return frame;
    // ChatGPT's conversation SSE wraps full message snapshots under v.message.
    // Direct message snapshots and full-message patch operations also occur.
    // Do not modify metadata-only deltas: they do not establish whether the
    // target is a user-facing commentary message or private analysis/tool work.
    let changed = false;
    const reveal = (message: any): void => {
      if (!message || typeof message !== "object") return;
      // Each full message establishes the recipient and channel for later
      // /message/metadata patches in this same SSE response.
      state.currentPublicProgress = isPublicProgress(message);
      if (!state.currentPublicProgress || message.metadata.is_visually_hidden_from_conversation !== true) return;
      message.metadata.is_visually_hidden_from_conversation = false;
      changed = true;
    };
    reveal(payload.message);
    if (payload.v && typeof payload.v === "object" && !Array.isArray(payload.v)) {
      reveal(payload.v.message);
    }
    if (Array.isArray(payload.v)) {
      for (const op of payload.v) {
        if (!op || typeof op !== "object") continue;
        if ((op.o === "add" || op.o === "replace") && (op.p === "/message" || op.p === "")) {
          reveal(op.v);
        } else if (state.currentPublicProgress && (op.o === "append" || op.o === "add" || op.o === "replace")
          && op.p === "/message/metadata" && op.v && typeof op.v === "object"
          && op.v.is_visually_hidden_from_conversation === true) {
          // ChatGPT sometimes hides the FOURTH progress message only in a
          // later metadata patch, even though its initial snapshot was public.
          op.v.is_visually_hidden_from_conversation = false;
          changed = true;
        } else if (state.currentPublicProgress && (op.o === "add" || op.o === "replace")
          && op.p === "/message/metadata/is_visually_hidden_from_conversation" && op.v === true) {
          op.v = false;
          changed = true;
        }
      }
    }
    return changed ? frame.replace(data[0]!, "data: " + JSON.stringify(payload)) : frame;
  }

  function wrap(response: Response, body: BodyInit): Response {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const wrapped = new Response(body, {status:response.status,statusText:response.statusText,headers});
    Object.defineProperties(wrapped, {
      url:{value:response.url}, redirected:{value:response.redirected}, type:{value:response.type},
    });
    return wrapped;
  }

  // A completed turn can be hydrated from a fresh conversation response.
  // Only full, explicitly public commentary records in the exact mapping
  // are eligible. Never reconstruct missing records or read other endpoints.
  async function rewriteHistory(response:Response, conversationId:string):Promise<Response> {
    if(response.status!==200 || !response.body ||
      !/^application\/json(?:\s*;|\s*$)/iu.test(response.headers.get("content-type")||""))return response;
    try {
      const url=new URL(response.url);
      if(url.origin!==location.origin||url.pathname!=="/backend-api/conversations/"+conversationId)return response;
      const MAX_HISTORY=16*1024*1024;
      const length=Number(response.headers.get("content-length")||0);
      if(length>MAX_HISTORY)return response;
      const reader=response.clone().body!.getReader();
      const decoder=new TextDecoder();
      let raw="",bytes=0;
      try {
        while(true){
          const {done,value}=await reader.read();
          if(done)break;
          bytes+=value.byteLength;
          if(bytes>MAX_HISTORY){void reader.cancel().catch(()=>{});return response;}
          raw+=decoder.decode(value,{stream:true});
        }
        raw+=decoder.decode();
      }finally{reader.releaseLock();}
      const payload=JSON.parse(raw);
      if(!payload||typeof payload!=="object"||Array.isArray(payload))return response;
      const conversation=payload.mapping?payload:payload.conversation;
      if(!conversation||typeof conversation!=="object"||
        (conversation.conversation_id!==undefined&&conversation.conversation_id!==conversationId)||
        (conversation.id!==undefined&&conversation.id!==conversationId)||
        !conversation.mapping||typeof conversation.mapping!=="object"||Array.isArray(conversation.mapping))return response;
      let changed=false;
      for(const node of Object.values(conversation.mapping) as any[]){
        const message=node?.message;
        if(message?.recipient==="all"&&isPublicProgress(message)&&message.metadata.is_visually_hidden_from_conversation===true){
          message.metadata.is_visually_hidden_from_conversation=false;
          changed=true;
        }
      }
      return changed?wrap(response,JSON.stringify(payload)):response;
    }catch{return response;}
  }

  function rewrite(response: Response): Response {
    if (!response.body || response.status !== 200 ||
        !/^text\/event-stream(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") || "")) return response;
    const decoder = new TextDecoder();
    const state = { currentPublicProgress: false };
    let pending = "";
    let passthrough = false;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(value, controller) {
        if (passthrough) { controller.enqueue(value); return; }
        pending += decoder.decode(value, { stream: true });
        while (true) {
          const match = /\r?\n\r?\n/u.exec(pending);
          if (!match) break;
          const end = match.index + match[0].length;
          controller.enqueue(encoder.encode(changeFrame(pending.slice(0, match.index), state) + match[0]));
          pending = pending.slice(end);
        }
        if (pending.length > MAX_FRAME) {
          // Do not interpret an oversized or incomplete event.
          controller.enqueue(encoder.encode(pending + decoder.decode()));
          pending = "";
          passthrough = true;
        }
      },
      flush(controller) {
        if (!passthrough) {
          pending += decoder.decode();
          if (pending) controller.enqueue(encoder.encode(pending));
        }
      },
    }));
    return wrap(response,stream);
  }

  window.fetch = function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const result = nativeFetch.apply(this, arguments as any);
    try {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      if(url.origin!==location.origin)return result;
      if(url.pathname==="/backend-api/f/conversation"&&method==="POST")return result.then(rewrite);
      const history=/^\/backend-api\/conversations\/([a-f0-9-]{36})$/iu.exec(url.pathname);
      if(method==="GET"&&history?.[1])return result.then(response=>rewriteHistory(response,history[1]!));
    } catch { /* Unknown requests are untouched. */ }
    return result;
  };
})();
