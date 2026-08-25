const CHECK_SCRIPT_ORDER = Object.freeze([
  "check",
  "typecheck",
  "type-check",
  "lint",
  "test",
]);

export const WORKFLOW_RECIPE_IDS = Object.freeze([
  "checks",
  "build",
  "qa-and-preview",
]);

const RECIPE_METADATA = Object.freeze({
  checks: Object.freeze({
    id: "checks",
    label: "Project checks",
    description:
      "Temiz çalışma ağacında mevcut check/typecheck/lint/test scriptlerini güvenli sırayla çalıştırır ve sonunda Git temizliğini yeniden doğrular.",
  }),
  build: Object.freeze({
    id: "build",
    label: "Project build",
    description:
      "Temiz çalışma ağacında npm run build çalıştırır ve build sonrasında takipli dosyaların değişmediğini doğrular.",
  }),
  "qa-and-preview": Object.freeze({
    id: "qa-and-preview",
    label: "QA and preview smoke",
    description:
      "Mevcut kalite scriptlerini ve build'i çalıştırır; ardından preview/start sunucusunu geçici olarak açıp loopback HTTP smoke testi yapar ve süreci kapatır.",
  }),
});

function normalizeScripts(scripts) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(scripts).filter(
      ([name, command]) =>
        typeof name === "string" &&
        typeof command === "string" &&
        name.length > 0,
    ),
  );
}

function selectedCheckScripts(scripts) {
  const normalized = normalizeScripts(scripts);
  const selected = [];

  if (typeof normalized.check === "string") {
    selected.push("check");
  } else {
    for (const candidate of ["typecheck", "type-check", "lint"]) {
      if (typeof normalized[candidate] === "string") {
        selected.push(candidate);
      }
    }
  }

  if (typeof normalized.test === "string") {
    selected.push("test");
  }

  return selected;
}

function detectPreviewAdapter(scripts) {
  const normalized = normalizeScripts(scripts);

  if (typeof normalized.preview === "string") {
    return {
      script: "preview",
      adapter: "host-port",
      command: normalized.preview,
    };
  }

  if (typeof normalized.start === "string") {
    const command = normalized.start;

    if (/\bnext\s+start\b/iu.test(command)) {
      return {
        script: "start",
        adapter: "next-start",
        command,
      };
    }
  }

  return null;
}

function normalizePreviewPath(value) {
  const path = value ?? "/";

  if (
    typeof path !== "string" ||
    path.length < 1 ||
    path.length > 200 ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\u0000-\u001f\u007f\s]/u.test(path)
  ) {
    throw new Error(
      "Preview yolu / ile başlayan, boşluk veya kontrol karakteri içermeyen en fazla 200 karakterlik bir path olmalı.",
    );
  }

  return path;
}

function normalizeTimeoutSeconds(value) {
  const timeout = value ?? 300;

  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 900) {
    throw new Error("Workflow adım zaman aşımı 30 ile 900 saniye arasında olmalı.");
  }

  return timeout;
}

function normalizePreviewPort(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Preview portu 1024 ile 65535 arasında olmalı.");
  }

  return value;
}

function scriptStep(script, timeoutSeconds) {
  return Object.freeze({
    id: `npm-${script.replace(/[^a-zA-Z0-9]+/gu, "-")}`,
    kind: "npm-script",
    label: `npm run ${script}`,
    script,
    timeoutSeconds,
  });
}

function gitCleanStep(id, label) {
  return Object.freeze({
    id,
    kind: "git-clean",
    label,
  });
}

export function listWorkflowRecipes(scripts = {}) {
  const normalized = normalizeScripts(scripts);
  const checks = selectedCheckScripts(normalized);
  const preview = detectPreviewAdapter(normalized);

  return WORKFLOW_RECIPE_IDS.map((id) => {
    let available = true;
    let reason = null;

    if (id === "checks" && checks.length === 0) {
      available = false;
      reason = "İzinli check/typecheck/lint/test scripti bulunamadı.";
    }

    if (id === "build" && typeof normalized.build !== "string") {
      available = false;
      reason = "package.json içinde build scripti bulunamadı.";
    }

    if (id === "qa-and-preview") {
      if (typeof normalized.build !== "string") {
        available = false;
        reason = "package.json içinde build scripti bulunamadı.";
      } else if (!preview) {
        available = false;
        reason = "Desteklenen preview veya Next.js start scripti bulunamadı.";
      }
    }

    return {
      ...RECIPE_METADATA[id],
      available,
      reason,
      detectedCheckScripts: checks,
      previewScript: preview?.script ?? null,
      previewAdapter: preview?.adapter ?? null,
    };
  });
}

export function buildWorkflowPlan({
  recipeId,
  scripts,
  options = {},
}) {
  if (!WORKFLOW_RECIPE_IDS.includes(recipeId)) {
    throw new Error(`Bilinmeyen workflow tarifi: ${recipeId}`);
  }

  const normalized = normalizeScripts(scripts);
  const timeoutSeconds = normalizeTimeoutSeconds(options.timeoutSeconds);
  const previewPath = normalizePreviewPath(options.previewPath);
  const previewPort = normalizePreviewPort(options.previewPort);
  const checks = selectedCheckScripts(normalized);
  const preview = detectPreviewAdapter(normalized);
  const steps = [
    gitCleanStep("git-clean-before", "Başlangıç Git temizliğini doğrula"),
  ];

  if (recipeId === "checks") {
    if (checks.length === 0) {
      throw new Error(
        "Bu projede checks tarifi için izinli check/typecheck/lint/test scripti bulunamadı.",
      );
    }

    steps.push(...checks.map((script) => scriptStep(script, timeoutSeconds)));
  }

  if (recipeId === "build") {
    if (typeof normalized.build !== "string") {
      throw new Error("Bu projede build scripti bulunamadı.");
    }

    steps.push(scriptStep("build", timeoutSeconds));
  }

  if (recipeId === "qa-and-preview") {
    if (typeof normalized.build !== "string") {
      throw new Error("qa-and-preview için build scripti gerekli.");
    }

    if (!preview) {
      throw new Error(
        "qa-and-preview için desteklenen preview veya Next.js start scripti gerekli.",
      );
    }

    steps.push(...checks.map((script) => scriptStep(script, timeoutSeconds)));
    steps.push(scriptStep("build", timeoutSeconds));
    steps.push(Object.freeze({
      id: "preview-smoke",
      kind: "preview-smoke",
      label: `Preview smoke testi (${preview.script})`,
      script: preview.script,
      adapter: preview.adapter,
      timeoutSeconds,
      port: previewPort,
      path: previewPath,
    }));
  }

  steps.push(
    gitCleanStep("git-clean-after", "Bitiş Git temizliğini doğrula"),
  );

  return {
    recipe: { ...RECIPE_METADATA[recipeId] },
    options: {
      timeoutSeconds,
      previewPort,
      previewPath,
    },
    steps,
  };
}

export const __test = Object.freeze({
  CHECK_SCRIPT_ORDER,
  selectedCheckScripts,
  detectPreviewAdapter,
  normalizePreviewPath,
  normalizeTimeoutSeconds,
  normalizePreviewPort,
});
