import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic();

export async function startSession() {
  const session = await client.beta.sessions.create({
    agent: process.env.AGENT_ID,
    environment_id: process.env.ANTHROPIC_ENVIRONMENT_ID,
  });
  return session.id;
}

// Sends one message and resolves with the agent's reply once the session goes idle.
export async function runTurn(sessionId, text, onEvent = () => {}) {
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });

  let reply = "";
  for await (const event of stream) {
    onEvent(event);
    if (event.type === "agent.message") reply += event.content.map((block) => block.text ?? "").join("");
    if (event.type === "session.error") throw new Error(JSON.stringify(event.error));
    if (event.type === "session.status_terminated") break;
    // requires_action is the session waiting on the worker to run a tool, not the end of the turn.
    if (event.type === "session.status_idle" && event.stop_reason.type !== "requires_action") break;
  }
  stream.controller.abort();
  return reply;
}
