/**
 * wezterm-agents — pi extension
 *
 * Spawns sub-agents in WezTerm tabs with git worktree isolation.
 * Each agent gets:
 *   • Its own isolated git branch (worktree) so edits never touch your tree.
 *   • A dedicated WezTerm tab with human-readable formatted output.
 *   • A Catppuccin Mocha–colored tab title: 🤖 running · ✅ done · ❌ failed.
 *   • A diff summary returned to the parent LLM when the agent finishes.
 *
 * Architecture: pi runs as a CHILD PROCESS of this extension (inheriting its
 * authenticated environment). The WezTerm tab runs formatter.py which
 * translates the JSON event stream into human-readable coloured output.
 *
 * Registers:
 *   Tool     spawn_agent   — LLM-callable
 *   Command  /spawn        — user-callable
 *
 * Requires:
 *   • Running inside WezTerm (WEZTERM_PANE env var must be set).
 *   • A clean git working tree (commit or stash first).
 *   • Agent profiles in ~/.pi/agent/agents/*.md
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.js";
import {
	isGitRepo,
	isCleanWorkingTree,
	getRepoRoot,
	createWorktree,
	captureWorktreeDiff,
	cleanupWorktree,
	formatDiffSummary,
	type WorktreeInfo,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a task string to a short tab title, breaking on word boundaries. */
