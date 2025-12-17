import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Content, Part, SendMessageParameters, Tool } from "@google/genai";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { inspect } from "bun";

export class MCPClient {
  private mcp: Client;
  private tools: Tool[] = [];
  private gemini: GoogleGenAI;

  constructor(private model: string = "gemini-robotics-er-1.5-preview") {
    this.mcp = new Client({ name: "qna-client-cli", version: "1.0.0" });
    this.gemini = new GoogleGenAI({});
  }

  connectToServer = async (serverUrl: string) => {
    // console.log(await this.gemini.models.list());
    try {
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      await this.mcp.connect(transport);
      const toolsResult = await this.mcp.listTools();

      this.tools = toolsResult.tools.map((tool) => {
        return {
          functionDeclarations: [
            {
              name: tool.name,
              description: tool.description,
              parameters: Object.fromEntries(
                Object.entries(tool.inputSchema).filter(
                  ([key]) =>
                    key !== "additionalProperties" && key !== "$schema",
                ),
              ),
            },
          ],
        };
      });

      console.log("Connected to server.");
      // console.log(inspect(this.tools));
    } catch (e) {
      console.error("Failed to connect to MCP Server", e);
    }
  };

  processQuery = async (query: string) => {
    try {
      const contents: Content[] = [{ parts: [{ text: query }], role: "user" }];

      const response = await this.gemini.models.generateContent({
        model: this.model,
        contents,
        config: {
          tools: this.tools,
          // toolConfig: {
          //   functionCallingConfig: {
          //     mode: FunctionCallingConfigMode.ANY,
          //   },
          // },
        },
      });

      const functionCalls = response.functionCalls;

      // console.log("--- Response ---\n", response);
      // console.log("--- Response Text ---\n", response.text);
      // console.log("--- Response Data ---\n", response.data);
      // console.log("--- Response Function Calls ---\n", functionCalls);

      const tempWarn = console.warn;
      console.warn = () => {};
      const finalText = [response.text];
      console.warn = tempWarn;

      if (functionCalls && functionCalls.length > 0) {
        for (const { name, args, id } of functionCalls) {
          const result = await this.mcp.callTool({
            name: name!,
            arguments: args,
          });
          finalText.push(
            `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
          );

          contents.push({
            parts: [
              {
                functionResponse: {
                  name,
                  id,
                  response: { result: result.content as string },
                },
              },
            ],
          });

          const response = await this.gemini.models.generateContent({
            model: this.model,
            contents,
          });

          const tempWarn = console.warn;
          console.warn = () => {};
          finalText.push(response.text);
          console.warn = tempWarn;
        }
      }

      return finalText.join("\n");
    } catch (err) {
      console.error("Error when processing query\n", err);
    }
  };

  chatLoop = async () => {
    console.log("\nMCP Client Started!");
    const prompt = "\nYou: ";
    process.stdout.write(prompt);
    for await (const message of console) {
      if (message.toLowerCase() === "quit") {
        break;
      }
      const response = await this.processQuery(message);
      console.log("\n" + "LLM: " + response);
      process.stdout.write(prompt);
    }
  };

  async cleanup() {
    await this.mcp.close();
  }
}
