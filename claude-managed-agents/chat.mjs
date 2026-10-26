import { runTurn, startSession } from "./session.mjs";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2) {
  console.error('usage: node chat.mjs "message"               start a session');
  console.error('       node chat.mjs <session_id> "message"  continue one');
  process.exit(1);
}

const sessionId = args.length === 2 ? args[0] : await startSession();
const text = args.at(-1);

await runTurn(sessionId, text, (event) => {
  if (event.type === "agent.tool_use") console.log(`> ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`);
  if (event.type === "agent.message") console.log(event.content.map((block) => block.text ?? "").join(""));
});

console.log(`\nsession: ${sessionId}`);
