#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// image -> image house remodel via local FLUX.2 klein-9b (ComfyUI on :8189).
//
// Usage: node remodel.ts --image <path|url> --prompt "what to change" [--seed N --steps 4 --mp 1.0 --name out]
// Output PNG -> $REMODEL_DATA/out/<name>_<seed>.png
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DATA = process.env.REMODEL_DATA ?? path.join(process.cwd(), "data");
export const COMFY_URL = "http://127.0.0.1:8189";
export const INPUT_DIR = `${DATA}/ComfyUI/input`;
export const COMFY_OUT = `${DATA}/ComfyUI/output`;
const OUT_DIR = `${DATA}/out`;
export const UNET = "flux-2-klein-9b-Q8_0.gguf";
const CLIP = "qwen_3_8b_fp8mixed.safetensors";
const OUT_PREFIX = "remodel_out";

export interface RemodelOptions {
	readonly seed: number;
	readonly steps: number;
	readonly mp: number;
}

type NodeRef = readonly [string, number];
interface ComfyNode {
	readonly class_type: string;
	readonly inputs: Readonly<Record<string, unknown>>;
}
type ComfyGraph = Readonly<Record<string, ComfyNode>>;

const die = (message: string): never => {
	console.error("ERROR:", message);
	process.exit(1);
};

const requireArg = (value: string | undefined, message: string): string =>
	value ? value : die(message);

const stem = (spec: string): string =>
	path.basename(spec.split("?")[0] ?? spec).replace(/\.[^.]*$/, "") || "input";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// ---- pure: build the ComfyUI image-edit graph ----
export const buildGraph = (
	image: string,
	prompt: string,
	opts: RemodelOptions,
): ComfyGraph => {
	const node = (
		class_type: string,
		inputs: Record<string, unknown>,
	): ComfyNode => ({ class_type, inputs });
	const ref = (id: string, slot: number): NodeRef => [id, slot];
	return {
		unet: node("UnetLoaderGGUF", { unet_name: UNET }),
		clip: node("CLIPLoader", {
			clip_name: CLIP,
			type: "flux2",
			device: "default",
		}),
		vae: node("VAELoader", { vae_name: "flux2-vae.safetensors" }),
		load: node("LoadImage", { image }),
		scale: node("ImageScaleToTotalPixels", {
			image: ref("load", 0),
			upscale_method: "lanczos",
			megapixels: opts.mp,
			resolution_steps: 1,
		}),
		rvae: node("VAEEncode", { pixels: ref("scale", 0), vae: ref("vae", 0) }),
		pos: node("CLIPTextEncode", { text: prompt, clip: ref("clip", 0) }),
		ref: node("ReferenceLatent", {
			conditioning: ref("pos", 0),
			latent: ref("rvae", 0),
		}),
		neg: node("ConditioningZeroOut", { conditioning: ref("pos", 0) }),
		size: node("GetImageSize", { image: ref("scale", 0) }),
		lat: node("EmptyFlux2LatentImage", {
			width: ref("size", 0),
			height: ref("size", 1),
			batch_size: 1,
		}),
		noise: node("RandomNoise", { noise_seed: opts.seed }),
		ksel: node("KSamplerSelect", { sampler_name: "euler" }),
		sched: node("Flux2Scheduler", {
			steps: opts.steps,
			width: ref("size", 0),
			height: ref("size", 1),
		}),
		guide: node("CFGGuider", {
			model: ref("unet", 0),
			positive: ref("ref", 0),
			negative: ref("neg", 0),
			cfg: 1.0,
		}),
		samp: node("SamplerCustomAdvanced", {
			noise: ref("noise", 0),
			guider: ref("guide", 0),
			sampler: ref("ksel", 0),
			sigmas: ref("sched", 0),
			latent_image: ref("lat", 0),
		}),
		dec: node("VAEDecode", { samples: ref("samp", 0), vae: ref("vae", 0) }),
		save: node("SaveImage", {
			images: ref("dec", 0),
			filename_prefix: OUT_PREFIX,
		}),
	};
};

// ---- io: ComfyUI server ----
export const comfyUp = async (): Promise<boolean> => {
	try {
		return (
			await fetch(`${COMFY_URL}/object_info`, {
				signal: AbortSignal.timeout(5000),
			})
		).ok;
	} catch {
		return false;
	}
};

