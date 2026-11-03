import { createEquinoxWorkspaceChat } from "./equinox-workspace-chat.js";
function conflict(message) {
    return Object.assign(new Error(message), { statusCode: 409 });
}
export function createEquinoxWorkspaceActions({ store, chatBridge, agentControl, withMutationLocks }) {
    const starts = new Set();
    const chat = createEquinoxWorkspaceChat({
        readTask: (taskId) => store.readInternal(taskId),
        deliverText: (input) => chatBridge.deliverText(input),
        readFinal: (input) => chatBridge.readFinal(input),
        assertMutationAllowed: (reason) => agentControl.assertMutationAllowed(reason),
    });
    async function createTask(input) {
        return withMutationLocks(["workspace-task-create"], async () => {
            agentControl.assertMutationAllowed("workspace_task_create");
            return store.checkpoint({ title: input.title, objective: input.objective, completed: [], next: [], references: [] });
        });
    }
    async function startChat(taskId) {
        agentControl.assertMutationAllowed("workspace_chat_start");
        if (starts.has(taskId))
            throw conflict("Bu görevin ChatGPT bağlantısı zaten başlatılıyor.");
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
            const updated = await store.bindChat({ taskId, binding: started.binding, expectUnbound: true });
            if (!updated.chatBinding || updated.status !== "active") {
                throw conflict("ChatGPT sekmesi açılmış olabilir ancak görev bağlantısı kaydedilemedi. Sekmeyi kontrol et.");
            }
            chat.trustFreshBinding(taskId, started.binding);
            return updated;
        }
        catch (error) {
            if (error?.statusCode)
                throw error;
            throw conflict("ChatGPT bağlantısı doğrulanamadı. Yeni sekmeyi kontrol et ve otomatik tekrar yapma.");
        }
        finally {
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
