import type * as zod from "zod/v4";

type ProfileMetadata = {id: string; [key: string]: unknown};
type ProfilesResponse = {
  agentProfileManagementEnabled: boolean;
  profiles: readonly ProfileMetadata[];
};
type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type BearerAuth = {type: "bearer"};
type HeaderAuth = {type: "secret_header"; header_name: string};
type ProfileInput = {
  id: string;
  label: string;
  origin: string;
  base_path: string;
  auth: BearerAuth | HeaderAuth;
  allowed_methods: RequestMethod[];
  allowed_path_prefixes: string[];
  allowed_agent_headers: string[];
  timeout_ms: number;
};
type RequestBinding = {
  target_json_pointer: string;
  response_id: string;
  source_json_pointer: string;
};
type RequestInput = {
  profile_id: string;
  method: RequestMethod;
  path: string;
  query: Record<string, string | number | boolean>;
  headers: Record<string, string>;
  body?: unknown;
  response_bindings?: RequestBinding[];
  timeout_ms?: number;
};
type ProfileUpsertInput = ProfileInput;
type DeleteInput = {profile_id: string};
type ProfileListInput = {profile_id?: string};
type ToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};
type ToolOptions = {
  projectAware: false;
  mutationScopes: [] | ["global"];
  capabilityDomain: "integrations";
};
type RegisterTextTool = {
  (name: "http_profiles", definition: ToolDefinition, handler: (input: ProfileListInput) => Promise<unknown>, options: ToolOptions): unknown;
  (name: "http_profile_upsert", definition: ToolDefinition, handler: (input: ProfileUpsertInput) => Promise<unknown>, options: ToolOptions): unknown;
  (name: "http_profile_delete", definition: ToolDefinition, handler: (input: DeleteInput) => Promise<unknown>, options: ToolOptions): unknown;
  (name: "authenticated_http_request", definition: ToolDefinition, handler: (input: RequestInput) => Promise<unknown>, options: ToolOptions): unknown;
};
type EngineBindings = {
  getProfiles: () => Promise<ProfilesResponse>;
  upsertProfile: (input: {profile: ProfileInput}) => Promise<unknown>;
  deleteProfile: (input: {profileId: string; requireAgentManagement: true}) => Promise<unknown>;
  request: (input: {
    profileId: string;
    method: RequestMethod;
    path: string;
    query: Record<string, string | number | boolean>;
    headers: Record<string, string>;
    body?: unknown;
    response_bindings?: RequestBinding[] | undefined;
    timeout_ms?: number | undefined;
  }) => Promise<{responseId?: string; [key: string]: unknown}>;
};
type RegistrationOptions = Partial<EngineBindings> & {
  registerTextTool: RegisterTextTool;
  z: typeof zod;
  textResult: (text: string) => unknown;
  errorResult: (error: unknown) => unknown;
};

import { AUTHENTICATED_HTTP_LIMITS, authenticatedHttpRequest, deleteAuthenticatedHttpProfile, getAuthenticatedHttpProfiles, upsertAuthenticatedHttpProfileFromAgent } from "./authenticated-http-integration.js";

const PROFILE_ID = /^[a-z][a-z0-9._-]{0,63}$/u;

