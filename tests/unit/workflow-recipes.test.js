import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkflowPlan,
  listWorkflowRecipes,
} from "../../src/workflow-recipes.js";

test("workflow recipe availability follows package scripts", () => {
  const recipes = listWorkflowRecipes({
    check: "astro check",
    test: "node --test",
    build: "astro build",
    preview: "astro preview",
  });

  assert.equal(recipes.find((item) => item.id === "checks").available, true);
  assert.equal(recipes.find((item) => item.id === "build").available, true);
  assert.equal(recipes.find((item) => item.id === "qa-and-preview").available, true);
});

test("checks plan avoids duplicating typecheck and lint when check exists", () => {
  const plan = buildWorkflowPlan({
    recipeId: "checks",
    scripts: {
      check: "npm run typecheck && npm test",
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      test: "node --test",
    },
  });

  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ["git-clean-before", "npm-check", "npm-test", "git-clean-after"],
  );
});

test("checks plan falls back to typecheck and lint without check", () => {
  const plan = buildWorkflowPlan({
    recipeId: "checks",
    scripts: {
      typecheck: "tsc --noEmit",
      lint: "eslint .",
    },
  });

  assert.deepEqual(
    plan.steps.map((step) => step.id),
    ["git-clean-before", "npm-typecheck", "npm-lint", "git-clean-after"],
  );
});

test("qa-and-preview detects Astro/Vite style preview", () => {
  const plan = buildWorkflowPlan({
    recipeId: "qa-and-preview",
    scripts: {
      build: "astro build",
      preview: "astro preview",
    },
    options: {
      previewPort: 4455,
      previewPath: "/health",
      timeoutSeconds: 120,
    },
  });

  const preview = plan.steps.find((step) => step.kind === "preview-smoke");
  assert.equal(preview.script, "preview");
  assert.equal(preview.adapter, "host-port");
  assert.equal(preview.port, 4455);
  assert.equal(preview.path, "/health");
});

test("qa-and-preview detects Next.js start adapter", () => {
  const plan = buildWorkflowPlan({
    recipeId: "qa-and-preview",
    scripts: {
      build: "next build",
      start: "next start",
    },
  });

  const preview = plan.steps.find((step) => step.kind === "preview-smoke");
  assert.equal(preview.script, "start");
  assert.equal(preview.adapter, "next-start");
});

test("workflow recipes reject missing requirements and unsafe preview path", () => {
  assert.throws(
    () => buildWorkflowPlan({ recipeId: "build", scripts: {} }),
    /build scripti/u,
  );
  assert.throws(
    () => buildWorkflowPlan({
      recipeId: "qa-and-preview",
      scripts: { build: "astro build", preview: "astro preview" },
      options: { previewPath: "https://example.com" },
    }),
    /Preview yolu/u,
  );
});
