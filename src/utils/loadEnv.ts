if (!process.env.MCP_SERVER_URL) {
  throw new Error("MCP_SERVER_URL not found!");
}

export const MCP_SERVER_URL = process.env.MCP_SERVER_URL;
