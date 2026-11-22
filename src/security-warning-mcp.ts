import { z } from "zod";
import { startLocalMcp, type LocalMcpServer } from "./local-mcp.js";
import { securityCategorySchema, type ReportSecurityWarning } from "./security-warning.js";

export type SecurityWarningMcpServer = LocalMcpServer;

/** Exposes one category-only MCP action on a private loopback endpoint owned by this runtime. */
export function startSecurityWarningMcp(report: ReportSecurityWarning): Promise<SecurityWarningMcpServer> {
  return startLocalMcp({
    name: "tmatrix-security-warning",
    tool: {
      name: "report_security_warning",
      description: "Send this task's owner an advisory warning about concrete malicious instructions. Accepts only the relevant category.",
      inputSchema: { type: "object", properties: { category: { type: "string", enum: securityCategorySchema.options } },
        required: ["category"], additionalProperties: false }
    },
    argumentsSchema: z.object({ category: securityCategorySchema }).strict(),
    call: async ({ category }) => {
      try { return await report(category); }
      catch { return { status: "unconfirmed" }; }
    },
    errors: {
      unavailable: "Warning action unavailable",
      shutdown: "Warning action shutdown failed",
      arguments: "Invalid warning action arguments"
    }
  });
}
