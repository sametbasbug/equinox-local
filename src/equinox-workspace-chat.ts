// A narrow human-facing adapter to the existing task-bound Equinox Browser Chat Bridge.
// Keeps only the latest turn in memory; ChatGPT remains the conversation record.
type ChatTask = {
  taskId: string; status: string;
  chatBinding: {browserContext: string; conversationId: string; browserInstanceId?: string} | null;
};
type ChatReceipt = {userEpoch: string; previousAssistantTurnKey: string};
type ChatDelivery = ChatReceipt & {confirmed: boolean; duplicatePrevented?: boolean};
type ChatRead = {status: string; text?: string; truncated?: boolean};
type ChatState = {
  status: "sending" | "waiting" | "ready" | "uncertain";
  requestId: string; message: string; receipt?: ChatReceipt;
  response?: string; truncated?: boolean; bindingKey: string;
};
type ChatDependencies = {
  readTask: (taskId: string) => Promise<ChatTask>;
  deliverText: (input: {binding: NonNullable<ChatTask["chatBinding"]>; deliveryId: string; text: string}) => Promise<ChatDelivery>;
  readFinal: (input: {binding: NonNullable<ChatTask["chatBinding"]>} & ChatReceipt) => Promise<ChatRead>;
  assertMutationAllowed: (reason: string) => void;
};
const TASK_ID = /^task-[a-z0-9-]{6,80}$/u;
const REQUEST_ID = /^[a-z0-9-]{8,64}$/u;

function chatError(message: string, statusCode = 409): Error & {statusCode: number} {
  return Object.assign(new Error(message), {statusCode});
}

export function createEquinoxWorkspaceChat(deps: ChatDependencies) {
  const sessions = new Map<string, ChatState>();
  const reading = new Set<string>();
  // Runtime restarts deliberately lose pending receipts. Require the human
  // to inspect the exact conversation again rather than silently treating a
  // potentially delivered message as unsent.
  const inspected = new Map<string, string>();
  const bindingKey = (binding: NonNullable<ChatTask["chatBinding"]>): string =>
    [binding.browserContext, binding.browserInstanceId ?? "", binding.conversationId].join(":");

  function trustFreshBinding(taskId: string, binding: NonNullable<ChatTask["chatBinding"]>) {
    if (!TASK_ID.test(taskId) || binding.browserContext !== "user") throw chatError("Geçersiz sohbet bağlantısı.", 400);
    inspected.set(taskId, bindingKey(binding));
  }

  async function boundTask(taskId: string): Promise<ChatTask & {chatBinding: NonNullable<ChatTask["chatBinding"]>}> {
    if (!TASK_ID.test(taskId)) throw chatError("Geçersiz görev.", 400);
    const task = await deps.readTask(taskId);
    if (task?.status !== "active" || task?.chatBinding?.browserContext !== "user") {
      throw chatError("Bu görev için aktif, doğrulanmış Your Browser sohbet bağlantısı yok.");
    }
    const key = bindingKey(task.chatBinding);
    if (inspected.has(taskId) && inspected.get(taskId) !== key) inspected.delete(taskId);
    if (sessions.has(taskId) && sessions.get(taskId)?.bindingKey !== key) sessions.delete(taskId);
    return task as ChatTask & {chatBinding: NonNullable<ChatTask["chatBinding"]>};
  }

  function publicState(taskId: string) {
    const record = sessions.get(taskId);
    if (!record) return {status: inspected.has(taskId) ? "idle" as const : "unavailable" as const};
    return {
      status: record.status,
      requestId: record.requestId,
      message: record.message,
      ...(record.response !== undefined ? {response: record.response, truncated: record.truncated === true} : {}),
    };
  }

  async function status(taskId: string) {
    const task = await boundTask(taskId);
    const record = sessions.get(taskId);
    if (record?.status !== "waiting" || !record.receipt || reading.has(taskId)) return publicState(taskId);
    reading.add(taskId);
    try {
      const answer = await deps.readFinal({binding: task.chatBinding, ...record.receipt});
      if (answer.status === "ready" && typeof answer.text === "string" && answer.text.trim()) {
        record.status = "ready";
        record.response = answer.text.slice(0, 32_000);
        record.truncated = answer.truncated === true || answer.text.length > 32_000;
      }
    } catch (error) {
      // Do not resend on read failures, or guess which human/agent turn is current.
      if ((error as {code?: string})?.code === "CHAT_BRIDGE_DRIFTED") record.status = "uncertain";
    } finally {
      reading.delete(taskId);
    }
    return publicState(taskId);
  }

  async function send(taskId: string, input: {message?: string; requestId?: string}) {
    const task = await boundTask(taskId);
    const message = input.message?.trim();
    const requestId = input.requestId;
    if (typeof message !== "string" || !message || message.length > 3800 || /[\r\n\u0000]/u.test(message)) {
      throw chatError("Şimdilik tek satırlık, en fazla 3800 karakterlik mesaj gönderebilirsin.", 400);
    }
    if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) throw chatError("Geçersiz mesaj kimliği.", 400);
    if (inspected.get(taskId) !== bindingKey(task.chatBinding)) {
      throw chatError("Bu konuşma için önce ChatGPT sekmesini kontrol edip bağlantıyı onayla.");
    }
    const current = sessions.get(taskId);
    if (current) {
      if (current.requestId === requestId) {
        if (current.message !== message) throw chatError("Bu mesaj kimliği başka bir metin için zaten kullanılmış.");
        return publicState(taskId);
      }
      if (current.status !== "ready") throw chatError("Önceki mesajın durumu netleşmeden yeni mesaj gönderilemez.");
    }
    deps.assertMutationAllowed("workspace_chat_send");
    // Record intent before crossing the browser boundary. HTTP retry with the same
    // request ID returns this state; it never invokes delivery a second time.
    const entry: ChatState = {status: "sending", message, requestId, bindingKey: bindingKey(task.chatBinding)};
    sessions.set(taskId, entry);
    try {
      const result = await deps.deliverText({
        binding: task.chatBinding, deliveryId: "tgb-" + requestId, text: message,
      });
      if (!result.confirmed || result.duplicatePrevented || !result.userEpoch || !result.previousAssistantTurnKey) {
        entry.status = "uncertain";
      } else {
        entry.receipt = {userEpoch: result.userEpoch, previousAssistantTurnKey: result.previousAssistantTurnKey};
        entry.status = "waiting";
      }
    } catch (error) {
      if ((error as {code?: string})?.code === "CHAT_BRIDGE_NOT_READY") {
        // Bridge asserts this before a browser submit; retain the previous answer.
        if (current) sessions.set(taskId, current);
        else sessions.delete(taskId);
        throw chatError("ChatGPT henüz hazır değil. Konuşmayı kontrol edip yeniden deneyebilirsin.");
      }
      entry.status = "uncertain";
    }
    return publicState(taskId);
  }

  async function acknowledge(taskId: string, requestId: string) {
    const task = await boundTask(taskId);
    const entry = sessions.get(taskId);
    if (!entry && requestId === "confirm-inspected") {
      inspected.set(taskId, bindingKey(task.chatBinding));
      return publicState(taskId);
    }
    if (!entry || entry.requestId !== requestId || entry.status !== "uncertain") {
      throw chatError("Onaylanacak belirsiz gönderim bulunamadı.");
    }
    // User must inspect the exact ChatGPT conversation first. Never retry here.
    sessions.delete(taskId);
    return publicState(taskId);
  }

  return Object.freeze({status, send, acknowledge, trustFreshBinding});
}
