import { createCliRenderer, TextareaRenderable } from "@opentui/core";
import {
  createRoot,
  useTerminalDimensions,
  useKeyboard,
  useRenderer,
} from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { MCPClient } from "./Client";
import { MCP_SERVER_URL } from "./utils/loadEnv";

interface Message {
  type: "user" | "client";
  content: string;
  time: Date;
}

const client = new MCPClient("gemini-3-flash");

const MESSAGE_BOX_STYLES = {
  user: { borderColor: "#00FF00", textColor: "#FFFFFF", label: "You" },
  client: { borderColor: "#0000FF", textColor: "#FFFFFF", label: "Assistant" },
} as const;

const SPINNERS = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const GradientTitle = () => (
  <box width="100%" justifyContent="center" alignItems="center">
    <text>🤖 QnA Action MCP Client</text>
  </box>
);

export const ChatLoop = () => {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [clientResponseLoading, setClientResponseLoading] = useState(false);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const [focusedElement, setFocusedElement] = useState<"input" | "scrollbox">(
    "input",
  );

  useEffect(() => {
    client
      .connectToServer(MCP_SERVER_URL)
      .then(() => {
        setLoading(false);
        setConnectionError(null);
      })
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : "Connection failed";
        setConnectionError(errorMessage);
        setLoading(false);
      });

    return () => {
      client.cleanup();
    };
  }, []);

  useEffect(() => {
    if (!clientResponseLoading) return;

    const interval = setInterval(() => {
      setSpinnerIndex((prev) => (prev + 1) % SPINNERS.length);
    }, 80);

    return () => clearInterval(interval);
  }, [clientResponseLoading]);

  useKeyboard((key) => {
    if (key.name === "tab" || (key.ctrl && key.name === "n")) {
      setFocusedElement((prev) => (prev === "input" ? "scrollbox" : "input"));
    }

    if (key.name === "escape") {
      setFocusedElement("input");
    }

    if (key.ctrl && key.name === "l") {
      renderer.console.toggle();
    }
  });

  async function onSubmit(query: string) {
    if (!query.trim() || clientResponseLoading) return;

    setMessages((prev) => [
      ...prev,
      { type: "user", content: query, time: new Date() },
    ]);
    setClientResponseLoading(true);

    try {
      const response = await client.processQuery(query);
      setMessages((prev) => [
        ...prev,
        {
          type: "client",
          content: response || "No response received",
          time: new Date(),
        },
      ]);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to get response";
      setMessages((prev) => [
        ...prev,
        { type: "client", content: `Error: ${errorMessage}`, time: new Date() },
      ]);
    } finally {
      setClientResponseLoading(false);
    }
  }

  if (loading) {
    return (
      <box
        height="100%"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <text fg="#00FFFF">⠋ Connecting to MCP Server...</text>
      </box>
    );
  }

  if (connectionError) {
    return (
      <box
        height="100%"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        gap={2}
      >
        <text fg="#FF0000">
          <strong>❌ Connection Error</strong>
        </text>
        <text fg="#FF8888">{connectionError}</text>
        <text fg="#CCCCCC">Please check your MCP server connection.</text>
      </box>
    );
  }

  const messageMaxWidth = Math.floor(width * 0.6);
  const inputHeight = 4;

  return (
    <box flexDirection="column" height="100%">
      <GradientTitle />

      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text fg="#666666" style={{ height: 1 }}>
          Toggle Console: {"🖥Ctrl + l"}
        </text>
        <text fg="#666666" style={{ height: 1 }}>
          Focus:{" "}
          {focusedElement === "input"
            ? "📝 Input (Tab to scroll)"
            : "📜 Messages (Tab to input, Esc to return)"}
        </text>
      </box>

      {/* Scrollbox with ref for auto-scroll */}
      <scrollbox
        focused={focusedElement === "scrollbox"}
        style={{
          rootOptions: {
            flexGrow: 1,
            backgroundColor:
              focusedElement === "scrollbox" ? "#1a1a1a" : "transparent",
          },
          wrapperOptions: {
            backgroundColor:
              focusedElement === "scrollbox" ? "#1a1a1a" : "transparent",
          },
          viewportOptions: {
            backgroundColor:
              focusedElement === "scrollbox" ? "#1a1a1a" : "transparent",
          },
          contentOptions: {
            backgroundColor:
              focusedElement === "scrollbox" ? "#1a1a1a" : "transparent",
            flexDirection: "column",
            gap: 1,
            padding: 1,
          },
          scrollbarOptions: {
            showArrows: true,
            trackOptions: {
              foregroundColor:
                focusedElement === "scrollbox" ? "#7aa2f7" : "#4A90E2",
              backgroundColor: "#1a1a1a",
            },
          },
        }}
      >
        {messages.map((msg, index) => (
          <box
            key={index}
            flexDirection="column"
            alignSelf={msg.type === "user" ? "flex-end" : "flex-start"}
            style={{
              maxWidth: messageMaxWidth,
            }}
          >
            <box padding={1}>
              <text fg={MESSAGE_BOX_STYLES[msg.type].textColor}>
                {msg.content}
              </text>
            </box>
            <text fg="#808080">
              {MESSAGE_BOX_STYLES[msg.type].label}
              {" · "}
              {msg.time.toLocaleTimeString()}
            </text>
          </box>
        ))}

        {clientResponseLoading && (
          <box alignSelf="flex-start">
            <text fg="#FFFF00">{SPINNERS[spinnerIndex]} Thinking...</text>
          </box>
        )}
      </scrollbox>

      {/* Input area */}
      <box height={inputHeight} width="100%" backgroundColor="#1A1A1A">
        <TextInput
          onSubmit={onSubmit}
          disabled={clientResponseLoading}
          focused={focusedElement === "input"}
        />
      </box>
    </box>
  );
};

interface TextInputProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  focused?: boolean;
}

function TextInput({
  onSubmit,
  disabled = false,
  focused = true,
}: TextInputProps) {
  const textareaRef = useRef<TextareaRenderable>(null);

  useKeyboard((key) => {
    if (key.name === "return") {
      if (!textareaRef.current) return;
      const value = textareaRef.current?.plainText!;
      if (!value || !value.trim()) return;
      textareaRef.current.setText("");

      onSubmit(value.trim());
    }
  });

  return (
    <textarea
      ref={textareaRef}
      focused={focused && !disabled}
      width={"100%"}
      padding={2}
      placeholder={
        disabled ? "⏳ Waiting for response..." : "Enter your message..."
      }
    />
  );
}

async function main() {
  const renderer = await createCliRenderer();
  createRoot(renderer).render(<ChatLoop />);
}

main();
