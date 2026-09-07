import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";

const MAX_OUTPUT = 12_000;
const ROOT = path.resolve(process.env.AGENT_ROOT || process.cwd());
const model = process.env.OPENAI_MODEL || "gpt-5";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Add your OpenAI API key, then run this again.");
  process.exit(1);
}

const client = new OpenAI();
const rl = readline.createInterface({ input, output });
let previousResponseId;

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file within the agent workspace.",
    strict: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path from the workspace" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "list_files",
    description: "List files and folders within a workspace directory.",
    strict: true,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative directory path; use . for the workspace root" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "run_command",
    description: "Request that a shell command be run in the workspace. The user must approve every command before it runs.",
    strict: true,
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The command to run" } },
      required: ["command"],
      additionalProperties: false
    }
  }
];

function insideRoot(relativePath) {
  const resolved = path.resolve(ROOT, relativePath);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) throw new Error("Path must stay inside the agent workspace.");
  return resolved;
}

function cap(text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[Output truncated]` : text;
}

async function runShell(command) {
  const approved = await rl.question(`\nAgent requests this command:\n  ${command}\nAllow? (y/N) `);
  if (!/^(y|yes)$/i.test(approved.trim())) return "User declined the command.";

  const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  return await new Promise((resolve) => {
    const child = spawn(shell, args, { cwd: ROOT, windowsHide: true });
    let result = "";
    child.stdout.on("data", (data) => { result += data; });
    child.stderr.on("data", (data) => { result += data; });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(cap(`${result || "(no output)"}\nExit code: ${code}`));
    });
    child.on("error", (error) => { clearTimeout(timer); resolve(`Unable to run command: ${error.message}`); });
  });
}

async function executeTool(call) {
  try {
    const args = JSON.parse(call.arguments);
    if (call.name === "read_file") return cap(await fs.readFile(insideRoot(args.path), "utf8"));
    if (call.name === "list_files") {
      const entries = await fs.readdir(insideRoot(args.path), { withFileTypes: true });
      return entries.map((entry) => `${entry.isDirectory() ? "[dir] " : "      "}${entry.name}`).join("\n") || "(empty directory)";
    }
    if (call.name === "run_command") return await runShell(args.command);
    return `Unknown tool: ${call.name}`;
  } catch (error) {
    return `Tool error: ${error.message}`;
  }
}

console.log(`=== OpenAI Terminal Agent ===\nWorkspace: ${ROOT}\nModel: ${model}\nCommands: /reset, /exit\n`);

while (true) {
  const message = await rl.question("you> ");
  if (!message.trim()) continue;
  if (message.trim() === "/exit") break;
  if (message.trim() === "/reset") { previousResponseId = undefined; console.log("Conversation reset.\n"); continue; }

  try {
    let response = await client.responses.create({
      model,
      instructions: `You are a helpful personal terminal agent. Your workspace is ${ROOT}. Use tools only when useful. Never claim a command ran unless its tool result says it did.`,
      tools,
      previous_response_id: previousResponseId,
      input: message
    });

    while (response.output.some((item) => item.type === "function_call")) {
      const calls = response.output.filter((item) => item.type === "function_call");
      const outputs = [];
      for (const call of calls) {
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: await executeTool(call) });
      }
      response = await client.responses.create({ model, tools, previous_response_id: response.id, input: outputs });
    }

    previousResponseId = response.id;
    console.log(`\nagent> ${response.output_text || "(no text response)"}\n`);
  } catch (error) {
    console.error(`\nRequest failed: ${error.message}\n`);
  }
}

rl.close();
