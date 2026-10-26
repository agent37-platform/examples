import { runTurn, startSession } from "./session.mjs";

const languages = ["Python", "Node.js", "C compiled with gcc -O2"];

const started = Date.now();
const results = await Promise.all(
  languages.map(async (language) => {
    const sessionId = await startSession();
    console.log(`${language}: session ${sessionId}`);
    const reply = await runTurn(
      sessionId,
      `Write a program in ${language} that counts the primes below 20,000,000 with a sieve, run it, ` +
        `and reply with one line: the count and the wall-clock time of the run.`,
    );
    return `${language}: ${reply.trim()}`;
  }),
);

console.log(`\n${results.join("\n")}`);
console.log(`\n${languages.length} sessions, each on its own instance, in ${Math.round((Date.now() - started) / 1000)} s`);
