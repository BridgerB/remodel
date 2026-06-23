#!/usr/bin/env node
// HTTP API serving BOTH local house tools on localhost:8090.
//   POST /describe   image -> structured JSON      (gemma3:27b)
//   POST /remodel    {prompt,...} + image -> image (FLUX.2 klein-9b)
//   GET  /health
// Reach from a laptop:  ssh -N -L 8090:localhost:8090 bridger@192.168.0.47
// Send images as a raw body (Content-Type: image/*) or JSON {"image_url"|"image_b64", ...}.
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { describeOne, MODEL, PROMPT } from "./describe.ts";
import {
	type RemodelOptions,
	runRemodel,
	UNET,
	writeInput,
} from "./remodel.ts";

const PORT = 8090;
const OLLAMA_URL = "http://127.0.0.1:11435/api/generate";
const SERVER_KEEP = process.env.REMODEL_KEEP_ALIVE ?? "2m";

type Json = Record<string, unknown>;
interface ImagePayload {
	readonly bytes: Buffer;
	readonly meta: Json;
}
interface RemodelRequest extends RemodelOptions {
	readonly prompt: string;
}

// ---- boundary validation: untrusted JSON -> typed values ----
const asNumber = (value: unknown, fallback: number): number => {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
};

const parseRemodelRequest = (meta: Json): RemodelRequest => {
	if (typeof meta.prompt !== "string" || meta.prompt.length === 0)
		throw new Error(
			"/remodel requires a non-empty string 'prompt' in the JSON body",
		);
	return {
		prompt: meta.prompt,
		seed: asNumber(meta.seed, 42),
		steps: asNumber(meta.steps, 4),
		mp: asNumber(meta.mp, 1),
	};
};

// ---- io helpers ----
const readBody = (req: IncomingMessage): Promise<Buffer> =>
	new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
	});

const fetchBytes = async (url: string): Promise<Buffer> =>
	Buffer.from(await (await fetch(url)).arrayBuffer());

const readImage = async (
	contentType: string,
	body: Buffer,
): Promise<ImagePayload> => {
	if (!contentType.startsWith("application/json"))
		return { bytes: body, meta: {} };
	const meta = JSON.parse(body.toString() || "{}") as Json;
	if (typeof meta.image_b64 === "string")
		return { bytes: Buffer.from(meta.image_b64, "base64"), meta };
	if (typeof meta.image_url === "string")
		return { bytes: await fetchBytes(meta.image_url), meta };
	throw new Error("need image_b64 or image_url");
};

const unloadGemma = async (): Promise<void> => {
	// Evict gemma3 so the 9b remodel has the GPU/RAM (they can't both be resident).
	try {
		await fetch(OLLAMA_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		// best effort
	}
};

const sendJson = (res: ServerResponse, code: number, body: unknown): void => {
	res.writeHead(code, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body, null, 2));
};

// ---- handlers: take an image payload, return the response body ----
const handleDescribe = async (bytes: Buffer, meta: Json): Promise<Json> => {
	const prompt = typeof meta.prompt === "string" ? meta.prompt : PROMPT;
	const { seconds, result } = await describeOne(
		bytes.toString("base64"),
		SERVER_KEEP,
		prompt,
	);
	return { ok: true, model: MODEL, seconds, result };
};

const handleRemodel = async (bytes: Buffer, meta: Json): Promise<Json> => {
	const { prompt, ...opts } = parseRemodelRequest(meta);
	await unloadGemma();
	const name = writeInput(`api_${opts.seed}.png`, bytes);
	const startedAt = Date.now();
	const produced = await runRemodel(name, prompt, opts);
	return {
		ok: true,
		model: UNET,
		seconds: Math.round((Date.now() - startedAt) / 1000),
		image_b64: readFileSync(produced).toString("base64"),
	};
};

const route = async (
	pathname: string,
	payload: ImagePayload,
): Promise<Json | null> => {
	if (pathname === "/describe")
		return handleDescribe(payload.bytes, payload.meta);
	if (pathname === "/remodel")
		return handleRemodel(payload.bytes, payload.meta);
	return null;
};

const onRequest = async (
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> => {
	const pathname = (req.url ?? "").split("?")[0] ?? "";
	if (req.method === "GET") {
		return sendJson(res, pathname === "/health" ? 200 : 404, {
			ok: pathname === "/health",
			endpoints: ["/describe", "/remodel"],
		});
	}
	if (req.method !== "POST")
		return sendJson(res, 405, { ok: false, error: "use POST" });
	try {
		const payload = await readImage(
			(req.headers["content-type"] ?? "").toLowerCase(),
			await readBody(req),
		);
		if (payload.bytes.length === 0)
			return sendJson(res, 400, { ok: false, error: "no image" });
		const body = await route(pathname, payload);
		sendJson(
			res,
			body ? 200 : 404,
			body ?? { ok: false, error: "unknown path" },
		);
	} catch (error) {
		sendJson(res, 500, {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const main = (): void => {
	http
		.createServer((req, res) => void onRequest(req, res))
		.listen(PORT, "127.0.0.1", () =>
			console.log(
				`remodel API on http://127.0.0.1:${PORT}  (/describe, /remodel)`,
			),
		);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