const submitGraph = async (graph: ComfyGraph): Promise<string> => {
	const res = await fetch(`${COMFY_URL}/prompt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ prompt: graph }),
	});
	if (!res.ok) die(`ComfyUI rejected graph:\n${await res.text()}`);
	return ((await res.json()) as { prompt_id: string }).prompt_id;
};

const waitForPrompt = async (
	promptId: string,
	timeoutMs = 3_600_000,
): Promise<void> => {
	const startedAt = Date.now();
	while (Date.now() - startedAt <= timeoutMs) {
		const history = (await (
			await fetch(`${COMFY_URL}/history/${promptId}`)
		).json()) as Record<string, unknown>;
		if (history[promptId]) return;
		await sleep(2000);
	}
	die("timeout waiting for ComfyUI");
};

const latestOutput = (prefix = OUT_PREFIX): string => {
	const pngs = readdirSync(COMFY_OUT)
		.filter((file) => file.startsWith(prefix) && file.endsWith(".png"))
		.sort(
			(a, b) =>
				statSync(`${COMFY_OUT}/${a}`).mtimeMs -
				statSync(`${COMFY_OUT}/${b}`).mtimeMs,
		);
	if (pngs.length === 0) die("no output produced");
	return `${COMFY_OUT}/${pngs[pngs.length - 1]}`;
};

// ---- io: input prep + high-level run (shared by CLI and API) ----
export const writeInput = (name: string, bytes: Buffer): string => {
	mkdirSync(INPUT_DIR, { recursive: true });
	writeFileSync(`${INPUT_DIR}/${name}`, bytes);
	return name;
};

const fetchToFile = async (url: string, dest: string): Promise<string> => {
	writeFileSync(dest, Buffer.from(await (await fetch(url)).arrayBuffer()));
	return dest;
};

const resolveSource = async (spec: string, raw: string): Promise<string> => {
	if (spec.startsWith("http")) return fetchToFile(spec, raw);
	if (existsSync(spec)) return spec;
	return die(`no such file: ${spec}`);
};

export const prepareInput = async (spec: string): Promise<string> => {
	mkdirSync(INPUT_DIR, { recursive: true });
	if (
		!spec.includes("/") &&
		!spec.startsWith("http") &&
		existsSync(`${INPUT_DIR}/${spec}`)
	)
		return spec;
	const png = `${stem(spec)}.png`;
	const raw = `${INPUT_DIR}/${stem(spec)}.src`;
	const src = await resolveSource(spec, raw);
	execFileSync("ffmpeg", [
		"-y",
		"-loglevel",
		"error",
		"-i",
		src,
		`${INPUT_DIR}/${png}`,
	]);
	if (existsSync(raw)) rmSync(raw);
	return png;
};

export const runRemodel = async (
	image: string,
	prompt: string,
	opts: RemodelOptions,
): Promise<string> => {
	const promptId = await submitGraph(buildGraph(image, prompt, opts));
	await waitForPrompt(promptId);
	return latestOutput();
};

const main = async (): Promise<void> => {
	const { values } = parseArgs({
		options: {
			image: { type: "string" },
			prompt: { type: "string" },
			seed: { type: "string", default: "42" },
			steps: { type: "string", default: "4" },
			mp: { type: "string", default: "1.0" },
			name: { type: "string", default: "remodel" },
		},
	});
	const imageSpec = requireArg(values.image, "--image is required");
	const prompt = requireArg(values.prompt, "--prompt is required");
	const rawSeed = Number.parseInt(values.seed, 10);
	const seed = rawSeed < 0 ? Date.now() % 2_000_000_000 : rawSeed;
	if (!(await comfyUp()))
		die(
			"ComfyUI not up on :8189 (run via `nix run .#remodel` or `nix run .#serve-comfy`).",
		);

	const image = await prepareInput(imageSpec);
	const opts: RemodelOptions = {
		seed,
		steps: Number.parseInt(values.steps, 10),
		mp: Number.parseFloat(values.mp),
	};
	const startedAt = Date.now();
	const produced = await runRemodel(image, prompt, opts);
	mkdirSync(OUT_DIR, { recursive: true });
	const final = `${OUT_DIR}/${values.name}_${seed}.png`;
	copyFileSync(produced, final);
	console.log(
		`DONE in ${Math.round((Date.now() - startedAt) / 1000)}s -> ${final}`,
	);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
