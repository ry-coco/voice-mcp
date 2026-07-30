/**
 * Stub for the optional `ai` (Vercel AI SDK) dependency.
 *
 * The `agents` package references `ai` via a dynamic `import("ai")` inside its
 * MCP *client* code path (mcp/client.js). This worker only uses the MCP *server*
 * (createMcpHandler), so that import never executes at runtime — it only needs
 * to resolve at bundle time. This stub is aliased in for `ai` via wrangler.jsonc.
 */
export function jsonSchema(schema) {
  return schema;
}
