import fs from "node:fs/promises";
import { constants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";
// The signed installer and updater validate the RESPONDING process identity,
// not a public loopback port. Reuse the already-running authenticated CLI
// socket and its fixed Control Center status operation; this is not another
// listener or generic IPC/command client.
export async function readEquinoxLocalPrivateStatus() {
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "win32")
        throw new Error("Unsupported private status platform.");
    const directory = equinoxLocalPlatformPaths({ platform }).stateRoot;
    const descriptorPath = path.join(directory, "cli-ipc.json");
    const handle = await fs.open(descriptorPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let descriptor;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192 ||
            (platform === "darwin" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
            throw new Error("Private status discovery file is not user-owned.");
        }
        descriptor = JSON.parse(await handle.readFile("utf8"));
    }
    finally {
        await handle.close();
    }
    if (!descriptor || descriptor.version !== 1 || typeof descriptor.endpoint !== "string" ||
        typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/u.test(descriptor.token) ||
        !Number.isSafeInteger(descriptor.pid) || Number(descriptor.pid) < 1) {
        throw new Error("Private status discovery identity is invalid.");
    }
    const endpoint = descriptor.endpoint;
    if (platform === "darwin") {
        const uid = process.getuid?.();
        const parent = path.dirname(endpoint);
        if (typeof uid !== "number" ||
            !new RegExp(`^/tmp/equinox-local-${uid}(?:-[a-z0-9][a-z0-9-]{0,31})?$`, "u").test(parent) ||
            path.basename(endpoint) !== "cli.sock")
            throw new Error("Private status socket is not trusted.");
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
            throw new Error("Private status socket parent is not private.");
        }
    }
    else if (!/^\\\\\.\\pipe\\equinox-local-cli-[a-f0-9]{32}$/u.test(endpoint)) {
        throw new Error("Private status pipe identity is invalid.");
    }
    const request = JSON.stringify({ token: descriptor.token, action: "control.request", method: "GET",
        path: "/api/v1/status", backgroundRefresh: true });
    return await new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.setEncoding("utf8");
        let settled = false;
        let data = "";
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            socket.destroy();
            reject(error);
        };
        socket.setTimeout(3_000, () => fail(new Error("Private status request timed out.")));
        socket.once("connect", () => socket.write(`${request}\n`));
        socket.on("data", (chunk) => {
            if (settled)
                return;
            data += chunk;
            if (Buffer.byteLength(data, "utf8") > 2 * 1024 * 1024) {
                fail(new Error("Private status reply exceeded its size limit."));
                return;
            }
            const line = data.indexOf("\n");
            if (line < 0)
                return;
            try {
                const envelope = JSON.parse(data.slice(0, line));
                if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
                    throw new Error("Invalid status reply envelope.");
                const result = envelope;
                if (result.ok !== true || result.result?.status !== 200 || result.result.body?.ok !== true) {
                    throw new Error("Private Control Center status is unavailable.");
                }
                const body = result.result.body;
                if (!body || typeof body !== "object" || Array.isArray(body) ||
                    body.status?.server?.pid !== descriptor.pid) {
                    throw new Error("Private status responder identity mismatch.");
                }
                settled = true;
                socket.end();
                resolve(body);
            }
            catch (error) {
                fail(error instanceof Error ? error : new Error("Private status reply is invalid."));
            }
        });
        socket.once("error", (error) => fail(error));
        socket.once("end", () => fail(new Error("Private status socket closed before replying.")));
    });
}
