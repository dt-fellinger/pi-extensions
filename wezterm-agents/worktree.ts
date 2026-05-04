/**
 * Git worktree operations for wezterm-agents extension.
 * Each spawned agent gets an isolated worktree so it can edit files
 * without touching the main working tree.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface WorktreeInfo {
	/** Absolute path to the repo root */
	repoRoot: string;
	/** Absolute path to the worktree directory (repo root of the isolated copy) */
	worktreePath: string;
	/** CWD to hand to the agent — mirrors the original cwd's position within the repo */
	agentCwd: string;
	/** The isolated branch name created for this run */
	branch: string;
	/** The commit the worktree was branched from */
	baseCommit: string;
	/** Whether node_modules was symlinked from the main worktree */
	nodeModulesLinked: boolean;
}

export interface WorktreeDiff {
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	/** Absolute path to the saved .patch file */
	patchPath: string;
}

// ---------------------------------------------------------------------------
// Internal git helpers
// ---------------------------------------------------------------------------

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

function runGit(cwd: string, args: string[]): GitResult {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function runGitChecked(cwd: string, args: string[]): string {
	const r = runGit(cwd, args);
	if (r.status !== 0) {
		throw new Error(r.stderr.trim() || r.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return r.stdout;
}

// ---------------------------------------------------------------------------
// Public guards
// ---------------------------------------------------------------------------

export function isGitRepo(cwd: string): boolean {
	const r = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	return r.status === 0 && r.stdout.trim() === "true";
}

export function isCleanWorkingTree(cwd: string): boolean {
	const r = runGitChecked(cwd, ["status", "--porcelain"]);
	return r.trim().length === 0;
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export function getRepoRoot(cwd: string): string {
	return runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/**
 * Returns the path from the repo root to cwd, e.g. "src/app".
 * Empty string when cwd IS the repo root.
 */
function getCwdRelative(cwd: string): string {
	const prefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalized = prefix ? path.normalize(prefix.replace(/[\\/]+$/, "")) : "";
	return normalized === "." ? "" : normalized;
}

export function createWorktree(cwd: string, uuid: string, agentName: string): WorktreeInfo {
	const repoRoot = getRepoRoot(cwd);
	const baseCommit = runGitChecked(repoRoot, ["rev-parse", "HEAD"]).trim();

	// Sanitise agent name for use in branch/path names
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const branch = `pi-agent-${safeName}-${uuid}`;
	const worktreePath = path.join(os.tmpdir(), `pi-worktree-${uuid}`);

	const add = runGit(repoRoot, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		throw new Error(add.stderr.trim() || add.stdout.trim() || `failed to create worktree at ${worktreePath}`);
	}

	// Mirror the relative position within the repo so the agent's CWD
	// matches the user's CWD (e.g. repo/src/app → worktree/src/app).
	const cwdRelative = getCwdRelative(cwd);
	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;

	// Symlink node_modules from the main worktree to avoid reinstalling deps.
	let nodeModulesLinked = false;
	const nmSrc = path.join(repoRoot, "node_modules");
	const nmDst = path.join(worktreePath, "node_modules");
	if (fs.existsSync(nmSrc) && !fs.existsSync(nmDst)) {
		try {
			fs.symlinkSync(nmSrc, nmDst);
			nodeModulesLinked = true;
		} catch {
			// Best-effort — not critical.
		}
	}

	return { repoRoot, worktreePath, agentCwd, branch, baseCommit, nodeModulesLinked };
}

export function captureWorktreeDiff(worktree: WorktreeInfo, _agentName: string): WorktreeDiff {
	const { worktreePath, baseCommit, nodeModulesLinked } = worktree;

	// Remove node_modules symlink before diffing to prevent false positives.
	if (nodeModulesLinked) {
		try { fs.unlinkSync(path.join(worktreePath, "node_modules")); } catch {}
	}

	// Stage everything the agent left behind.
	runGit(worktreePath, ["add", "-A"]);

	const patch = runGitChecked(worktreePath, ["diff", "--cached", baseCommit]);
	const diffStat = runGitChecked(worktreePath, ["diff", "--cached", "--stat", baseCommit]).trim();
	const numstat = runGitChecked(worktreePath, ["diff", "--cached", "--numstat", baseCommit]);

	const patchPath = path.join(os.tmpdir(), `pi-agent-${path.basename(worktreePath)}.patch`);
	fs.writeFileSync(patchPath, patch, "utf-8");

	// Parse numstat for counts.
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;
	for (const line of numstat.split("\n").filter(Boolean)) {
		const [ins, del] = line.split("\t");
		filesChanged++;
		if (ins && /^\d+$/.test(ins)) insertions += parseInt(ins, 10);
		if (del && /^\d+$/.test(del)) deletions += parseInt(del, 10);
	}

	return { diffStat, filesChanged, insertions, deletions, patchPath };
}

export function cleanupWorktree(worktree: WorktreeInfo): void {
	try { runGitChecked(worktree.repoRoot, ["worktree", "remove", "--force", worktree.worktreePath]); } catch {}
	try { runGitChecked(worktree.repoRoot, ["branch", "-D", worktree.branch]); } catch {}
	try { runGitChecked(worktree.repoRoot, ["worktree", "prune"]); } catch {}
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDiffSummary(agentName: string, diff: WorktreeDiff): string {
	if (diff.filesChanged === 0) return "";
	const lines = [
		`=== Worktree Changes: ${agentName} ===`,
		"",
		diff.diffStat,
		"",
		`${diff.filesChanged} file${diff.filesChanged !== 1 ? "s" : ""} changed, +${diff.insertions} -${diff.deletions}`,
		`Patch saved to: ${diff.patchPath}`,
		`Apply with:     git apply ${diff.patchPath}`,
	];
	return lines.join("\n").trimEnd();
}
