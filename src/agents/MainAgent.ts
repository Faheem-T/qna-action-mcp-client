import { Type, type Content, type GoogleGenAI, type Tool } from "@google/genai";
import type { Client } from "@modelcontextprotocol/sdk/client";
import { ResourceURI } from "../constants/ResourceURI";
import { intentResourceSchema } from "../schemas/intentsSchema";
import z from "zod";
import { mainAgentPrompt } from "../prompts/mainAgentPrompt";
import { PersonaSchema } from "../schemas/personaSchema";

export class MainAgent {
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
  ) {}

  setupAgent = async () => {
    await this._registerIntents();
    console.log("[Main Agent] Intents Registered");
    await this._registerTools();
    console.log("[Main Agent] Tools Registered");
    await this._registerResources();
    console.log("[Main Agent] Resources Registered");
    console.log("[Main Agent] Agent Setup Complete");
  };

  processQuery = async (query: string) => {
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

      const tempWarn = console.warn;
      console.warn = () => {};
      const finalText = [response.text];
      console.warn = tempWarn;

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
          if (name.endsWith("resource_get")) {
            finalText.push(`[Getting resource ${name}. URI: ${args.uri!}]`);
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
                  return "";
                }
              })
              .join("\n\n");
          } else if (name === "get_prompt") {
            // TODO: Handle get prompt
            finalText.push(
              `[Getting prompt ${name} with args ${JSON.stringify(args)}]`,
            );
            this._history.push({
              parts: [
                {
                  text: `[Getting prompt ${name} with args ${JSON.stringify(args)}]`,
                },
              ],
              role: "model",
            });
            resultContent = "Get prompt request";
          } else {
            finalText.push(
              `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
            );
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

          const tempWarn = console.warn;
          console.warn = () => {};
          finalText.push(response.text);
          console.warn = tempWarn;
        }
      }

      return finalText.join("\n\n");
    } catch (err) {
      console.error("Error when processing query\n", err);
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
    const resourceResponse = await this._mcp.listResources();

    resourceResponse.resources.forEach(
      ({
        name,
        description,
        title,
        uri,
        mimeType,
        icons,
        annotations,
        _meta,
      }) => {
        this._resources.push({
          functionDeclarations: [
            {
              name: `${name}_resource_get`,
              description,
              parameters: {
                type: Type.OBJECT,
                description: "Get resource parameters",
                properties: {
                  uri: {
                    type: Type.STRING,
                    description: "URI of the resource to get",
                    enum: [uri],
                  },
                },
                required: ["uri"],
              },
            },
          ],
        });
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
