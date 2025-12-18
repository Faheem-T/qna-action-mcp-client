import { Text, Box, render } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useState } from "react";
import { MCPClient } from "./Client";
import Spinner from "ink-spinner";
import { MCP_SERVER_URL } from "./utils/loadEnv";

interface Message {
  type: "user" | "client";
  content: string;
}

const client = new MCPClient();

export const ChatLoop = () => {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [clientResponseLoading, setClientResponseLoading] = useState(false);

  useEffect(() => {
    client.connectToServer(MCP_SERVER_URL).then(() => {
      setLoading(false);
    });

    return () => {
      client.cleanup();
    };
  }, []);

  async function onSubmit(query: string) {
    setMessages([...messages, { type: "user", content: query }]);
    setInput("");
    setClientResponseLoading(true);
    const response = await client.processQuery(query);
    setMessages([...messages, { type: "client", content: response! }]);
    setClientResponseLoading(false);
  }

  if (loading) {
    return (
      <Text>
        <Text color="green">
          <Spinner type="simpleDotsScrolling" />
        </Text>
        {" Client Loading"}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {messages.map(({ type, content }) => {
        return (
          <Text color={type == "user" ? "white" : "magenta"}>{content}</Text>
        );
      })}
      <Box flexDirection="row">
        {clientResponseLoading ? (
          <Text>
            <Text color="green">
              <Spinner type="simpleDotsScrolling" />
            </Text>
            {" Loading response"}
          </Text>
        ) : (
          <>
            <Text>{"> "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(value) => {
                onSubmit(value);
              }}
            />
          </>
        )}
      </Box>
    </Box>
  );
};

render(<ChatLoop />);
