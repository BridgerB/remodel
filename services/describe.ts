#!/usr/bin/env node
// image -> text house description via local gemma3:27b (Ollama on :11435).
//
// Smart model lifecycle (no fixed timeout):
//   - one image   -> load, run, unload (frees ~19GB)
//   - many images -> load ONCE, run them all warm, unload after the last
// Force a warm window with REMODEL_KEEP_ALIVE (e.g. "5m").
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OLLAMA_URL = "http://127.0.0.1:11435/api/generate";
export const MODEL = "gemma3:27b";
const OUT_DIR = path.join(process.env.REMODEL_DATA ?? process.cwd(), "out");
const IMG_EXT = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"] as const;

export interface HouseDescription {
	readonly architectural_style: string;
	readonly structure_type: string;
	readonly stories_or_levels: string;
	readonly exterior_materials: readonly string[];
	readonly roof: string;
	readonly windows_and_doors: string;
	readonly garage: string;
	readonly driveway_landscaping_lawn: string;
	readonly approximate_era: string;
	readonly overall_condition: string;
	readonly notable_features: readonly string[];
	readonly defects: readonly string[];
	readonly full_description: string;
}

export interface DescribeResult {
	readonly seconds: number;
	readonly result: HouseDescription | { readonly full_description: string };
}

export interface DescribeRecord {
	readonly ok: boolean;
	readonly image: string;
	readonly model?: string;
	readonly seconds?: number;
	readonly result?: DescribeResult["result"];
	readonly error?: string;
}

export const PROMPT =
	"You are an expert real-estate appraiser. Look at this house photo and fill in the JSON " +
	"accurately based ONLY on what is visible. Be specific about architectural style, structure " +
	"type, levels, exterior materials, roof, windows/doors, garage, driveway/landscaping, the " +
	"approximate era, overall condition, notable features, and any visible defects. The " +
	"full_description field should be a thorough paragraph. Do not invent details you cannot see.";

const STRING = { type: "string" } as const;
const STRING_ARRAY = { type: "array", items: STRING } as const;
const SCHEMA = {
	type: "object",
	properties: {
		architectural_style: STRING,
		structure_type: STRING,
		stories_or_levels: STRING,
		exterior_materials: STRING_ARRAY,
		roof: STRING,
		windows_and_doors: STRING,
		garage: STRING,
		driveway_landscaping_lawn: STRING,
		approximate_era: STRING,
		overall_condition: STRING,
		notable_features: STRING_ARRAY,
		defects: STRING_ARRAY,
		full_description: STRING,
	},
	required: [
		"architectural_style",
		"structure_type",
		"stories_or_levels",
		"exterior_materials",
		"roof",
		"windows_and_doors",
		"garage",
		"driveway_landscaping_lawn",
		"approximate_era",
		"overall_condition",
		"notable_features",
		"defects",
		"full_description",
	],
} as const;

// ---- pure ----
const isImage = (file: string): boolean =>
	IMG_EXT.some((ext) => file.toLowerCase().endsWith(ext));

const stem = (spec: string): string =>
	path.basename(spec.split("?")[0] ?? spec).replace(/\.[^.]*$/, "");

const planKeepAlive = (
	index: number,
	total: number,
	forced: string | undefined,
): string => forced ?? (index === total - 1 ? "0" : "5m");

const requestBody = (
	imgBase64: string,
	prompt: string,
	keepAlive: string,
): string =>
	JSON.stringify({
		model: MODEL,
		prompt,
		images: [imgBase64],
		format: SCHEMA,
		stream: false,
		keep_alive: keepAlive,
		options: { temperature: 0.1, num_ctx: 4096 },
	});

const parseResponse = (raw: string): DescribeResult["result"] => {
	try {
		return JSON.parse(raw) as HouseDescription;
	} catch {
		return { full_description: raw };
	}
};

// ---- io ----
const loadBase64 = async (spec: string): Promise<string> => {
	const bytes = spec.startsWith("http")
		? Buffer.from(await (await fetch(spec)).arrayBuffer())
		: readFileSync(spec);
	return bytes.toString("base64");
};

const collectImages = (
	positionals: readonly string[],
	images: readonly string[],
	dir: string | undefined,
): readonly string[] => {
	const fromDir = dir
		? readdirSync(dir)
				.filter(isImage)
				.sort()
				.map((file) => path.join(dir, file))
		: [];
	return [...positionals, ...images, ...fromDir];
};

const writeRecord = (record: DescribeRecord): void => {
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		path.join(OUT_DIR, `desc_${stem(record.image)}.json`),
		JSON.stringify(record, null, 2),
	);
};

export const describeOne = async (
	imgBase64: string,
	keepAlive: string,
	prompt: string = PROMPT,
): Promise<DescribeResult> => {
	const startedAt = Date.now();
	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: requestBody(imgBase64, prompt, keepAlive),
	});
	const json = (await res.json()) as { response?: string };
	return {
		seconds: Math.round((Date.now() - startedAt) / 100) / 10,
		result: parseResponse(json.response ?? ""),
	};
};

const describeImage = async (
	spec: string,
	keepAlive: string,
	prompt: string,
): Promise<DescribeRecord> => {
	try {
		const { seconds, result } = await describeOne(
			await loadBase64(spec),
			keepAlive,
			prompt,
		);
		return { ok: true, image: spec, model: MODEL, seconds, result };
	} catch (error) {
		return {
			ok: false,
			image: spec,
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

const describeAll = (
	images: readonly string[],
	prompt: string,
	forced: string | undefined,
): Promise<readonly DescribeRecord[]> =>
	images.reduce<Promise<readonly DescribeRecord[]>>(
		async (prev, spec, index) => {
			const done = await prev;
			const keepAlive = planKeepAlive(index, images.length, forced);
			console.error(
				`[${index + 1}/${images.length}] ${spec}  (keep_alive=${keepAlive})`,
			);
			const record = await describeImage(spec, keepAlive, prompt);
			writeRecord(record);
			return [...done, record];
		},
		Promise.resolve([]),
	);

const main = async (): Promise<void> => {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			image: { type: "string", multiple: true, default: [] },
			dir: { type: "string" },
			prompt: { type: "string", default: PROMPT },
		},
	});
	const images = collectImages(positionals, values.image, values.dir);
	if (images.length === 0) {
		console.error("ERROR: give at least one image (path/url) or --dir");
		process.exit(2);
	}
	const records = await describeAll(
		images,
		values.prompt,
		process.env.REMODEL_KEEP_ALIVE,
	);
	console.log(
		JSON.stringify(records.length === 1 ? records[0] : records, null, 2),
	);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
