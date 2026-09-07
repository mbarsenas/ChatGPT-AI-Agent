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

const paint = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[38;5;51m", blue: "\x1b[38;5;75m", violet: "\x1b[38;5;141m",
  green: "\x1b[38;5;84m", amber: "\x1b[38;5;220m", red: "\x1b[38;5;203m"
};

function shorten(value, limit) {
  return value.length > limit ? `…${value.slice(-(limit - 1))}` : value;
}

function divider() {
  return `${paint.dim}${paint.blue}${"─".repeat(Math.min(Math.max((output.columns || 88) - 2, 40), 88))}${paint.reset}`;
}

function renderConsole() {
  const workspace = shorten(ROOT, 68);
  console.log(`\n${paint.cyan}${paint.bold}╭─ S A B L E${paint.reset} ${paint.dim}// OPENAI OPERATOR CONSOLE${paint.reset}`);
  console.log(`${paint.cyan}│${paint.reset} ${paint.green}● ONLINE${paint.reset}   ${paint.dim}model${paint.reset} ${paint.violet}${model}${paint.reset}   ${paint.dim}host${paint.reset} ${os.hostname()}`);
  console.log(`${paint.cyan}│${paint.reset} ${paint.dim}workspace${paint.reset} ${workspace}`);
  console.log(`${paint.cyan}╰─${paint.reset} ${paint.dim}/help  commands  •  /reset  new session  •  /exit  disconnect${paint.reset}`);
  console.log(`${divider()}\n`);
}

function showHelp() {
  console.log(`${paint.cyan}${paint.bold}COMMAND PALETTE${paint.reset}\n`);
  console.log(`  ${paint.violet}/help${paint.reset}    Show this menu`);
  console.log(`  ${paint.violet}/status${paint.reset}  Show workspace and session status`);
  console.log(`  ${paint.violet}/clear${paint.reset}   Clear and redraw the console`);
  console.log(`  ${paint.violet}/reset${paint.reset}   Start a new conversation`);
  console.log(`  ${paint.violet}/exit${paint.reset}    Disconnect\n`);
}

function showStatus() {
  console.log(`\n${paint.cyan}${paint.bold}SYSTEM STATUS${paint.reset}`);
  console.log(`  ${paint.green}●${paint.reset} API session: ${previousResponseId ? "active" : "new"}`);
  console.log(`  ${paint.green}●${paint.reset} Model: ${model}`);
  console.log(`  ${paint.green}●${paint.reset} Workspace: ${ROOT}\n`);
}

function startThinking(label = "Sable is thinking") {
  const frames = ["◐", "◓", "◑", "◒"];
  let index = 0;
  const draw = () => output.write(`\r\x1b[2K${paint.violet}${frames[index++ % frames.length]}${paint.reset} ${paint.dim}${label}…${paint.reset}`);
  draw();
  const timer = setInterval(draw, 110);
  return () => { clearInterval(timer); output.write("\r\x1b[2K"); };
}

async function withThinking(action, label) {
  const stop = startThinking(label);
  try { return await action(); } finally { stop(); }
}

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
  console.log(`\n${paint.amber}${paint.bold}▸ COMMAND APPROVAL REQUIRED${paint.reset}`);
  console.log(`${paint.dim}  ${command}${paint.reset}`);
  const approved = await rl.question(`${paint.amber}  Allow this command? (y/N) ${paint.reset}`);
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

renderConsole();

while (true) {
  const message = await rl.question(`${paint.cyan}${paint.bold}you${paint.reset} ${paint.dim}›${paint.reset} `);
  if (!message.trim()) continue;
  const command = message.trim().toLowerCase();
  if (command === "/exit") break;
  if (command === "/help") { showHelp(); continue; }
  if (command === "/status") { showStatus(); continue; }
  if (command === "/clear") { output.write("\x1Bc"); renderConsole(); continue; }
  if (command === "/reset") { previousResponseId = undefined; console.log(`${paint.green}● Session reset.${paint.reset}\n`); continue; }

  try {
    let response = await withThinking(() => client.responses.create({
      model,
      instructions: `You are a helpful personal terminal agent. Your workspace is ${ROOT}. Use tools only when useful. Never claim a command ran unless its tool result says it did.`,
      tools,
      previous_response_id: previousResponseId,
      input: message
    }));

    while (response.output.some((item) => item.type === "function_call")) {
      const calls = response.output.filter((item) => item.type === "function_call");
      const outputs = [];
      for (const call of calls) {
        outputs.push({ type: "function_call_output", call_id: call.call_id, output: await executeTool(call) });
      }
      response = await withThinking(() => client.responses.create({ model, tools, previous_response_id: response.id, input: outputs }), "Sable is processing tools");
    }

    previousResponseId = response.id;
    console.log(`\n${paint.violet}${paint.bold}sable${paint.reset} ${paint.dim}›${paint.reset} ${response.output_text || "(no text response)"}\n`);
  } catch (error) {
    console.error(`\n${paint.red}✕ Request failed:${paint.reset} ${error.message}\n`);
  }
}

rl.close();
