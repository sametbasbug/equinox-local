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

test("workflow recipe plans allow only named package scripts and reject missing build or checks", () => {
  const sneaky = {
    "": "malformed",
    "check; rm -rf /": "unapproved",
    "prebuild": "unapproved",
    "test": "node --test",
    "build": "npm run build",
    "preview": "vite preview",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "type-check": "tsc --noEmit",
    "check": 42,
  };
  const checks = buildWorkflowPlan({recipeId:"checks",scripts:sneaky});
  assert.deepEqual(checks.steps.map(s=>s.id),[
    "git-clean-before","npm-typecheck","npm-type-check","npm-lint","npm-test","git-clean-after",
  ]);
  assert.ok(checks.steps.every(step=>step.kind!=="npm-script" || (
    ["typecheck","type-check","lint","test"].includes(step.script)
  )));
  assert.equal(checks.steps[0].kind,"git-clean");
  assert.equal(checks.steps.at(-1).kind,"git-clean");
  for(const recipeId of ["", "status", "npm install", "../build", "CHECKS", null]){
    assert.throws(()=>buildWorkflowPlan({recipeId,scripts:sneaky}),/Bilinmeyen workflow tarifi/u);
  }
  const empty=listWorkflowRecipes({"test":false,"build":0,"preview":"vite preview"});
  assert.deepEqual(empty.map(r=>r.available),[false,false,false]);
  assert.throws(()=>buildWorkflowPlan({recipeId:"checks",scripts:{"test":false}}),/izinli/u);
  assert.throws(()=>buildWorkflowPlan({recipeId:"qa-and-preview",scripts:{build:"npm run build",start:"node server.js"}}),/preview veya Next.js start/u);
});

test("workflow preview route admission rejects external URLs, whitespace, control bytes and overlong paths", () => {
  const scripts={build:"vite build",preview:"vite preview"};
  const invalid=[
    "", "no-slash", "//external.invalid/", "https://example.invalid/",
    " /health", "/has space", "/new\nline", "/tab\t", "/null\u0000", "/delete\u007f",
    "/".repeat(201), 4, [], {},
  ];
  for(const previewPath of invalid) {
    assert.throws(()=>buildWorkflowPlan({
      recipeId:"qa-and-preview",scripts,options:{previewPath},
    }),/Preview yolu/u,JSON.stringify(previewPath));
  }
  const accepted=["/", "/health", "/api/status?ready=1", "/"+"a".repeat(199)];
  for(const previewPath of accepted){
    const plan=buildWorkflowPlan({recipeId:"qa-and-preview",scripts,options:{previewPath}});
    const preview=plan.steps.find(step=>step.kind==="preview-smoke");
    assert.equal(preview.path,previewPath);
    assert.equal(preview.adapter,"host-port");
  }
});

test("workflow budget and preview port stay integer bounded with safe default values", () => {
  const scripts={build:"vite build",preview:"vite preview",test:"node --test"};
  const badTime=[-1,0,29,901,1000,40.5,"300",NaN,Infinity,{},[]];
  const badPort=[-1,0,1023,65536,5000.1,"4455",false,NaN,Infinity];
  for(const timeoutSeconds of badTime){
    assert.throws(()=>buildWorkflowPlan({
      recipeId:"qa-and-preview",scripts,options:{timeoutSeconds},
    }),/30 ile 900/u,String(timeoutSeconds));
  }
  for(const previewPort of badPort){
    assert.throws(()=>buildWorkflowPlan({
      recipeId:"qa-and-preview",scripts,options:{previewPort},
    }),/1024 ile 65535/u,String(previewPort));
  }
  for(const timeoutSeconds of [30,900]){
    for(const previewPort of [1024,65535]){
      const plan=buildWorkflowPlan({
        recipeId:"qa-and-preview",scripts,options:{timeoutSeconds,previewPort},
      });
      assert.equal(plan.options.timeoutSeconds,timeoutSeconds);
      assert.equal(plan.options.previewPort,previewPort);
      assert.equal(plan.steps.find(step=>step.kind==="preview-smoke").timeoutSeconds,timeoutSeconds);
    }
  }
  const defaults=buildWorkflowPlan({recipeId:"qa-and-preview",scripts});
  assert.deepEqual(defaults.options,{timeoutSeconds:300,previewPort:null,previewPath:"/"});
  assert.equal(defaults.steps.find(step=>step.kind==="preview-smoke").port,null);
});

test("workflow preview adapter admits preview script or exact Next start; generated plan is data only", () => {
  const alternatives=[
    {build:"next build",start:"next start",preview:"vite preview"},
    {build:"next build",start:"npm run next start"},
  ];
  const first=buildWorkflowPlan({recipeId:"qa-and-preview",scripts:alternatives[0]});
  const second=buildWorkflowPlan({recipeId:"qa-and-preview",scripts:alternatives[1]});
  assert.deepEqual(first.steps.map(step=>step.kind),[
    "git-clean","npm-script","preview-smoke","git-clean",
  ]);
  assert.equal(first.steps[2].adapter,"host-port","preview script has priority");
  assert.equal(second.steps[2].adapter,"next-start");
  for(const plan of [first,second]){
    assert.deepEqual(plan.steps.map(step=>step.id),[
      "git-clean-before","npm-build","preview-smoke","git-clean-after",
    ]);
    assert.equal(plan.steps[2].port,null);
    assert.equal(plan.steps[2].path,"/");
    assert.ok(plan.steps.every(step=>Object.isFrozen(step)));
  }
  assert.equal(Object.isFrozen(first.steps),false,"the original list remains a plain array");
  assert.equal(Object.isFrozen(first.recipe),false,"recipe metadata is copied, not exposed as a frozen singleton");
  const noPreview=listWorkflowRecipes({build:"next build",start:"echo next start fake"});
  assert.equal(noPreview.find(recipe=>recipe.id==="qa-and-preview").available,true,
    "preserve the legacy regex-based adapter detection, without executing scripts during planning");
});
