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
      const response = await this._intentRecognitionAgent.processQuery(query);
      if (response.type === "intent_classification") {
        console.log("Intent found!");
        console.log("Response: ", response);
        this._intent = response.recognized_intent;
        if (response.recognized_intent !== "ambiguous") {
          await this._mainAgent.setSystemPrompt(this._intent);
          return this._mainAgent.processQuery((response as any).user_query);
        }
      } else {
        return response.content;
      }
    }

    return this._mainAgent.processQuery(query);
  };

  connectToServer = async () => {
    await this._intentRecognitionAgent.setupAgent();
  };
}
