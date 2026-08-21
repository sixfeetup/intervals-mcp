import { createRuntime } from "../domain/runtime.js";
import { runCli } from "./cli.js";
import { promptHidden, promptVisible } from "./prompt.js";

const runtime = createRuntime();
try {
  process.exitCode = await runCli(process.argv.slice(2), runtime, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    prompt: promptVisible,
    promptSecret: promptHidden,
    interactive: process.stdin.isTTY === true,
    bright: process.stdout.isTTY === true,
  });
} finally {
  runtime.close();
}