function truncateObjective(task: string, maxLen = 35): string {
	const firstLine = task.split("\n")[0]?.trim() ?? task;
	if (firstLine.length <= maxLen) return firstLine;
	const cut = firstLine.slice(0, maxLen);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > 10 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Run a wezterm cli sub-command synchronously. Returns stdout and ok flag. */
function wezterm(...args: string[]): { stdout: string; ok: boolean; stderr: string } {
	const r = spawnSync("wezterm", ["cli", ...args], { encoding: "utf-8" });
	return {
		stdout: r.stdout?.trim() ?? "",
		stderr: r.stderr?.trim() ?? "",
		ok: r.status === 0,
	};
}

/** Parse pi JSON-mode output and extract the final assistant text. */
function parseAgentOutput(outputPath: string): { finalText: string; hasError: boolean } {
	let finalText = "";
	let hasError = false;
	try {
		const content = fs.readFileSync(outputPath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let event: Record<string, unknown>;
			try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

			if (event["type"] === "message_end") {
				const msg = event["message"] as Record<string, unknown> | undefined;
				if (msg?.["role"] === "assistant") {
					const parts = msg["content"] as Array<Record<string, unknown>> | undefined;
					for (const part of parts ?? []) {
						if (part["type"] === "text") finalText = part["text"] as string;
					}
					if (msg["stopReason"] === "error" || msg["errorMessage"]) hasError = true;
				}
			}
		}
	} catch {}
	return { finalText, hasError };
}

// ---------------------------------------------------------------------------
// Core spawn logic (shared by tool and command)
// ---------------------------------------------------------------------------

interface SpawnParams {
	agent: string;
	task: string;
	agentScope?: AgentScope;
	model?: string;
	tools?: string;
	cwd?: string;
	/** Skip the clean-working-tree check (caller already resolved it). */
	skipDirtyCheck?: boolean;
}

interface SpawnResult {
	text: string;
	isError: boolean;
}

async function spawnAgentTab(
	params: SpawnParams,
	execCtx: { cwd: string; signal?: AbortSignal },
): Promise<SpawnResult> {
	// ── WezTerm guard ──────────────────────────────────────────────────────
	const currentPaneId = process.env["WEZTERM_PANE"];
	if (!currentPaneId) {
		return {
			text: "Error: WEZTERM_PANE is not set. Are you running inside WezTerm?",
			isError: true,
		};
	}

	// ── Agent discovery ────────────────────────────────────────────────────
	const cwd = params.cwd ?? execCtx.cwd;
	const discovery = discoverAgents(cwd, params.agentScope ?? "user");
	const agent: AgentConfig | undefined = discovery.agents.find(a => a.name === params.agent);
	if (!agent) {
		const available = discovery.agents.map(a => a.name).join(", ") || "none";
		return { text: `Unknown agent: "${params.agent}". Available: ${available}`, isError: true };
	}

	// ── Git guards ─────────────────────────────────────────────────────────
	if (!isGitRepo(cwd)) {
		return {
			text: `"${cwd}" is not inside a git repository. Worktree isolation requires git.`,
			isError: true,
		};
	}
	if (!params.skipDirtyCheck && !isCleanWorkingTree(cwd)) {
		return {
			text: "Working tree has uncommitted changes. Commit or stash your changes first.",
			isError: true,
		};
	}

	// ── Temp file paths ────────────────────────────────────────────────────
	const uuid = crypto.randomBytes(4).toString("hex");
	const objective = truncateObjective(params.task);

	const displayScriptPath = path.join(os.tmpdir(), `pi-agent-${uuid}-display.sh`);
	const promptPath        = path.join(os.tmpdir(), `pi-agent-${uuid}-prompt.md`);
	const outputPath        = path.join(os.tmpdir(), `pi-agent-${uuid}.json`);
	const tempFiles         = [displayScriptPath, promptPath, outputPath];

	let worktree: WorktreeInfo | undefined;
	let newPaneId: string | undefined;
	let finalText = "";
	let isError = false;

	try {
		// ── Create worktree ────────────────────────────────────────────────
		try {
			worktree = createWorktree(cwd, uuid, params.agent);
		} catch (e) {
			return {
				text: `Failed to create worktree: ${e instanceof Error ? e.message : String(e)}`,
				isError: true,
			};
		}

		// ── Write system prompt file ───────────────────────────────────────
		const hasPrompt = agent.systemPrompt.length > 0;
		if (hasPrompt) fs.writeFileSync(promptPath, agent.systemPrompt);

		// ── Build pi args ──────────────────────────────────────────────────
		// Pass the task as a direct positional arg — no shell escaping needed
		// because we are NOT going through bash; we spawn node directly.
		const piArgs: string[] = ["--mode", "json", "-p", "--no-session"];
		const model = params.model ?? agent.model;
		if (model) piArgs.push("--model", model);
		const toolsStr = params.tools ?? agent.tools?.join(",");
		if (toolsStr) piArgs.push("--tools", toolsStr);
		if (hasPrompt) piArgs.push("--append-system-prompt", promptPath);
		piArgs.push(`Task: ${params.task}`);

		// ── Open WezTerm pane (human-readable formatter) ────────────────────
		// formatter.py translates JSON events into readable Catppuccin output.
		// Spawns to the right of the current pane; stacks at the bottom of
		// the right column if a right pane already exists.
		const formatterPath = path.join(getAgentDir(), "extensions", "wezterm-agents", "formatter.py");
		const taskPreview = params.task.split("\n")[0]?.slice(0, 120) ?? "";
		const modelLabel  = (params.model ?? agent.model) ?? "";
		const safeTask    = taskPreview.replace(/'/g, "\'\'\'");
		const safeModel   = modelLabel.replace(/'/g, "\'\'\'");

		const displayScript = [
			"#!/usr/bin/env bash",
			`python3 '${formatterPath}' '${outputPath}' '${params.agent}' '${safeModel}' '${safeTask}'`,
			"sleep 10",
		].join("\n");
		fs.writeFileSync(displayScriptPath, displayScript, { mode: 0o755 });

		// Walk down to find the bottom-most pane in a column.
		const findBottomPane = (paneId: string): string => {
			let cur = paneId;
			for (;;) {
				const r = wezterm("get-pane-direction", "--pane-id", cur, "Down");
				if (!r.ok || !r.stdout) break;
				cur = r.stdout;
			}
			return cur;
		};

		// Place new pane: right split first time, bottom split in right column thereafter.
		const rightCheck = wezterm("get-pane-direction", "Right");
		let splitResult: ReturnType<typeof wezterm>;
		if (!rightCheck.ok || !rightCheck.stdout) {
			splitResult = wezterm(
				"split-pane", "--right", "--percent", "40",
				"--cwd", worktree.agentCwd,
				"--", "bash", displayScriptPath,
			);
		} else {
			const bottomPane = findBottomPane(rightCheck.stdout);
			splitResult = wezterm(
				"split-pane", "--bottom",
				"--pane-id", bottomPane,
				"--cwd", worktree.agentCwd,
				"--", "bash", displayScriptPath,
			);
		}
		if (!splitResult.ok) {
			throw new Error(`WezTerm split-pane failed: ${splitResult.stderr || "(no details)"}`);
		}
		newPaneId = splitResult.stdout;
		wezterm("activate-pane", "--pane-id", currentPaneId);

		// ── Run pi as a child process (inherits this extension's env) ──────
		// Strip PI_CODING_AGENT so the child initialises as a fresh pi
		// session and loads settings.json / auth.json normally. When that
		// flag is present pi detects it's inside another pi instance and
		// expects provider credentials via env vars instead of auth.json.
		const childEnv = { ...process.env };
		delete childEnv["PI_CODING_AGENT"];

		const piProcess = spawn(process.execPath, [process.argv[1]!, ...piArgs], {
			cwd: worktree.agentCwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnv,
		});

		const outStream = fs.createWriteStream(outputPath);
		piProcess.stdout.pipe(outStream);
		piProcess.stderr.pipe(outStream);

		await new Promise<void>((resolve, reject) => {
			piProcess.on("close", (code) => {
				// Write completion marker so formatter.py always gets a terminal event,
				// even if pi crashed before emitting agent_end.
				outStream.write(
					JSON.stringify({ type: "wezterm_agent_done", exitCode: code ?? 1 }) + "\n",
					() => outStream.end(),
				);
				isError = code !== 0;
				resolve();
			});
			piProcess.on("error", (e) => { outStream.end(); reject(e); });
			execCtx.signal?.addEventListener("abort", () => {
				piProcess.kill("SIGTERM");
				setTimeout(() => piProcess.kill("SIGKILL"), 3000);
				reject(new Error("aborted"));
			}, { once: true });
		});

		// ── Parse output ───────────────────────────────────────────────────
		const parsed = parseAgentOutput(outputPath);
		finalText = parsed.finalText;
		if (parsed.hasError) isError = true;

	} catch (e) {
		isError = true;
		const msg = e instanceof Error ? e.message : String(e);
		finalText = msg === "aborted" ? "Agent was aborted." : `Error: ${msg}`;
		if (newPaneId && execCtx.signal?.aborted) wezterm("kill-pane", "--pane-id", newPaneId);
	} finally {
		// ── Capture diff and destroy worktree ──────────────────────────────
		let diffSummary = "";
		if (worktree) {
			try {
				const diff = captureWorktreeDiff(worktree, params.agent);
				diffSummary = formatDiffSummary(params.agent, diff);
			} catch {}
			try { cleanupWorktree(worktree); } catch {}
		}

		// ── Clean up temp files ────────────────────────────────────────────
		// The .patch file is intentionally kept — its path is in diffSummary.
		for (const f of tempFiles) {
			try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
		}

		// ── Schedule pane auto-close (10 s safety net after sleep 10 in script)
		if (newPaneId) {
			setTimeout(() => {
				try { wezterm("kill-pane", "--pane-id", newPaneId!); } catch {}
			}, 10_000);
		}

		// ── Append diff to result ──────────────────────────────────────────
		if (diffSummary) {
			finalText = finalText ? `${finalText}\n\n${diffSummary}` : diffSummary;
		}
	}

	return { text: finalText || "(no output)", isError };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI commit message generation
// ---------------------------------------------------------------------------

async function generateAiCommitMessage(repoRoot: string): Promise<string> {
	try {
		const stat = spawnSync("git", ["-C", repoRoot, "diff", "HEAD", "--stat"], { encoding: "utf-8", timeout: 5000 }).stdout.trim();
		const diff = spawnSync("git", ["-C", repoRoot, "diff", "HEAD"], { encoding: "utf-8", timeout: 5000 }).stdout.slice(0, 4000);

		const prompt = [
			"Generate a single git commit message in imperative mood, max 72 chars.",
			"Output ONLY the commit message. No explanation, no quotes, no markdown.",
			"",
			"Changes:",
			stat,
			diff ? `\nDiff preview:\n${diff}` : "",
		].join("\n");

		const childEnv = { ...process.env };
		delete childEnv["PI_CODING_AGENT"];

		const output = await new Promise<string>((resolve) => {
			const child = spawn(
				process.execPath,
				[process.argv[1]!, "--mode", "json", "-p", "--no-session", prompt],
				{ env: childEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
			);
			let out = "";
			child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
			child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
			const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(""); }, 15_000);
			child.on("close", () => { clearTimeout(timer); resolve(out); });
			child.on("error", () => { clearTimeout(timer); resolve(""); });
		});

		// Extract final assistant text from the JSON event stream.
		for (const line of output.split("\n").reverse()) {
			if (!line.trim()) continue;
			let ev: Record<string, unknown>;
			try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
			if (ev["type"] === "message_end") {
				const msg = ev["message"] as Record<string, unknown> | undefined;
				if (msg?.["role"] === "assistant") {
					for (const part of ([...(msg["content"] as Array<Record<string, unknown>> ?? [])]).reverse()) {
						if (part["type"] === "text") {
							return (part["text"] as string)
								.trim()
								.replace(/^["']|["']$/g, "")
								.split("\n")[0]!
								.slice(0, 72);
						}
					}
				}
			}
		}
	} catch {}
	return "";
}

export default function (pi: ExtensionAPI) {

	// ── Tool: spawn_agent ────────────────────────────────────────────────────
	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: [
			"Spawn a sub-agent in a WezTerm tab with git worktree isolation.",
			"The agent runs in an isolated branch; file changes are captured as a diff and reported back.",
			"The tab auto-closes 60 s after the agent finishes.",
			"Agent profiles are loaded from ~/.pi/agent/agents/*.md",
		].join(" "),
		promptSnippet: "Delegate a task to a named sub-agent running in its own WezTerm tab",
		parameters: Type.Object({
			agent: Type.String({
				description: "Agent name (must match the `name` field in ~/.pi/agent/agents/<name>.md)",
			}),
			task: Type.String({
				description: "Full task description passed as the agent's prompt",
			}),
			agentScope: Type.Optional(
				StringEnum(["user", "project", "both"] as const, {
					description: 'Agent search scope. Default: "user" (~/.pi/agent/agents/). Use "both" to also include .pi/agents/ in the project.',
				}),
			),
			model: Type.Optional(Type.String({
				description: "Model override (e.g. claude-haiku-4-5). Falls back to the agent profile's model, then pi's default.",
			})),
			tools: Type.Optional(Type.String({
				description: "Comma-separated tool list override (e.g. read,bash,write). Falls back to the agent profile's tools.",
			})),
			cwd: Type.Optional(Type.String({
				description: "Working directory for git and the agent. Defaults to the current session cwd.",
			})),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await spawnAgentTab(
				{ ...params, agentScope: params.agentScope as AgentScope | undefined },
				{ cwd: ctx.cwd, signal },
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: {},
				isError: result.isError,
			};
		},
	});

	// ── Command: /spawn ──────────────────────────────────────────────────────
	pi.registerCommand("spawn", {
		description: "Spawn a sub-agent in a WezTerm tab  ·  Usage: /spawn <agent> <task>",
		handler: async (args, ctx) => {
			let agentName: string | undefined;
			let task: string | undefined;

			// Parse inline args: /spawn worker Fix the auth bug
			if (args?.trim()) {
				const parts = args.trim().split(/\s+/);
				agentName = parts[0];
				const rest = parts.slice(1).join(" ").trim();
				if (rest) task = rest;
			}

			// No agent name → show selector
			if (!agentName) {
				const discovery = discoverAgents(ctx.cwd, "user");
				if (discovery.agents.length === 0) {
					ctx.ui.notify(
						"No agents found. Create ~/.pi/agent/agents/<name>.md to get started.",
						"error",
					);
					return;
				}
				const labels = discovery.agents.map(a => `${a.name}  —  ${a.description}`);
				const chosen = await ctx.ui.select("Select agent:", labels);
				if (!chosen) return;
				agentName = chosen.split("  —  ")[0]?.trim();
				if (!agentName) return;
			}

			// No task → prompt for it
			if (!task) {
				const input = await ctx.ui.input("Task", `What should ${agentName} do?`);
				if (!input?.trim()) return;
				task = input.trim();
			}

			// ── Dirty working tree: offer to stash or commit before spawning ───────
			let didStash = false;
			const cwd = ctx.cwd;
			if (isGitRepo(cwd) && !isCleanWorkingTree(cwd)) {
				const choice = await ctx.ui.select(
					"Working tree has uncommitted changes:",
					["Commit changes and proceed", "Stash changes and proceed", "Cancel"],
				);
				if (!choice || choice === "Cancel") return;

				const repoRoot = getRepoRoot(cwd);

				if (choice === "Stash changes and proceed") {
					const r = spawnSync("git", ["-C", repoRoot, "stash"], { encoding: "utf-8" });
					if (r.status !== 0) {
						ctx.ui.notify(`Stash failed: ${r.stderr.trim() || r.stdout.trim()}`, "error");
						return;
					}
					didStash = true;
					ctx.ui.notify("Changes stashed. Will restore after agent finishes.", "info");
				} else {
					// Commit path — generate message with AI, present it as a selectable
					// option so the user can accept it with Enter or choose to type their own.
					ctx.ui.notify("Generating commit message…", "info");
					const suggested = await generateAiCommitMessage(repoRoot);

					let finalMsg: string;
					if (suggested) {
						const pick = await ctx.ui.select(
							"Commit message:",
							[suggested, "Enter custom message…"],
						);
						if (!pick) return;
						if (pick === "Enter custom message…") {
							const custom = await ctx.ui.input("Commit message:", "WIP: before agent run");
							if (!custom?.trim()) return;
							finalMsg = custom.trim();
						} else {
							finalMsg = pick;
						}
					} else {
						// AI failed — fall back to plain input.
						const custom = await ctx.ui.input("Commit message:", "WIP: before agent run");
						if (!custom?.trim()) return;
						finalMsg = custom.trim();
					}
					spawnSync("git", ["-C", repoRoot, "add", "-A"], { encoding: "utf-8" });
					const r = spawnSync("git", ["-C", repoRoot, "commit", "-m", finalMsg], { encoding: "utf-8" });
					if (r.status !== 0) {
						ctx.ui.notify(`Commit failed: ${r.stderr.trim() || r.stdout.trim()}`, "error");
						return;
					}
				}
			}

			ctx.ui.notify(`Spawning ${agentName}…`, "info");

			const result = await spawnAgentTab(
				{ agent: agentName, task, skipDirtyCheck: true },
				{ cwd },
			);

			// Restore stash after agent finishes (agent worked in its own worktree,
			// so there are no conflicts with the main tree).
			if (didStash) {
				const repoRoot = getRepoRoot(cwd);
				const pop = spawnSync("git", ["-C", repoRoot, "stash", "pop"], { encoding: "utf-8" });
				if (pop.status !== 0) {
					ctx.ui.notify("Stash pop failed — run 'git stash pop' manually.", "error");
				} else {
					ctx.ui.notify("Stash restored.", "info");
				}
			}

			if (result.isError) {
				ctx.ui.notify(`Agent failed: ${result.text.slice(0, 120)}`, "error");
			} else {
				ctx.ui.notify(`Agent finished: ${result.text.slice(0, 120)}`, "success");
			}
		},
	});
}
