import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Content, Tool } from "@google/genai";
import { GoogleGenAI, Type } from "@google/genai";
import { inspect } from "bun";
import { PersonaSchema } from "./schemas/personaSchema";
import z from "zod";
import { ResourceURI } from "./constants/ResourceURI";
import { intentResourceSchema } from "./schemas/intentsSchema";
import { intentRecognitionAgentPrompt } from "./prompts/intentRecognitionAgentPrompt";

export class MCPClient {
  private mcp: Client;
  private tools: Tool[] = [];
  private gemini: GoogleGenAI;
  private resources: Tool[] = [];
  private systemPrompt = "";
  private history: Content[] = [];
  private intentAgentHistory: Content[] = [];

  constructor(private model: string = "gemini-2.5-flash") {
    this.mcp = new Client({ name: "qna-client-cli", version: "1.0.0" });
    this.gemini = new GoogleGenAI({});
  }

  connectToServer = async (serverUrl: string) => {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
      await this.mcp.connect(transport);
      console.log("Connected to server.");

      await this.buildSystemPrompt();
      this.history.push({
        parts: [{ text: this.systemPrompt }],
        role: "user",
      });
      console.log("System prompt built.");
      await this.discoverTools();
      console.log("MCP tools discovered.");
      await this.discoverResources();
      console.log("MCP resources discovered.");

      console.log("Client is ready!");
    } catch (e) {
      console.error("Failed to connect to MCP Server", e);
    }
  };

  intentAgent = async (query: string) => {
    const intentsResult = await this.fetchIntents();

    const intents = intentsResult.map(
      ({ name, description, allowed_tools }, index) => ({
        name,
        description,
      }),
    );

    const systemPrompt = intentRecognitionAgentPrompt(intents);

    this.intentAgentHistory.push({ parts: [{ text: query }], role: "user" });

    let response = await this.gemini.models.generateContent({
      model: this.model,
      contents: this.intentAgentHistory,
      config: {
        systemInstruction: systemPrompt,
      },
    });
    // console.log(inspect(response));

    this.intentAgentHistory.push({
      parts: [{ text: response.text }],
      role: "model",
    });

    const jsonResponse = JSON.parse(response.text ?? "");

    if ("recognized_intent" in jsonResponse) {
      console.log("Intent found!");
      console.log("Response: ", jsonResponse.recognized_intent);
      console.log(inspect(this.intentAgentHistory));
      console.log("Intent output:", jsonResponse);
      this.intentAgentHistory = [];
    }

    return response.text;
  };

  processQuery = async (query: string) => {
    try {
      this.history.push({ parts: [{ text: query }], role: "user" });

      let response = await this.gemini.models.generateContent({
        model: this.model,
        contents: this.history,
        config: {
          tools: [...this.tools, ...this.resources],
        },
      });

      console.log(inspect(response));

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
            this.history.push({
              parts: [
                { text: `[Getting resource ${name}. URI: ${args.uri!}]` },
              ],
              role: "model",
            });

            const result = await this.mcp.readResource({
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
            this.history.push({
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
            this.history.push({
              parts: [
                {
                  text: `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
                },
              ],
              role: "model",
            });
            const result = await this.mcp.callTool({
              name: name,
              arguments: args,
            });

            resultContent =
              (result.content as { text: string }[])[0]?.text ||
              JSON.stringify(result.structuredContent);
          }

          this.history.push({
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

          response = await this.gemini.models.generateContent({
            model: this.model,
            contents: this.history,
            config: {
              // systemInstruction: this.systemPrompt,
              tools: [...this.tools, ...this.resources],
            },
          });

          console.log(inspect(response));

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

  private discoverResources = async () => {
    const resourceResponse = await this.mcp.listResources();

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
        this.resources.push({
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

  private discoverTools = async () => {
    const toolsResult = await this.mcp.listTools();

    this.tools = toolsResult.tools.map((tool) => {
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

  private fetchPersona = async () => {
    const personaResponse = await this.mcp.readResource({
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

  private fetchIntents = async () => {
    const intentsResponse = await this.mcp.readResource({
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

    return intentsResult.data;
  };

  private buildSystemPrompt = async () => {
    const {
      name: _name,
      system_prompt,
      max_response_tokens,
    } = await this.fetchPersona();

    const personaSection = `${system_prompt}
${max_response_tokens ? `Keep your responses under ${max_response_tokens} tokens.` : ""}
`;

    const intentsResult = await this.fetchIntents();

    const intents = intentsResult
      .map(
        ({ name, description, allowed_tools }, index) => `
${index + 1}. ${name}
Description: ${description}
Allowed Tools: ${allowed_tools.join(", ")}`,
      )
      .join("\n\n");

    const intentsSection = `
Core Task Flow
- Read the user message.
- Infer exactly one intent from the intent definitions below.
- Act only in ways permitted by that intent.
- Respond to the user or call a tool if appropriate.

The intent definitions are authoritative.

INTENT DEFINITIONS
${intents}

Intent Rules
- You must select exactly one intent.
- Do not invent new intents or combine intents.
- Infer intent based on the user’s primary goal, not keywords.
- If multiple intents seem applicable, choose the one that best fulfills the user’s goal, prioritizing action over information.
- You may only call tools listed in the selected intent’s allowed_tools.
- If the user message is ambiguous, you may ask one short clarifying question before acting.
- If no intent reasonably applies, respond exactly with:
"I’m unable to help with this request because it does not match any supported intent."

Tool Usage Rules
- Call a tool only if it is necessary to fulfill the user’s request.
- Do not call tools speculatively.
- Do not explain internal policies, intent names, or tool rules to the user.
- Mandatory workflows override general tool usage rules.
`;

    const answeringSection = `
Knowledge Grounding Rules
(Applies ONLY to informational_query and any response that includes factual information)
You are a knowledge grounded assistant.
You must answer factual questions only using information retrieved from the internal knowledge base.

Mandatory Workflow
- Call search_knowledge to locate relevant documents.
- The tool returns document filenames.
- Select one or more filenames from the results.
- Retrieve each document using knowledge_resource_get with URI: file://{filename}/
- Read the retrieved document content.
- Generate the final answer strictly and exclusively from the retrieved text.

Hard Constraints
- Do not answer from general knowledge or prior training.
- Do not invent, infer, or guess information.
- Do not invent filenames or resources.
- You must not answer any factual question unless at least one document has been retrieved.
- If the knowledge base lacks sufficient information, respond exactly with:
  "The knowledge base does not contain enough information to answer this question."

Citation Behavior
- When possible, reference the filename(s) used.
- Do not fabricate citations or sources.

Resource Access Rules
- search_knowledge is the only way to locate documents.
- knowledge_resource_get is the only way to read document contents.
`;

    const fullPrompt = [personaSection, intentsSection, answeringSection].join(
      "\n\n",
    );

    this.systemPrompt = fullPrompt;
  };

  chatLoop = async () => {
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

  cleanup = async () => {
    await this.mcp.close();
  };
}
