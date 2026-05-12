import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConfirmSpec } from "./tools.js";

const AUTO_CONFIRM = process.env.OBSIDIAN_MCP_AUTO_CONFIRM === "1";

export interface ConfirmOutcome {
  ok: boolean;
  reason?: string;
}

export async function ensureConfirmed(
  server: McpServer,
  spec: ConfirmSpec,
  input: any,
): Promise<ConfirmOutcome> {
  if (AUTO_CONFIRM) return { ok: true };
  if (input?.confirm === true) return { ok: true };

  const action = spec.action(input);
  const detail = spec.detail(input);
  const summary = `${action}\n${detail}`;

  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) {
    return {
      ok: false,
      reason:
        `User confirmation required. The MCP client does not support interactive elicitation.\n\n` +
        `Action: ${action}\nTarget: ${detail}\n\n` +
        `If the user has approved this, re-invoke the tool with \`confirm: true\`.`,
    };
  }

  try {
    const result = await server.server.elicitInput({
      message: `${summary}\n\nProceed?`,
      requestedSchema: {
        type: "object",
        properties: {},
      },
    });

    if (result.action === "accept") return { ok: true };
    if (result.action === "decline") {
      return { ok: false, reason: "User declined the operation." };
    }
    return { ok: false, reason: "User cancelled the operation." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason:
        `Failed to obtain confirmation: ${msg}\n` +
        `Re-invoke with \`confirm: true\` to bypass interactive confirmation.`,
    };
  }
}
