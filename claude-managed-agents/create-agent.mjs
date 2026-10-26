import { client } from "./session.mjs";

const agent = await client.beta.agents.create({
  name: "Agent37 dev environment",
  model: "claude-sonnet-5-5",
  system:
    "You work in /workspace on a Linux computer that keeps its files between sessions. " +
    "At the start of a session, read /workspace/NOTES.md if it exists: it is what you left for yourself last time. " +
    "Before you end a turn, update it with what is installed, where the code is, and what is left to do.",
  tools: [{ type: "agent_toolset_20260401" }],
});

console.log(`AGENT_ID=${agent.id}`);
