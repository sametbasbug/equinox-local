import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyProjectPath,
  hashFile,
} from "../../src/project-transfer.js";

async function withTempDirectory(run) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "equinox-transfer-test-"),
  );

  try {
    await run(directory);
  } finally {
    await fs.rm(directory, {
      recursive: true,
      force: true,
    });
  }
}

test("single files are copied with digest metadata", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source.txt");
    const destination = path.join(directory, "nested", "target.txt");
    await fs.writeFile(source, "hello transfer\n");

    const result = await copyProjectPath({
      sourcePath: source,
      destinationPath: destination,
    });

    assert.equal(result.sourceType, "file");
    assert.equal(result.fileCount, 1);
    assert.equal(result.replaced, false);
    assert.equal(
      await fs.readFile(destination, "utf8"),
      "hello transfer\n",
    );
    assert.equal(result.sha256, await hashFile(destination));
  });
});

test("directory trees are copied without symlinks", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(path.join(source, "nested"), {
      recursive: true,
    });
    await fs.writeFile(path.join(source, "a.txt"), "a");
    await fs.writeFile(path.join(source, "nested", "b.txt"), "b");

    const result = await copyProjectPath({
      sourcePath: source,
      destinationPath: destination,
    });

    assert.equal(result.sourceType, "directory");
    assert.equal(result.fileCount, 2);
    assert.equal(
      await fs.readFile(path.join(destination, "nested", "b.txt"), "utf8"),
      "b",
    );
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  });
});

test("existing files require matching SHA before replacement", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source.txt");
    const destination = path.join(directory, "target.txt");
    await fs.writeFile(source, "new");
    await fs.writeFile(destination, "old");

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
        replaceExisting: true,
      }),
      /SHA-256 özeti gerekli/u,
    );

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
        replaceExisting: true,
        expectedDestinationSha256: "0".repeat(64),
      }),
      /özeti değişti/u,
    );

    const result = await copyProjectPath({
      sourcePath: source,
      destinationPath: destination,
      replaceExisting: true,
      expectedDestinationSha256:
        await hashFile(destination),
    });

    assert.equal(result.replaced, true);
    assert.equal(await fs.readFile(destination, "utf8"), "new");
  });
});

test("blocked nested entries abort directory copies", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, ".env"), "secret");

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
        shouldRejectEntry: (name) => name === ".env",
      }),
      /Aktarıma kapalı/u,
    );

    await assert.rejects(
      fs.access(destination),
      /ENOENT/u,
    );
  });
});

test("symlinks are rejected", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "real.txt"), "real");
    await fs.symlink(
      path.join(source, "real.txt"),
      path.join(source, "link.txt"),
    );

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
      }),
      /Sembolik bağlantı/u,
    );
  });
});

test("file and byte limits are enforced before destination creation", async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, "source");
    const destination = path.join(directory, "destination");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "a.txt"), "1234");
    await fs.writeFile(path.join(source, "b.txt"), "5678");

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
        maxFiles: 1,
      }),
      /dosya sınırını/u,
    );

    await assert.rejects(
      copyProjectPath({
        sourcePath: source,
        destinationPath: destination,
        maxBytes: 4,
      }),
      /MB sınırını/u,
    );
  });
});
