export function registerPrivateVisualTools() {
  return null;
}

export function createPrivateReleaseGateRuntime() {
  return null;
}

export function privateWorkflowStepExecutor() {
  return null;
}

export async function registerPrivateReleaseGateTools() {
  return null;
}

export function registerPrivateSecureServiceTools() {
  return null;
}

export async function privateReleaseGateSnapshot() {
  return {};
}

export async function privateGitHubStatus({
  context,
  projectContextStorage,
  runGhWithCode,
}) {
  const result = await projectContextStorage.run(
    context,
    () => runGhWithCode(["api", "user", "--jq", ".login"], "", 15_000),
  ).catch(() => null);
  const rawAccount = result?.code === 0 ? String(result.stdout ?? "").trim() : "";
  const account = /^[A-Za-z0-9-]{1,39}$/u.test(rawAccount) ? rawAccount : null;
  return { ready: Boolean(account), account };
}
