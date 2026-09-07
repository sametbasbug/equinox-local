import assert from "node:assert/strict";
import test from "node:test";

import { registerProjectDiscoveryTools } from "../../src/equinox-local-project-tools.js";

function createHarness() {
  const registrations = new Map();
  const projectDefinitions = {
    app: { name: "App", root: "/tmp/app" },
    broken: { name: "Broken", root: "/tmp/broken" },
  };
  const fileRootDefinitions = {
    ...projectDefinitions,
    downloads: { name: "Downloads", root: "/tmp/downloads" },
  };

  registerProjectDiscoveryTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    projectIds: ["app", "broken"],
    projectDefinitions,
    fileRootIds: ["app", "broken", "downloads"],
    fileRootDefinitions,
    fullFileAccess: true,
    defaultProject: "app",
    async resolveProjectContext(projectId) {
      if (projectId === "broken") throw new Error("fixture unavailable");
      return {
        id: projectId,
        name: projectDefinitions[projectId].name,
        rootRealPath: projectDefinitions[projectId].root,
      };
    },
    async resolveFileRootContext(rootId) {
      return {
        id: rootId,
        name: fileRootDefinitions[rootId].name,
        rootRealPath: fileRootDefinitions[rootId].root,
      };
    },
    async execFileImpl(_binary, args) {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { stdout: "/tmp/app\n" };
      if (command === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n" };
      if (command === "status --porcelain=v1 --untracked-files=all") {
        return { stdout: " M changed.txt\n?? new.txt\n" };
      }
      if (command === "remote get-url origin") {
        return { stdout: "https://secret-token@github.com/example/repo.git\n" };
      }
      throw new Error(`Unexpected git fixture command: ${command}`);
    },
    fsImpl: {
      async realpath(value) {
        return value;
      },
    },
    gitEnv: { PATH: "/usr/bin" },
    textResult: (text) => ({ text }),
  });

  return registrations;
}

test("project discovery tools preserve bounded project/root status output", async () => {
  const registrations = createHarness();
  const listProjects = registrations.get("list_projects");

  assert.ok(listProjects);
  assert.equal(listProjects.options.projectAware, false);
  assert.equal(listProjects.config.annotations.readOnlyHint, true);

  const result = await listProjects.handler({});
  assert.match(result.text, /Dosya erişim modu: FULL/u);
  assert.match(result.text, /Varsayılan proje: app/u);
  assert.match(result.text, /app — App/u);
  assert.match(result.text, /Branch: main/u);
  assert.match(result.text, /Çalışma ağacı: 2 değişiklik/u);
  assert.match(result.text, /Origin: https:\/\/\[REDACTED\]@github\.com\/example\/repo\.git/u);
  assert.match(result.text, /broken — Broken[\s\S]*Durum: Kullanılamıyor[\s\S]*fixture unavailable/u);
  assert.match(result.text, /downloads — Downloads[\s\S]*Tür: Yapılandırılmış dosya kökü/u);
  assert.equal(result.text.includes("secret-token"), false);
});
