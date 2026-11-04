import { createEquinoxWorkspaceChat } from "./equinox-workspace-chat.js";

// The real runtime and isolated source verification share these bindings.
// This does not add a browser, model provider, task store, or HTTP service.
type Binding = {
  browserContext: string;
  browserInstanceId?: string;
  conversationId: string;
  tabId?: number;
  canonicalUrl?: string;
};
type Task = {
  taskId: string;
  status: string;
  checkpointRevision: number;
  chatBinding: Binding | null;
};
type TaskStore = {
  checkpoint: (input: {title: string; objective: string; completed: string[]; next: string[]; references: []}) => Promise<unknown>;
  readInternal: (taskId: string) => Promise<Task>;
  bindChat: (input: {taskId: string; binding: Binding; expectUnbound: true}) => Promise<Task>;
};
type ChatBridge = {
  startTaskChat: (input: {taskId: string; checkpointRevision: number; initialMessage: string}) =>
    Promise<{confirmed?: boolean; binding?: Binding}>;
  deliverText: (input: {binding: Binding; deliveryId: string; text: string}) =>
    Promise<{confirmed: boolean; duplicatePrevented?: boolean; userEpoch: string; previousAssistantTurnKey: string}>;
  readFinal: (input: {binding: Binding; userEpoch: string; previousAssistantTurnKey: string}) =>
    Promise<{status: string; text?: string; truncated?: boolean}>;
};
type Dependencies = {
  store: TaskStore;
  chatBridge: ChatBridge;
  agentControl: {assertMutationAllowed: (reason: string) => void};
  withMutationLocks: (keys: string[], action: () => Promise<unknown>) => Promise<unknown>;
};
type HttpError = Error & {statusCode: number};

function conflict(message: string): HttpError {
  return Object.assign(new Error(message), {statusCode: 409});
}

export function createEquinoxWorkspaceActions({store, chatBridge, agentControl, withMutationLocks}: Dependencies) {
  const starts = new Set<string>();
  const chat = createEquinoxWorkspaceChat({
    readTask: (taskId) => store.readInternal(taskId),
    deliverText: (input) => chatBridge.deliverText(input),
    readFinal: (input) => chatBridge.readFinal(input),
    assertMutationAllowed: (reason) => agentControl.assertMutationAllowed(reason),
  });

  async function createTask(input: {title: string; objective: string}): Promise<unknown> {
    return withMutationLocks(["workspace-task-create"], async () => {
      agentControl.assertMutationAllowed("workspace_task_create");
      return store.checkpoint({title: input.title, objective: input.objective, completed: [], next: [], references: []});
    });
  }

  async function startChat(taskId: string): Promise<Task> {
    agentControl.assertMutationAllowed("workspace_chat_start");
    if (starts.has(taskId)) throw conflict("Bu görevin ChatGPT bağlantısı zaten başlatılıyor.");
    starts.add(taskId);
    try {
      const task = await store.readInternal(taskId);
      if (task.status !== "active" || task.chatBinding) {
        throw conflict("Yalnızca aktif ve henüz bağlanmamış görevlerde yeni konuşma başlatılabilir.");
      }
      const started = await chatBridge.startTaskChat({
        taskId, checkpointRevision: task.checkpointRevision,
        initialMessage: "Equinox Local Workspace chat for " + taskId +
          " is connected. Reply only EQL_CLI_READY. Do not run the Task Capsule objective or invoke tools; wait for the next message.",
      });
      if (!started?.confirmed || !started.binding) {
        throw conflict("ChatGPT konuşma bağlantısı doğrulanamadı. Sekmeyi kontrol et; otomatik tekrar yapılmayacak.");
      }
      const updated = await store.bindChat({taskId, binding: started.binding, expectUnbound: true});
      if (!updated.chatBinding || updated.status !== "active") {
        throw conflict("ChatGPT sekmesi açılmış olabilir ancak görev bağlantısı kaydedilemedi. Sekmeyi kontrol et.");
      }
      chat.trustFreshBinding(taskId, started.binding);
      return updated;
    } catch (error) {
      if ((error as {statusCode?: number})?.statusCode) throw error;
      throw conflict("ChatGPT bağlantısı doğrulanamadı. Yeni sekmeyi kontrol et ve otomatik tekrar yapma.");
    } finally {
      starts.delete(taskId);
    }
  }

  return Object.freeze({
    createTask,
    startChat,
    getChatStatus: chat.status,
    sendChat: chat.send,
    acknowledgeChat: chat.acknowledge,
  });
}
