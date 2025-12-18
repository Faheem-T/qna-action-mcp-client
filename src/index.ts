import { MCPClient } from "./Client";
import { MCP_SERVER_URL } from "./utils/loadEnv";

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