function jsonResult(textResult: (text: string) => unknown, value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

export function registerAuthenticatedHttpTools({
  registerTextTool,
  z,
  textResult,
  errorResult,
  getProfiles = getAuthenticatedHttpProfiles,
  upsertProfile = upsertAuthenticatedHttpProfileFromAgent,
  deleteProfile = deleteAuthenticatedHttpProfile,
  request = authenticatedHttpRequest,
}: RegistrationOptions = {} as RegistrationOptions) {
  if (
    typeof registerTextTool !== "function" ||
    !z ||
    typeof textResult !== "function" ||
    typeof errorResult !== "function"
  ) {
    throw new Error("Authenticated HTTP tool registration dependencies are incomplete.");
  }

  const profileIdSchema = z.string().regex(PROFILE_ID).describe("Authenticated HTTP profile id");
  const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
  const authSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("bearer") }).strict(),
    z.object({
      type: z.literal("secret_header"),
      header_name: z.string().min(1).max(128),
    }).strict(),
  ]);

  registerTextTool(
    "http_profiles",
    {
      description:
        "Lists safe metadata for configured authenticated HTTP profiles. Secret credential values, credential paths and raw authentication material are never returned.",
      inputSchema: {
        profile_id: profileIdSchema.optional().describe("Optional exact profile id filter"),
      },
      annotations: {
        title: "List authenticated HTTP profiles",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profile_id }) => {
      try {
        const result = await getProfiles();
        const profiles = profile_id
          ? result.profiles.filter((profile) => profile.id === profile_id)
          : result.profiles;
        return jsonResult(textResult, {
          agentProfileManagementEnabled: result.agentProfileManagementEnabled,
          profiles,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: [],
      capabilityDomain: "integrations",
    },
  );

  registerTextTool(
    "http_profile_upsert",
    {
      description:
        "Creates or updates authenticated HTTP profile structure when agent management is enabled. This operation has no credential field; secrets remain human-only and write-only in Control Center. Trust-boundary changes clear any existing credential.",
      inputSchema: {
        id: profileIdSchema,
        label: z.string().min(1).max(100),
        origin: z.string().url().max(2048),
        base_path: z.string().min(1).max(AUTHENTICATED_HTTP_LIMITS.maxPathChars).default("/"),
        auth: authSchema,
        allowed_methods: z.array(methodSchema).min(1).max(5),
        allowed_path_prefixes: z.array(
          z.string().min(1).max(AUTHENTICATED_HTTP_LIMITS.maxPathChars),
        ).min(1).max(32).default(["/"]),
        allowed_agent_headers: z.array(z.string().min(1).max(128))
          .max(AUTHENTICATED_HTTP_LIMITS.maxAgentHeaders)
          .default([]),
        timeout_ms: z.number().int().min(1000).max(AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs)
          .default(AUTHENTICATED_HTTP_LIMITS.defaultTimeoutMs),
      },
      annotations: {
        title: "Create or update authenticated HTTP profile",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const result = await upsertProfile({ profile: input });
        return jsonResult(textResult, result);
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
      capabilityDomain: "integrations",
    },
  );

  registerTextTool(
    "http_profile_delete",
    {
      description:
        "Deletes one authenticated HTTP profile and its locally stored credential when agent profile management is enabled.",
      inputSchema: {
        profile_id: profileIdSchema,
      },
      annotations: {
        title: "Delete authenticated HTTP profile",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profile_id }) => {
      try {
        const result = await deleteProfile({
          profileId: profile_id,
          requireAgentManagement: true,
        });
        return jsonResult(textResult, result);
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
      capabilityDomain: "integrations",
    },
  );

  registerTextTool(
    "authenticated_http_request",
    {
      description:
        "Performs one bounded authenticated HTTP request through a ready profile. The request cannot supply a full URL or credential; Equinox Local validates method/path/query/header/body bounds and attaches the locally stored secret only after validation. Preferred multi-step chaining uses body-external response_bindings with an existing response_id plus source/target RFC 6901 JSON Pointers; the older inline $equinox_response_ref shape remains supported for compatibility.",
      inputSchema: {
        profile_id: profileIdSchema,
        method: methodSchema,
        path: z.string().min(1).max(AUTHENTICATED_HTTP_LIMITS.maxPathChars),
        query: z.record(
          z.string().min(1).max(128),
          z.union([z.string().max(4096), z.number().finite(), z.boolean()]),
        ).default({}),
        headers: z.record(
          z.string().min(1).max(128),
          z.string().max(AUTHENTICATED_HTTP_LIMITS.maxHeaderValueBytes),
        ).default({}),
        body: z.unknown().optional().describe("JSON/text body. Keep opaque response reuse out of this body when possible; use response_bindings."),
        response_bindings: z.array(z.object({
          target_json_pointer: z.string().min(1).max(2048),
          response_id: z.string().regex(/^http_resp_[a-f0-9]{32}$/u),
          source_json_pointer: z.string().max(2048),
        }).strict()).max(64).optional().describe("Body-external bindings that inject same-profile short-lived response strings into missing JSON object properties immediately before fetch."),
        timeout_ms: z.number().int().min(1000).max(AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs).optional(),
      },
      annotations: {
        title: "Authenticated HTTP request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ profile_id, method, path, query, headers, body, response_bindings, timeout_ms }) => {
      try {
        const result = await request({
          profileId: profile_id,
          method,
          path,
          query,
          headers,
          body,
          response_bindings,
          timeout_ms,
        });
        const { responseId, ...rest } = result;
        return jsonResult(textResult, {
          ...rest,
          ...(responseId ? { response_id: responseId } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
      capabilityDomain: "integrations",
    },
  );
}
