#!/usr/bin/env node
// First-time setup for the remodel project. Run once: `nix run .#bootstrap`.
// Downloads everything into ./data (gitignored): ComfyUI + a Python venv +
// the FLUX.2 klein-9b models, and pulls gemma3:27b for Ollama.
// Total download is large (~35GB of models); allow time on the first run.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const DATA = process.env.REMODEL_DATA ?? path.join(process.cwd(), "data");
const COMFY = `${DATA}/ComfyUI`;
const MODELS = `${COMFY}/models`;
const VENV = `${DATA}/venv`;
const OLLAMA_DIR = `${DATA}/ollama`;
const PULL_HOST = "127.0.0.1:11436";

interface Download {
	readonly url: string;
	readonly dest: string;
}

const MODEL_FILES: readonly Download[] = [
	{
		url: "https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF/resolve/main/flux-2-klein-9b-Q8_0.gguf",
		dest: `${MODELS}/unet/flux-2-klein-9b-Q8_0.gguf`,
	},
	{
		url: "https://huggingface.co/Comfy-Org/flux2-klein-9B/resolve/main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors",
		dest: `${MODELS}/text_encoders/qwen_3_8b_fp8mixed.safetensors`,
	},
	{
		url: "https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors",
		dest: `${MODELS}/vae/flux2-vae.safetensors`,
	},
];

// ---- helpers ----
const hasFile = (file: string): boolean =>
	existsSync(file) && statSync(file).size > 0;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const run = (
	cmd: string,
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
): void => {
	execFileSync(cmd, args, { stdio: "inherit", env });
};

const cloneIfMissing = (repo: string, dest: string): void => {
	if (existsSync(`${dest}/.git`)) return;
	run("git", ["clone", "--depth", "1", repo, dest]);
};

const download = ({ url, dest }: Download): void => {
	if (hasFile(dest)) {
		console.log(`   have ${path.basename(dest)}`);
		return;
	}
	console.log(`   downloading ${path.basename(dest)}`);
	run("curl", ["-fL", "-C", "-", "-o", dest, url]);
};

// ---- steps ----
const setupComfy = (): void => {
	console.log(">> ComfyUI + GGUF node");
	cloneIfMissing("https://github.com/comfyanonymous/ComfyUI.git", COMFY);
	cloneIfMissing(
		"https://github.com/city96/ComfyUI-GGUF",
		`${COMFY}/custom_nodes/ComfyUI-GGUF`,
	);
};

const setupVenv = (): void => {
	console.log(">> python venv (torch family pinned to cu124 / 2.6.0)");
	if (existsSync(`${VENV}/bin/python`)) {
		console.log("   venv exists, skipping");
		return;
	}
	run("python", ["-m", "venv", VENV]);
	const pip = `${VENV}/bin/pip`;
	run(`${VENV}/bin/python`, ["-m", "pip", "install", "-q", "--upgrade", "pip"]);
	run(pip, [
		"install",
		"-q",
		"torch==2.6.0",
		"torchvision==0.21.0",
		"torchaudio==2.6.0",
		"--index-url",
		"https://download.pytorch.org/whl/cu124",
	]);
	run(pip, ["install", "-q", "-r", `${COMFY}/requirements.txt`]);
	run(pip, ["install", "-q", "gguf"]);
};

const downloadModels = (): void => {
	console.log(">> FLUX.2 klein-9b models");
	for (const dir of ["unet", "text_encoders", "vae"])
		mkdirSync(`${MODELS}/${dir}`, { recursive: true });
	for (const file of MODEL_FILES) download(file);
};

const pullGemma = async (): Promise<void> => {
	console.log(`>> gemma3:27b for Ollama (into ${OLLAMA_DIR})`);
	const env = {
		...process.env,
		OLLAMA_MODELS: OLLAMA_DIR,
		OLLAMA_HOST: PULL_HOST,
	};
	const server: ChildProcess = spawn("ollama", ["serve"], {
		env,
		stdio: "ignore",
	});
	try {
		for (let i = 0; i < 30; i++) {
			try {
				if ((await fetch(`http://${PULL_HOST}/api/tags`)).ok) break;
			} catch {
				// server not ready yet
			}
			await sleep(1000);
		}
		run("ollama", ["pull", "gemma3:27b"], env);
	} finally {
		server.kill();
	}
};

const main = async (): Promise<void> => {
	console.log(`>> data dir: ${DATA}`);
	for (const dir of [COMFY, OLLAMA_DIR, `${DATA}/out`])
		mkdirSync(dir, { recursive: true });
	setupComfy();
	setupVenv();
	downloadModels();
	await pullGemma();
	console.log(">> BOOTSTRAP DONE");
};

await main();
