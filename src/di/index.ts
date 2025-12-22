import { Client } from "@modelcontextprotocol/sdk/client";
import { IntentRecognitionAgent } from "../agents/IntentRecognitionAgent";
import { MainAgent } from "../agents/MainAgent";
import { Orchestrator } from "../agents/Orchestrator";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_SERVER_URL } from "../utils/loadEnv";
import { GoogleGenAI } from "@google/genai";

const mcp = new Client({ name: "qna-client-cli", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL));
await mcp.connect(transport);

const gemini = new GoogleGenAI({});

const intentRecognitionAgent = new IntentRecognitionAgent(mcp, gemini);
await intentRecognitionAgent.setupAgent();

const mainAgent = new MainAgent(mcp, gemini);
await mainAgent.setupAgent();

export const orchestrator = new Orchestrator(intentRecognitionAgent, mainAgent);
