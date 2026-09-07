# OpenAI Terminal Agent

A small personal command-line agent powered by the OpenAI Responses API. It can chat, read text files, list workspace files, and ask before running **every** shell command.

## Setup (Windows PowerShell)

```powershell
cd C:\Users\Mark
mkdir openai-terminal-agent
# Copy these project files into that folder, then:
npm install
$env:OPENAI_API_KEY = "your-api-key"
npm start
```

Create an API key at https://platform.openai.com/api-keys. ChatGPT Plus and API billing are separate.

To make the key permanent for future PowerShell sessions:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "your-api-key", "User")
```

Close and reopen PowerShell afterwards. You can also choose a different API model:

```powershell
$env:OPENAI_MODEL = "gpt-5"
```

## Use

Run it from the folder you want it to work in, or set a workspace explicitly:

```powershell
$env:AGENT_ROOT = "C:\Users\Mark\Projects"
npm start
```

Examples:

- `what files are in this folder?`
- `read package.json and tell me how to run this project`
- `check git status`

The agent cannot read outside `AGENT_ROOT` (or its launch folder by default). Commands execute only after you type `y` or `yes` at the prompt. Use `/reset` to start a fresh conversation and `/exit` to quit.
