import type { IntentRecognitionAgent } from "./IntentRecognitionAgent";
import type { MainAgent } from "./MainAgent";
import { EventEmitter } from "node:events";

export class Orchestrator extends EventEmitter {
  private _intent: undefined | string;
  constructor(
    private _intentRecognitionAgent: IntentRecognitionAgent,
    private _mainAgent: MainAgent,
  ) {
    super();
    this._mainAgent.on("fetching document", (...args) => {
      this.emit("fetching document", ...args);
    });
    this._mainAgent.on("calling tool", (...args) => {
      this.emit("calling tool", ...args);
    });
  }

  handleQuery = async (query: string) => {
    if (!this._intent) {
      return this._intentRecognitionAgentHandleQuery(query);
    } else {
      return this._mainAgentHandleQuery(query);
    }
  };

  private _mainAgentHandleQuery = async (query: string): Promise<string> => {
    const response = await this._mainAgent.processQuery(query);
    if (response.type === "response") {
      return response.content;
    } else if (response.type === "intent_shift_detected") {
      console.warn(
        "Intent shift detected, forwarding control to intent recognition agent.",
      );
      this._intent = undefined;
      return this._intentRecognitionAgentHandleQuery(query);
    } else {
      return response.message;
    }
  };

  private _intentRecognitionAgentHandleQuery = async (
    query: string,
  ): Promise<string> => {
    const response = await this._intentRecognitionAgent.processQuery(query);
    if (response.type === "intent_classification") {
      console.log("Intent found!");
      console.log("Response: ", response);
      this._intent = response.recognized_intent;
      if (response.recognized_intent !== "ambiguous") {
        await this._mainAgent.setSystemPrompt(this._intent);
        return this._mainAgentHandleQuery((response as any).user_query);
      } else {
        // TODO: Handle ambiguous intent
        return "ambiguous event";
      }
    } else {
      return response.content;
    }
  };
}
