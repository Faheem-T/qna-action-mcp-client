import type { IntentRecognitionAgent } from "./IntentRecognitionAgent";
import type { MainAgent } from "./MainAgent";

export class Orchestrator {
  private _intent: undefined | string;
  constructor(
    private _intentRecognitionAgent: IntentRecognitionAgent,
    private _mainAgent: MainAgent,
  ) {}

  handleQuery = async (query: string) => {
    if (!this._intent) {
      const response = await this._intentRecognitionAgent.processQuery(query);
      if (response.type === "intent_classification") {
        console.log("Intent found!");
        console.log("Response: ", response);
        this._intent = response.recognized_intent;
      } else {
        return response.content;
      }
    }
  };

  connectToServer = async () => {
    await this._intentRecognitionAgent.setupAgent();
  };
}
