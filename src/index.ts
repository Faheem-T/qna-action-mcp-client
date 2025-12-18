import { MCPClient } from "./Client";

const MCP_SERVER_URL = "http://localhost:3000/mcp";

// Can you search the knowledge base (using the mcp tool) for data on pet insurance?

async function main() {
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(MCP_SERVER_URL);

    console.log("System prompt:");

    await mcpClient.chatLoop();
  } catch (e) {
    console.error("Error:", e);
    await mcpClient.cleanup();
    process.exit(1);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
