import { Text, Box, render, useInput, useFocus, useStdin } from "ink";
import { useEffect, useState } from "react";
import { MCPClient } from "./Client";
import Spinner from "ink-spinner";
import { MCP_SERVER_URL } from "./utils/loadEnv";

interface Message {
  type: "user" | "client";
  content: string;
}

const client = new MCPClient();

const GradientTitle = () => (
  <Box
    borderStyle="double"
    borderColor="cyan"
    paddingX={2}
    paddingY={1}
    marginBottom={1}
    justifyContent="center"
  >
    <Text color="cyan" bold>
      🤖 QnA Action MCP Client
    </Text>
  </Box>
);

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
    if (!query.trim()) return;

    setMessages((prev) => [...prev, { type: "user", content: query }]);
    setInput("");
    setClientResponseLoading(true);

    try {
      const response = await client.processQuery(query);
      setMessages((prev) => [...prev, { type: "client", content: response! }]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { type: "client", content: "Error: Failed to get response." },
      ]);
    } finally {
      setClientResponseLoading(false);
    }
  }

  if (loading) {
    return (
      <Box
        height="100%"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Text color="green">
          <Spinner type="dots" /> Connecting to MCP Server...
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} height="100%">
      <GradientTitle />

      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {messages.map((msg, index) => (
          <Box
            key={index}
            flexDirection="column"
            alignSelf={msg.type === "user" ? "flex-end" : "flex-start"}
            marginBottom={1}
          >
            <Box
              borderStyle="round"
              borderColor={msg.type === "user" ? "green" : "blue"}
              paddingX={1}
              paddingY={0}
            >
              <Text color={msg.type === "user" ? "green" : "white"}>
                {msg.content}
              </Text>
            </Box>
            <Text color="gray" dimColor>
              {msg.type === "user" ? "You" : "Assistant"}
            </Text>
          </Box>
        ))}

        {clientResponseLoading && (
          <Box alignSelf="flex-start" marginBottom={1}>
            <Text color="yellow">
              <Spinner type="dots" /> Thinking...
            </Text>
          </Box>
        )}
      </Box>

      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green">{"> "}</Text>
        <TextInput label="input" />
      </Box>
    </Box>
  );
};

function TextInput({ label }: { label: string }) {
  const { isFocused } = useFocus({ autoFocus: true });
  const [value, setValue] = useState("");

  const { setRawMode, isRawModeSupported } = useStdin();

  useEffect(() => {
    if (!isRawModeSupported) {
      console.log("Raw mode not supported!");
      return;
    }
    console.log("Raw mode is supported");

    setRawMode(true);

    return () => {
      setRawMode(false);
    };
  }, [setRawMode, isRawModeSupported]);

  useInput((input, key) => {
    console.log(input, key);
    if (!isFocused) return;

    if (key.backspace) {
      setValue((v) => v.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box>
      <Text color={isFocused ? "cyan" : "white"}>
        {isFocused ? "> " : "  "}
        {label}: {value}
        {isFocused ? "█" : ""}
      </Text>
    </Box>
  );
}

render(<ChatLoop />);
