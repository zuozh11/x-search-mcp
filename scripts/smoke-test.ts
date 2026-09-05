import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.error("XAI_API_KEY is required for smoke test");
  process.exit(1);
}

const serverPath = path.resolve(process.cwd(), "dist/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: Object.fromEntries(
    ["XAI_API_KEY", "XAI_BASE_URL", "XAI_MODEL", "XAI_TIMEOUT"]
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]])
  ),
});

const client = new Client({ name: "x-search-smoke", version: "0.0.1" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name));

  const result = await client.callTool({
    name: "x_search",
    arguments: {
      query: "Summarize the latest post from @xai in one sentence.",
      allowed_x_handles: ["xai"],
    },
  }, undefined, { timeout: Number.parseInt(process.env.XAI_TIMEOUT ?? "30000", 10) + 5000 });

  const content = result.content?.[0]?.text ?? "";
  console.log("tool result:", content);
  if (result.isError) throw new Error("x_search returned an MCP error");
  const payload = result.structuredContent as { status?: string; search_performed?: boolean } | undefined;
  if (payload?.status !== "completed" || payload.search_performed !== true) {
    throw new Error("X search execution was not verified");
  }
} catch (error) {
  console.error("smoke test failed", error);
  process.exitCode = 1;
} finally {
  await client.close();
}
