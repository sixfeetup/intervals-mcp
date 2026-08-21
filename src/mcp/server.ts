import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import { createRuntime } from "../domain/runtime.js";
import { createToolDescriptors } from "../tools/index.js";

const runtime = createRuntime();
const descriptors = createToolDescriptors(runtime);
const toolsByName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

const server = new Server(
  { name: "intervals", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: descriptors.map((descriptor) => ({
    name: descriptor.name,
    title: descriptor.title,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as { type: "object"; [key: string]: unknown },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const descriptor = toolsByName.get(request.params.name);
  if (!descriptor) {
    return errorResult(`unknown tool: ${request.params.name}`);
  }
  const params = request.params.arguments ?? {};
  if (!Value.Check(descriptor.inputSchema, params)) {
    // Value.Errors returns an array; its members carry instancePath/schemaPath/message
    // (there is no `path` property in typebox 1.x).
    const [first] = Value.Errors(descriptor.inputSchema, params);
    const detail = first ? `${first.instancePath} ${first.message}` : "arguments do not match the schema";
    return errorResult(`invalid arguments for ${descriptor.name}: ${detail}`);
  }
  try {
    const { text, details } = await descriptor.execute(params);
    return {
      content: [{ type: "text" as const, text }],
      structuredContent: details as Record<string, unknown>,
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

server.onclose = () => {
  runtime.close();
};

async function shutdown(): Promise<void> {
  try {
    await server.close();
  } finally {
    runtime.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// The SDK's stdio transport does not watch for stdin EOF; without this, a host that
// closes stdin without signaling strands the process (and its background-sync interval).
process.stdin.on("end", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
