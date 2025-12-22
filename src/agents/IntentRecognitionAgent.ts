import { Client } from "@modelcontextprotocol/sdk/client";
import { ResourceURI } from "../constants/ResourceURI";
import { GoogleGenAI, type Content } from "@google/genai";
import { intentRecognitionAgentPrompt } from "../prompts/intentRecognitionAgentPrompt";
import { intentResourceSchema } from "../schemas/intentsSchema";
import z from "zod";

const intentAgentResponseSchema = z.union([
  // First branch: clarifying_question
  z.object({
    type: z.literal("clarifying_question"),
    content: z.string(),
  }),

  // Second branch: intent_classification - ambiguous
  z.object({
    type: z.literal("intent_classification"),
    recognized_intent: z.literal("ambiguous"),
  }),

  // Third branch: intent_classification - recognized intent with user_query
  z
    .object({
      type: z.literal("intent_classification"),
      recognized_intent: z.string(),
      user_query: z.string(),
    })
    .refine((data) => data.recognized_intent !== "ambiguous", {
      message:
        'recognized_intent cannot be "ambiguous" when user_query is present',
      path: ["recognized_intent"],
    }),
]);

// Type inference
type IntentAgentResponseType = z.infer<typeof intentAgentResponseSchema>;

export class IntentRecognitionAgent {
  private _intentAgentHistory: Content[] = [];
  private _intents: { name: string; description: string }[] = [];
  private _systemPrompt: string | undefined;

  constructor(
    private _mcp: Client,
    private _ai: GoogleGenAI,
    private model: string = "gemini-2.5-flash",
  ) {}

  setupAgent = async () => {
    await this.registerIntents();
    console.log("[Intent Agent] Intents registered.");

    this.registerSystemPrompt();
    console.log("[Intent Agent] System prompt registered.");

    console.log("[Intent Agent] Setup complete!");
  };

  processQuery = async (query: string): Promise<IntentAgentResponseType> => {
    this._intentAgentHistory.push({ parts: [{ text: query }], role: "user" });

    let response = await this._ai.models.generateContent({
      model: this.model,
      contents: this._intentAgentHistory,
      config: {
        systemInstruction: this._systemPrompt,
        responseMimeType: "application/json",
      },
    });
    // console.log(inspect(response));

    this._intentAgentHistory.push({
      parts: [{ text: response.text }],
      role: "model",
    });

    console.log("Response", response.text);

    const jsonResponse = intentAgentResponseSchema.safeParse(
      JSON.parse(response.text ?? ""),
    );

    if (!jsonResponse.success) {
      console.error(z.treeifyError(jsonResponse.error));
      throw new Error(
        `Unexpected intent agent resopnse: ${response.text ?? "No response text"}`,
      );
    }

    return jsonResponse.data;
  };

  private registerIntents = async () => {
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
      }),
    );
  };

  private registerSystemPrompt = () => {
    this._systemPrompt = intentRecognitionAgentPrompt(this._intents);
  };
}
