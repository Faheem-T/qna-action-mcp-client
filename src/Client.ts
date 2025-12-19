import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Content, Tool } from "@google/genai";
import { GoogleGenAI, Type } from "@google/genai";
import { inspect } from "bun";
import { PersonaSchema } from "./schemas/personaSchema";
import z from "zod";

export class MCPClient {
  private mcp: Client;
  private tools: Tool[] = [];
  private gemini: GoogleGenAI;
  private resources: Tool[] = [];
  private systemPrompt = "";

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
      uri: "file:///persona.json",
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

  private buildSystemPrompt = async () => {
    const {
      name: _name,
      system_prompt,
      max_response_tokens,
    } = await this.fetchPersona();

    const personaSection = `${system_prompt}
${max_response_tokens ? `Keep your responses under ${max_response_tokens} tokens.` : ""}
`;

    const answeringSection = `
Furthermore, you are a knowledge-grounded assistant.

You must answer user questions ONLY using information retrieved from the internal knowledge base.

Mandatory workflow:
1. For every user query that requires factual information, you MUST first call the \`search_knowledge\` tool.
2. The \`search_knowledge\` tool returns a list of relevant documents, each identified by a \`filename\`.
3. You MUST select one or more filenames directly from the search results.
4. Retrieve the full contents of each selected document by calling the \`knowledge_resource_get\` resource using the URI format:
   \`file://{filename}/\`
5. Read the retrieved document content.
6. Generate your final answer strictly and exclusively from the retrieved document text.

Hard constraints:
- Do NOT answer from general knowledge, prior training data, or assumptions.
- Do NOT invent, guess, or infer information that is not explicitly present in the retrieved documents.
- Do NOT invent filenames or resource identifiers.
- If the knowledge base does not contain sufficient information to answer the question, respond exactly with:
  "The knowledge base does not contain enough information to answer this question."

Citation behavior:
- When possible, reference the document filename(s) used to answer the question.
- Do not fabricate citations or sources.

Tool and resource usage rules:
- \`search_knowledge\` is the ONLY allowed way to locate documents.
- The \`knowledge_resource_get\` resource is the ONLY allowed way to read document contents.
- You must not answer any factual question unless at least one \`knowledge_resource_get\` resource has been read.

Failure to follow any of these rules is considered an incorrect response.
`;

    this.systemPrompt = [personaSection, answeringSection].join("\n\n");
  };

  processQuery = async (query: string) => {
    try {
      const contents: Content[] = [{ parts: [{ text: query }], role: "user" }];

      let response = await this.gemini.models.generateContent({
        model: this.model,
        contents,
        config: {
          tools: [...this.tools, ...this.resources],
          systemInstruction: this.systemPrompt,
        },
      });

      // console.log(inspect(response));

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
            finalText.push(
              `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
            );
            // TODO: Handle get prompt
            resultContent = "Get prompt request";
          } else {
            finalText.push(
              `[Calling tool ${name} with args ${JSON.stringify(args)}]`,
            );
            const result = await this.mcp.callTool({
              name: name,
              arguments: args,
            });

            resultContent =
              (result.content as { text: string }[])[0]?.text ||
              JSON.stringify(result.structuredContent);
          }

          contents.push({
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
            contents,
            config: {
              systemInstruction: this.systemPrompt,
              tools: [...this.tools, ...this.resources],
            },
          });

          // console.log(inspect(response));

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
