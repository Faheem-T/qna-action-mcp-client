import { MCPClient } from "./Client";

const MCP_SERVER_URL = "http://localhost:3000/mcp";

async function main() {
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(MCP_SERVER_URL);
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
