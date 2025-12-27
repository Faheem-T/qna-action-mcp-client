import { Type, type Content, type GoogleGenAI, type Tool } from "@google/genai";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { ResourceURI } from "../constants/ResourceURI";
import { intentResourceSchema } from "../schemas/intentsSchema";
import z from "zod";
import { mainAgentPrompt } from "../prompts/mainAgentPrompt";
import { PersonaSchema } from "../schemas/personaSchema";
import { EventEmitter } from "node:events";
import { MCP_RESOURCE_NAMES } from "../constants/MCPResourceNames";

const mainAgentResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("response"), content: z.string() }),
  z.object({ type: z.literal("intent_shift_detected"), reason: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

type MainAgentResponseType = z.infer<typeof mainAgentResponseSchema>;

export class MainAgent extends EventEmitter {
  private _intents: {
    name: string;
    description: string;
    allowed_tools: string[];
  }[] = [];
  private _history: Content[] = [];
  private _tools: Tool[] = [];
  private _resources: Tool[] = [];
  private _systemPrompt: string | undefined;
  private _currentIntent: string | undefined;

  constructor(
    private _mcp: Client,
    private _ai: GoogleGenAI,
    private model: string = "gemini-2.5-flash",
  ) {
    super();
  }

  setupAgent = async () => {
    await this._registerIntents();
    console.log("[Main Agent] Intents Registered");
    await this._registerTools();
    console.log("[Main Agent] Tools Registered");
    await this._registerResources();
    console.log("[Main Agent] Resources Registered");
    console.log("[Main Agent] Agent Setup Complete");
  };

  // NOTE: it would be a good idea to separate the content structuring responsibility
  // to another agent
  processQuery = async (query: string): Promise<MainAgentResponseType> => {
    const MAX_RETRIES = 3;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        this._history.push({ parts: [{ text: query }], role: "user" });

        let response = await this._ai.models.generateContent({
          model: this.model,
          contents: this._history,
          config: {
            tools: [...this._tools, ...this._resources],
            systemInstruction: this._systemPrompt,
          },
        });

        while (true) {
          // final response handling
          if (!response.functionCalls || response.functionCalls.length === 0) {
            if (!response.text) {
              throw new Error("Terminal response missing text");
            }

            let parsed;
            try {
              parsed = JSON.parse(response.text.trim());
            } catch {
              attempt++;
              console.error("Invalid json from model: ", response.text);
              this._history.push({
                role: "user",
                parts: [
                  {
                    text:
                      "Invalid response. Return ONLY valid JSON. " +
                      "No prose, no markdown, no explanation.",
                  },
                ],
              });
              break;
            }

            const result = mainAgentResponseSchema.safeParse(parsed);

            if (!result.success) {
              attempt++;
              console.error("Invalid json schema from model: ", parsed);
              this._history.push({
                role: "user",
                parts: [
                  {
                    text:
                      "The JSON does not match the required schema. " +
                      "Return ONLY valid JSON that conforms exactly.",
                  },
                ],
              });
              break;
            }

            this._history.push({
              parts: [{ text: response.text }],
              role: "model",
            });

            return result.data;
          }

          // tool call handling
          for (const { name, args, id } of response.functionCalls) {
            if (!name) throw new Error("No name for function call");
            if (!args) throw new Error("No args for function call");

            let resultContent: string;

            if (name.trim() === "get_knowledge_base_document") {
              this.emit("fetching document", args.uri);
              this._history.push({
                parts: [{ functionCall: { name, args } }],
                role: "model",
              });

              const result = await this._mcp.readResource({
                uri: args.uri! as string,
              });

              resultContent = result.contents
                .map((content) =>
                  content && "text" in content
                    ? `${content.uri}\n${content.text}`
                    : "",
                )
                .join("\n\n");
            } else if (name === "get_prompt") {
              resultContent = "Getting prompt";
            } else if (name.trim() === MCP_RESOURCE_NAMES.TICKET_SCHEMA) {
              const result = await this._mcp.readResource({
                uri: ResourceURI.TICKET_SCHEMA,
              });

              resultContent = (result.contents[0] as any).text ?? "No content";
            } else {
              this.emit("calling tool", name, JSON.stringify(args));
              this._history.push({
                parts: [{ functionCall: { name, args } }],
                role: "model",
              });

              const result = await this._mcp.callTool({
                name,
                arguments: args,
              });

              resultContent =
                (result.content as { text: string }[])[0]?.text ||
                JSON.stringify(result.structuredContent);
            }

            this._history.push({
              parts: [
                {
                  functionResponse: {
                    name,
                    id,
                    response: { result: resultContent },
                  },
                },
              ],
            });
          }

          response = await this._ai.models.generateContent({
            model: this.model,
            contents: this._history,
            config: {
              tools: [...this._tools, ...this._resources],
              systemInstruction: this._systemPrompt,
            },
          });
        }
      } catch (err) {
        console.error("Error when processing query\n", err);
        break; // 🔹 ADDED
      }
    }

    // 🔹 ADDED: deterministic failure
    return {
      type: "error",
      message: "Model failed to produce valid JSON after 3 attempts",
    };
  };

  setSystemPrompt = async (intentName: string) => {
    if (this._currentIntent && intentName.trim() !== this._currentIntent) {
      this._currentIntent = intentName.trim();
      this._history.push({
        parts: [
          {
            text: `New intent has been recognized as ${this._currentIntent}`,
          },
        ],
        role: "model",
      });
    }
    const { name, system_prompt, max_response_tokens } =
      await this._fetchPersona();

    // make sure valid intent
    const intent = this._intents.find(({ name }) => name === intentName.trim());
    if (!intent) {
      throw new Error(`Invalid intent ${intent}`);
    }

    this._systemPrompt = mainAgentPrompt(
      system_prompt,
      intent.name,
      intent.allowed_tools,
    );
  };

  private _fetchPersona = async () => {
    const personaResponse = await this._mcp.readResource({
      uri: ResourceURI.PERSONA,
    });

    // Cast to text content
    const textContent = personaResponse.contents[0] as { text: string };
    const content = textContent.text;
    const raw = JSON.parse(content);
    const personaResult = PersonaSchema.safeParse(raw);

    if (personaResult.error) {
      console.error(z.treeifyError(personaResult.error));
      throw new Error("Unexpected persona structure");
    }

    return personaResult.data;
  };

  private _registerIntents = async () => {
    const intentsResponse = await this._mcp.readResource({
      uri: ResourceURI.INTENTS,
    });

    const textContent = intentsResponse.contents[0] as { text: string };
    const content = textContent.text;
    const raw = JSON.parse(content);
    const intentsResult = intentResourceSchema.safeParse(raw);

    if (intentsResult.error) {
      console.error(z.treeifyError(intentsResult.error));
      throw new Error("Unexpected persona structure");
    }

    this._intents = intentsResult.data.map(
      ({ name, description, allowed_tools }, index) => ({
        name,
        description,
        allowed_tools,
      }),
    );
  };

  private _registerResources = async () => {
    this._resources.push(
      {
        functionDeclarations: [
          {
            name: MCP_RESOURCE_NAMES.KNOWLEDGE_BASE_DOCUMENT,
            parameters: {
              type: Type.OBJECT,
              properties: {
                uri: {
                  type: Type.STRING,
                  description:
                    "URI of the document to get in this format `file:///{filename}`",
                },
              },
              required: ["uri"],
            },
          },
        ],
      },
      {
        functionDeclarations: [
          { name: MCP_RESOURCE_NAMES.TICKET_SCHEMA, parameters: {} },
        ],
      },
    );
  };

  private _registerTools = async () => {
    const toolsResult = await this._mcp.listTools();

    this._tools = toolsResult.tools.map((tool) => {
      return {
        functionDeclarations: [
          {
            name: tool.name,
            description: tool.description,
            parameters: Object.fromEntries(
              Object.entries(tool.inputSchema).filter(
                ([key]) => key !== "additionalProperties" && key !== "$schema",
              ),
            ),
          },
        ],
      };
    });
  };
}
