import { Type, type Content, type GoogleGenAI, type Tool } from "@google/genai";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { ResourceURI } from "../constants/ResourceURI";
import { intentResourceSchema } from "../schemas/intentsSchema";
import z from "zod";
import { mainAgentPrompt } from "../prompts/mainAgentPrompt";
import { PersonaSchema } from "../schemas/personaSchema";
import { EventEmitter } from "node:events";

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

  processQuery = async (query: string): Promise<MainAgentResponseType> => {
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

      const finalText = [];
      if (response.text) {
        finalText.push(response.text);
        this._history.push({
          parts: [{ text: response.text }],
          role: "model",
        });
      }

      while (response.functionCalls && response.functionCalls.length > 0) {
        for (const { name, args, id } of response.functionCalls) {
          if (!name) {
            throw new Error("No name for function call");
          }
          if (!args) {
            throw new Error("No args for function call");
          }

          let resultContent: string;

          // figure out if tool, resource, or prompt call
          if (name.trim() === "get_knowledge_base_document") {
            this.emit("fetching document", args.uri);
            this._history.push({
              parts: [
                { text: `[Getting resource ${name}. URI: ${args.uri!}]` },
              ],
              role: "model",
            });

            const result = await this._mcp.readResource({
              uri: args.uri! as string,
            });

            resultContent = result.contents
              .map((content) => {
                if (content && "text" in content) {
                  return `${content.uri}\n${content.text}`;
                } else {
                  console.warn(`No content in ${content.uri}`);
                  return "";
                }
              })
              .join("\n\n");
          } else if (name === "get_prompt") {
            resultContent = "Getting prompt";
            console.log("get prompt request");
          } else {
            this.emit("calling tool", name, JSON.stringify(args));
            this._history.push({
              parts: [
                {
                  text: `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
                },
              ],
              role: "model",
            });
            const result = await this._mcp.callTool({
              name: name,
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

          response = await this._ai.models.generateContent({
            model: this.model,
            contents: this._history,
            config: {
              tools: [...this._tools, ...this._resources],
              systemInstruction: this._systemPrompt,
            },
          });

          if (response.text) {
            finalText.push(response.text);
            this._history.push({
              parts: [{ text: response.text }],
              role: "model",
            });
          }
        }
      }

      const result = mainAgentResponseSchema.safeParse(
        JSON.parse(finalText.join("\n\n").trim()),
      );

      if (!result.success) {
        console.error(
          "Error when parsing main agent response",
          z.treeifyError(result.error),
        );
        return { type: "error", message: "Something unexpected happened" };
      }
      return result.data;
    } catch (err) {
      console.error("Error when processing query\n", err);
      return { type: "error", message: "Something unexpected happened" };
    }
  };

  setSystemPrompt = async (intentName: string) => {
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
    this._resources.push({
      functionDeclarations: [
        {
          name: "get_knowledge_base_document",
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
    });
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
