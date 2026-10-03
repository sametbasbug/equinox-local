import { createHash } from "node:crypto";
import fs from "node:fs/promises";

export async function hashStream(stream) {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    digest.update(chunk);
  }
  return Object.freeze({ bytes, sha256: digest.digest("hex") });
}

export async function hashFile(filePath, { suppressCloseErrors = false } = {}) {
  const handle = await fs.open(filePath, "r");
  let result;
  try {
    result = await hashStream(handle.createReadStream());
  } finally {
    const closing = handle.close();
    if (suppressCloseErrors) await closing.catch(() => {});
    else await closing;
  }
  return result;
}
