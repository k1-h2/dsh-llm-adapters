import path, { dirname, join } from "node:path";
import { LlmAdapter, attributionHeaders, offloadedImageText, requestImageHandleText } from "@deepseek-ai/dsh-llm";
import { existsSync, mkdirSync, mkdtempSync, promises, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { isVolatile } from "@deepseek-ai/cosmokit";
import z from "@deepseek-ai/schemastery";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
// src/model-name.ts
/**
* Shared model-name rules for every provider.
*
* Upstream catalogs are inconsistent: Loomy embeds the multiplier and promo
* text in parentheses, Raccoon writes `GLM-5-3` where the product is `GLM 5.3`,
* and both mix full-width and half-width punctuation. The settings page wants a
* clean product name, a price badge and a few labels, and OpenRouter matching
* wants a stable comparison key — so all of that is derived here instead of
* being special-cased per provider.
*
* @module dsh-llm-adapters/model-name
*/
const BRACKET_PATTERN = /[(（]([^()（）]*)[)）]/g;
const MULTIPLIER_PATTERN = /^(?:[x×]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*倍)$/i;
/** `x3.0`, `× 0.1`, `3倍`, optionally inside parentheses or after a space. */
function priceFactorOf(text) {
	const match = /(?:^|[\s·(（])(?:[x×]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*倍)/i.exec(text);
	if (match === null) return void 0;
	const value = Number(match[1] ?? match[2]);
	return Number.isFinite(value) ? value : void 0;
}
/** A bracket that contains nothing but a multiplier is a price, not a label. */
function multiplierOf(text) {
	const match = MULTIPLIER_PATTERN.exec(text.trim());
	if (match === null) return void 0;
	const value = Number(match[1] ?? match[2]);
	return Number.isFinite(value) ? value : void 0;
}
function normalizeSeparators(value) {
	return value.replace(/(\d)\s*-\s*(\d)/g, "$1.$2").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}
/**
* Normalize one upstream display name.
*
* - `(x0.0)` / `（x0.8）` is the price, so it is removed from the name instead
*   of being repeated there; the settings page renders it after the labels.
* - Any other bracket content becomes a label (`(限时免费)` → `限时免费`), so it
*   can sit next to the 读图 / 思考 tags.
* - Hyphens between digits become dots (`GLM-5-3` → `GLM 5.3`); other hyphens
*   become spaces (`Kimi-K3` → `Kimi K3`).
*/
function parseModelName(raw) {
	const labels = [];
	let priceFactor;
	for (const match of raw.matchAll(BRACKET_PATTERN)) {
		const content = match[1].trim();
		if (content.length === 0) continue;
		const price = multiplierOf(content);
		if (price !== void 0) {
			if (priceFactor === void 0) priceFactor = price;
			continue;
		}
		if (!labels.includes(content)) labels.push(content);
	}
	return {
		name: normalizeSeparators(raw.replace(BRACKET_PATTERN, " ")) || normalizeSeparators(raw),
		labels,
		...priceFactor === void 0 ? {} : { priceFactor }
	};
}
/** Comparison key shared by upstream names, upstream ids and OpenRouter. */
function modelKey(value) {
	return parseModelName(value).name.toLowerCase().replace(/^sn\s+/, "").replace(/[^a-z0-9]/g, "");
}
// src/catalog.ts
/**
* Provider-neutral model rows plus the two upstream catalog parsers.
*
* The settings page needs more than `LlmModelInfo` (vision, context, multiplier,
* labels), so adapters keep this shape internally and project it down to the
* harness on `listModels`/`resolveModel`.
*
* Capability rules are shared by both providers: match the normalized name
* against OpenRouter first, fall back to the upstream declaration, and expose
* every effort/modality when neither source says anything. No model is
* special-cased.
*
* @module dsh-llm-adapters/catalog
*/
/** Every level the shared fallback exposes when no source knows the model. */
const ALL_REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
const ALL_INPUT_MODALITIES = ["text", "image"];
const NO_MODELS = [];
/** Largest number found under one of `keys`, ignoring nested unrelated data. */
function numberField$1(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
		if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	}
}
function stringField$1(record, keys) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
}
function stringArray(value) {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry : void 0).filter((entry) => entry !== void 0);
}
function recordOf$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
/** Display label for one effort id: `None`, `Low`, `High`, `Max`; `xhigh` stays as vendors spell it. */
function effortLabel(effort) {
	return effort === "xhigh" ? effort : `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}
/** Strength rank of an effort id; unknown ids rank below every known one. */
function effortRank(effort) {
	return ALL_REASONING_EFFORTS.indexOf(effort);
}
/**
* The default level: second strongest of the supported list.
*
* Starting one step below the top gives a useful reasoning budget whenever the
* user switches models, without silently paying for the most expensive tier —
* and without starting at `none`, which makes a reasoning model look broken.
*/
function defaultEffortOf(efforts) {
	if (efforts.length === 0) return void 0;
	const ranked = [...efforts].sort((a, b) => effortRank(a) - effortRank(b));
	return ranked[Math.max(0, ranked.length - 2)];
}
function effortsOf$1(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) if (typeof entry === "string" && entry.trim().length > 0) out.push(entry.trim());
	else if (entry !== null && typeof entry === "object") {
		const id = stringField$1(entry, [
			"value",
			"id",
			"name"
		]);
		if (id !== void 0) out.push(id);
	}
	return [...new Set(out)];
}
/**
* Resolve one model's efforts and modalities from the two allowed sources.
*
* 1. Live OpenRouter metadata wins when it carries the field.
* 2. Otherwise the upstream declaration (`reasoning_efforts`, `input_modalities`,
*    `vision`, tags) is used.
* 3. When neither says anything, every effort and both modalities are exposed.
*/
function resolveCapabilities(input) {
	const liveEfforts = input.live?.efforts ?? [];
	const upstreamEfforts = input.upstreamEfforts ?? [];
	const efforts = liveEfforts.length > 0 ? liveEfforts : upstreamEfforts.length > 0 ? upstreamEfforts : input.upstreamReasoning === false ? [] : ALL_REASONING_EFFORTS;
	const defaultEffort = defaultEffortOf(efforts);
	const liveModalities = input.live?.inputModalities ?? [];
	const upstreamModalities = input.upstreamModalities ?? [];
	const modalities = liveModalities.length > 0 ? liveModalities : upstreamModalities.length > 0 ? upstreamModalities : ALL_INPUT_MODALITIES;
	return {
		efforts,
		...defaultEffort === void 0 ? {} : { defaultEffort },
		modalities
	};
}
function visionFrom(input) {
	if (input.textOnly.has(input.id)) return false;
	if (input.forceVision.has(input.id)) return true;
	return input.modalities.some((mode) => mode.toLowerCase() === "image");
}
function loomyUpstreamModalities(capabilities) {
	const declared = stringArray(capabilities.input_modalities ?? capabilities.inputModalities);
	if (declared.length > 0) return declared;
	if (capabilities.vision === true) return ALL_INPUT_MODALITIES;
	if (capabilities.vision === false) return ["text"];
}
function raccoonUpstreamModalities(tags) {
	if (tags.length === 0) return void 0;
	return tags.map((tag) => tag.toLowerCase()).some((tag) => tag === "vision" || tag === "image" || tag === "image-understanding" || tag === "image_input") ? ALL_INPUT_MODALITIES : ["text"];
}
/**
* Parse Loomy's `/models` response.
*
* The upstream returns an OpenAI-style list but varies whether the array sits
* at `data`, `models`, or `data.models`; the multiplier and promo text are
* embedded in the display name rather than in structured fields.
*/
function parseLoomyCatalog(payload, options = {}) {
	const root = recordOf$1(payload);
	const data = recordOf$1(root.data);
	const candidates = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : Array.isArray(data.models) ? data.models : [];
	const textOnly = options.textOnly ?? /* @__PURE__ */ new Set();
	const forceVision = options.forceVision ?? /* @__PURE__ */ new Set();
	const out = [];
	for (const candidate of candidates) {
		const record = recordOf$1(candidate);
		const id = stringField$1(record, [
			"id",
			"model",
			"modelId"
		]);
		if (id === void 0) continue;
		const parsed = parseModelName(stringField$1(record, [
			"display_name",
			"displayName",
			"name",
			"label"
		]) ?? id);
		const description = stringField$1(record, ["description", "desc"]);
		const capabilities = recordOf$1(record.capabilities);
		const tags = stringArray(record.tags);
		const live = options.openRouter?.match(parsed.name, id);
		const resolved = resolveCapabilities({
			live,
			upstreamEfforts: effortsOf$1(record.reasoning_efforts ?? record.reasoningEfforts),
			upstreamReasoning: typeof capabilities.reasoning === "boolean" ? capabilities.reasoning : void 0,
			upstreamModalities: loomyUpstreamModalities(capabilities)
		});
		out.push({
			id,
			name: parsed.name || id,
			...description === void 0 ? {} : { description },
			...parsed.labels.length === 0 ? {} : { labels: parsed.labels },
			contextWindow: numberField$1(record, [
				"context_length",
				"context_window",
				"contextWindow",
				"max_context_length"
			]) ?? 2e5,
			...numberField$1(record, [
				"max_output_tokens",
				"max_tokens",
				"maxTokens",
				"max_output_length"
			]) === void 0 ? {} : { maxTokens: numberField$1(record, [
				"max_output_tokens",
				"max_tokens",
				"maxTokens",
				"max_output_length"
			]) },
			vision: visionFrom({
				modalities: resolved.modalities,
				textOnly,
				forceVision,
				id
			}),
			reasoning: resolved.efforts.length > 0,
			...resolved.efforts.length === 0 ? {} : { reasoningEfforts: resolved.efforts },
			...resolved.defaultEffort === void 0 ? {} : { defaultReasoningEffort: resolved.defaultEffort },
			...parsed.priceFactor === void 0 ? {} : { priceFactor: parsed.priceFactor },
			...tags.length === 0 ? {} : { tags }
		});
	}
	return out;
}
function raccoonBadge(record) {
	const status = stringField$1(record, ["billing_status"]);
	const note = stringField$1(record, ["billing_status_note"]);
	if (note !== void 0) return note;
	if (status === "limited_free") return "限免";
	if (status === "discount") return "折扣";
}
/**
* Parse Raccoon's `model_catalog` response.
*
* Only `categories[type=chat]` is relevant. The catalogue's `name` is both the
* model id and the value the completion endpoint accepts; the human label comes
* from `description` (the product name), while `display_description` is a
* workload sentence shown as the description.
*/
function parseRaccoonCatalog(payload, options = {}) {
	const data = recordOf$1(recordOf$1(payload).data);
	const chat = (Array.isArray(data.categories) ? data.categories : []).map(recordOf$1).find((category) => category.type === "chat");
	const candidates = Array.isArray(chat?.models) ? chat.models : [];
	const textOnly = options.textOnly ?? /* @__PURE__ */ new Set();
	const forceVision = options.forceVision ?? /* @__PURE__ */ new Set();
	const out = [];
	for (const candidate of candidates) {
		const record = recordOf$1(candidate);
		const id = stringField$1(record, [
			"name",
			"id",
			"model"
		]);
		if (id === void 0 || id === "raccoon-work") continue;
		if (record.visible === false) continue;
		const params = recordOf$1(record.params);
		const tags = stringArray(record.tags);
		const parsed = parseModelName(stringField$1(record, [
			"description",
			"display_name",
			"model_name"
		]) ?? id);
		const display = stringField$1(record, ["display_description", "displayDescription"]);
		const description = display === void 0 || display === parsed.name ? void 0 : display;
		const live = options.openRouter?.match(parsed.name, id);
		const resolved = resolveCapabilities({
			live,
			upstreamEfforts: effortsOf$1(record.reasoning_efforts ?? record.reasoningEfforts),
			upstreamModalities: raccoonUpstreamModalities(tags)
		});
		const base = billingMultiplier(record);
		out.push({
			id,
			name: parsed.name || id,
			...description === void 0 ? {} : { description },
			...parsed.labels.length === 0 ? {} : { labels: parsed.labels },
			contextWindow: numberField$1(params, ["context_window", "contextWindow"]) ?? 2e5,
			...numberField$1(params, ["max_tokens", "maxTokens"]) === void 0 ? {} : { maxTokens: numberField$1(params, ["max_tokens", "maxTokens"]) },
			vision: visionFrom({
				modalities: resolved.modalities,
				textOnly,
				forceVision,
				id
			}),
			reasoning: resolved.efforts.length > 0,
			...resolved.efforts.length === 0 ? {} : { reasoningEfforts: resolved.efforts },
			...resolved.defaultEffort === void 0 ? {} : { defaultReasoningEffort: resolved.defaultEffort },
			...base === void 0 ? {} : { priceFactor: base },
			...raccoonBadge(record) === void 0 ? {} : { badge: raccoonBadge(record) },
			...tags.length === 0 ? {} : { tags }
		});
	}
	return out;
}
function billingMultiplier(record) {
	const effective = record.billing_effective_multiplier;
	if (typeof effective === "number" && Number.isFinite(effective) && effective >= 0) return effective;
	const base = record.billing_multiplier;
	return typeof base === "number" && Number.isFinite(base) && base >= 0 ? base : void 0;
}
/**
* A small stale-while-error cache.
*
* A failed refresh keeps the last successful list and reports the failure
* separately, so a transient network error does not make every model vanish
* from the picker. `fresh` always bypasses the TTL.
*/
var ModelCatalog = class {
	load;
	ttlMs;
	snapshot;
	lastError;
	inflight;
	constructor(load, ttlMs) {
		this.load = load;
		this.ttlMs = ttlMs;
	}
	async models(fresh = false) {
		if (!fresh && this.snapshot !== void 0 && Date.now() - this.snapshot.at < this.ttlMs()) return this.snapshot.models;
		if (this.inflight !== void 0) return this.inflight;
		this.inflight = (async () => {
			try {
				const models = await this.load();
				this.snapshot = {
					models,
					at: Date.now()
				};
				this.lastError = void 0;
				return models;
			} catch (error) {
				this.lastError = error instanceof Error ? error.message : String(error);
				return this.snapshot?.models ?? NO_MODELS;
			} finally {
				this.inflight = void 0;
			}
		})();
		return this.inflight;
	}
	error() {
		return this.lastError;
	}
	invalidate() {
		this.snapshot = void 0;
		this.lastError = void 0;
		this.inflight = void 0;
	}
};
// src/adapter.ts
/**
* Harness adapter for the browser-signed-in providers.
*
* One instance owns one provider route and its catalog, credential reader and
* user choices. The concrete subclasses differ only in which client they hold.
*
* @module dsh-llm-adapters/adapter
*/
function modelInfo(provider, model) {
	return {
		provider,
		id: model.id,
		name: model.name,
		...model.description === void 0 ? {} : { description: model.description },
		inputModalities: model.vision ? ["text", "image"] : ["text"]
	};
}
var LocalAdapter = class extends LlmAdapter {
	options;
	client;
	/**
	* Last verified image capability per model id.
	*
	* A missed catalog read used to fall back to text-only, and DSH then strips
	* the pixels before this adapter ever runs: a vision model silently lost the
	* image for that turn. Remembering the last answer keeps the declared
	* capability stable across a transient miss.
	*/
	knownVision = /* @__PURE__ */ new Map();
	constructor(options, client) {
		super();
		this.options = options;
		this.client = client;
	}
	get brand() {
		return this.options.brand;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.options.displayName()
		};
	}
	/** The live catalog including switched-off models; the settings page shows those. */
	async describeCatalog() {
		if (!await this.client.signedIn()) return [];
		const models = await this.client.models();
		for (const model of models) this.knownVision.set(model.id, model.vision);
		return models;
	}
	async isSignedIn() {
		return this.client.signedIn();
	}
	async catalogError() {
		if (!await this.client.signedIn()) return (await this.client.status()).error ?? "尚未登录。请在设置页点「打开扫码登录」。";
		return this.client.catalogError();
	}
	async logoutAccount() {
		await this.client.logoutAccount();
	}
	/**
	* Start the sign-in flow and return its first status.
	*
	* Loomy and Raccoon serve a local QR page (`url`), Trae opens its own browser
	* window; `region` only matters to Trae and is ignored by the others.
	*/
	startBrowserLogin(region) {
		return this.client.startBrowserLogin(region);
	}
	browserLoginStatus() {
		return this.client.browserLoginStatus();
	}
	cancelBrowserLogin() {
		return this.client.cancelBrowserLogin();
	}
	/** Claim today's reward; providers without one reject it. */
	async claimCheckin() {
		if (this.client.claimCheckin === void 0) throw new Error("该供应商没有签到活动");
		const result = await this.client.claimCheckin();
		this.invalidateUsage();
		return result;
	}
	invalidateCatalog() {
		this.client.invalidateModels();
	}
	invalidateUsage() {
		this.client.invalidateQuota();
	}
	/** Login state plus quota, shaped for the settings page. */
	async usageInfo(fresh = false) {
		const auth = await this.client.status();
		const base = {
			brand: this.brand,
			...auth
		};
		const checkin = this.client.checkinStatus === void 0 ? void 0 : await this.client.checkinStatus().catch(() => void 0);
		const withCheckin = checkin === void 0 ? base : {
			...base,
			checkin
		};
		if (!auth.signedIn) return withCheckin;
		try {
			return {
				...withCheckin,
				quota: await this.client.quota(fresh)
			};
		} catch (error) {
			return {
				...withCheckin,
				quotaError: error instanceof Error ? error.message : String(error)
			};
		}
	}
	isModelDisabled(id) {
		const folded = modelKey(id);
		return this.options.disabledModels().some((entry) => entry === id || modelKey(entry) === folded);
	}
	contextWindowFor(id) {
		const table = this.options.modelContextWindows();
		const direct = table[id] ?? table[id.trim().toLowerCase()];
		if (direct !== void 0) return direct;
		const folded = modelKey(id);
		if (folded.length === 0) return void 0;
		for (const key of Object.keys(table)) if (modelKey(key) === folded) return table[key];
	}
	/**
	* The catalogue row one harness-side id means.
	*
	* Exact id first. Then the folded comparison, because the picker may hand back
	* the display name (`DeepSeek-V4.1-Flash`) or a re-spelling the upstream changed
	* between rosters; a miss here silently dropped both the window and the
	* reasoning levels, so a model that costs 1M tokens ran as if it had 200K.
	*/
	findModel(models, id) {
		const exact = models.find((entry) => entry.id === id);
		if (exact !== void 0) return exact;
		const folded = modelKey(id);
		if (folded.length === 0) return void 0;
		return models.find((entry) => modelKey(entry.id) === folded || modelKey(entry.name) === folded);
	}
	async listModels(provider) {
		if (!await this.client.signedIn()) return [];
		const disabled = new Set(this.options.disabledModels());
		const models = await this.client.models();
		for (const model of models) this.knownVision.set(model.id, model.vision);
		const seen = /* @__PURE__ */ new Set();
		const out = [];
		for (const model of models) {
			const key = model.id.toLowerCase();
			if (seen.has(key) || disabled.has(model.id)) continue;
			seen.add(key);
			out.push(modelInfo(provider, model));
		}
		return out;
	}
	async resolveModel(provider, model) {
		const target = resolveModelId(model, this.options.modelAliases());
		const live = this.findModel(await this.client.models(), target);
		if (live !== void 0) this.knownVision.set(target, live.vision);
		const vision = live === void 0 ? this.knownVision.get(target) === true : live.vision;
		const contextWindow = this.contextWindowFor(target) ?? live?.contextWindow ?? 2e5;
		const maxTokens = live?.maxTokens ?? this.options.defaultMaxTokens();
		return {
			provider,
			id: model,
			name: live?.name ?? target,
			...live?.description === void 0 ? {} : { description: live.description },
			inputModalities: vision ? ["text", "image"] : ["text"],
			context: { contextWindow },
			defaultMaxTokens: Math.max(1, Math.floor(maxTokens)),
			...live?.reasoningEfforts === void 0 || live.reasoningEfforts.length === 0 ? {} : { reasoning: {
				efforts: live.reasoningEfforts.map((effort) => ({
					id: effort,
					name: effortLabel(effort)
				})),
				...live.defaultReasoningEffort === void 0 ? {} : { defaultEffort: live.defaultReasoningEffort }
			} }
		};
	}
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model),
			stream: (options) => this.stream(options)
		};
	}
	async *stream(options) {
		if (!await this.client.signedIn()) {
			const status = await this.client.status();
			throw new Error(status.error ?? "尚未登录。请在设置页点「打开扫码登录」。");
		}
		const model = resolveModelId(options.model, this.options.modelAliases());
		const live = this.findModel(await this.client.models(), model);
		const maxTokens = options.maxTokens ?? live?.maxTokens ?? this.options.defaultMaxTokens();
		const request = {
			...options,
			maxTokens: Math.max(1, Math.floor(maxTokens))
		};
		yield* this.client.stream(request, model, this.options.readImage, () => {
			this.invalidateCatalog();
			this.invalidateUsage();
		});
	}
	close() {
		this.client.close();
	}
};
/** Loomy route. */
var LoomyAdapter = class extends LocalAdapter {
	constructor(options, loomy) {
		super(options, loomy);
	}
};
/** SenseTime Raccoon route. */
var RaccoonAdapter = class extends LocalAdapter {
	constructor(options, raccoon) {
		super(options, raccoon);
	}
};
/** Trae route; one route serves both regions, chosen by the saved region. */
var TraeAdapter = class extends LocalAdapter {
	constructor(options, trae) {
		super(options, trae);
	}
};
/** CodeArts route; signed requests instead of a bearer token. */
var CodeArtsAdapter = class extends LocalAdapter {
	constructor(options, codearts) {
		super(options, codearts);
	}
};
/** Map a harness-side alias onto the upstream id. */
function resolveModelId(model, aliases) {
	const configured = aliases[model] ?? aliases[model.toLowerCase()];
	if (configured !== void 0 && configured.length > 0) return configured;
	return model;
}
// src/brand.ts
const LOOMY_PROVIDER = "loomy";
const RACCOON_PROVIDER = "raccoon";
const TRAE_PROVIDER = "trae";
const CODEARTS_PROVIDER = "codearts";
const LOOMY_BRAND = {
	id: "loomy",
	provider: LOOMY_PROVIDER,
	defaultDisplayName: "Loomy",
	enabledKey: "loomyEnabled"
};
const RACCOON_BRAND = {
	id: "raccoon",
	provider: RACCOON_PROVIDER,
	defaultDisplayName: "商汤小浣熊",
	enabledKey: "raccoonEnabled"
};
const TRAE_BRAND = {
	id: "trae",
	provider: TRAE_PROVIDER,
	defaultDisplayName: "Trae",
	enabledKey: "traeEnabled"
};
const CODEARTS_BRAND = {
	id: "codearts",
	provider: CODEARTS_PROVIDER,
	defaultDisplayName: "华为云 CodeArts",
	enabledKey: "codeartsEnabled"
};
const BRANDS = [
	LOOMY_BRAND,
	RACCOON_BRAND,
	TRAE_BRAND,
	CODEARTS_BRAND
];
function isBrandId(value) {
	return value === "loomy" || value === "raccoon" || value === "trae" || value === "codearts";
}
/** Normalize any stored spelling to one of the two Trae regions. */
function normalizeTraeRegion(value) {
	return value === "global" ? "global" : "cn";
}
// src/account-store.ts
/**
* Plugin-owned credentials for account login.
*
* Sign-in happens in the provider's own web page. The resulting session or
* token is stored here — the only credential source. The file is written
* atomically and restricted to the current user; tokens are never logged or
* returned to the browser.
*
* Trae keeps one account per region: switching regions must restore that
* region's own login instead of overwriting the other one.
*
* @module dsh-llm-adapters/account-store
*/
const FILE_NAME = "accounts.json";
function defaultRoot() {
	const configured = process.env.DSH_LLM_ADAPTERS_HOME?.trim();
	if (configured !== void 0 && configured !== "") return path.resolve(configured);
	const dshHome = process.env.DSH_HOME?.trim();
	const base = dshHome !== void 0 && dshHome !== "" ? dshHome : path.join(homedir(), ".dsh");
	return path.join(base, "llm-adapters");
}
function record$4(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text$4(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function number(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function traeRecord(value, region) {
	const raw = record$4(value);
	const accessToken = text$4(raw?.accessToken);
	if (raw === void 0 || accessToken === void 0) return void 0;
	return {
		accessToken,
		region,
		deviceId: text$4(raw.deviceId) ?? `web-${randomBytes(8).toString("hex")}`,
		machineId: text$4(raw.machineId) ?? `web-${randomBytes(16).toString("hex")}`,
		loginAt: number(raw.loginAt) ?? Date.now(),
		...text$4(raw.userId) === void 0 ? {} : { userId: text$4(raw.userId) },
		...text$4(raw.name) === void 0 ? {} : { name: text$4(raw.name) },
		...number(raw.expiresAt) === void 0 ? {} : { expiresAt: number(raw.expiresAt) },
		...text$4(raw.cookies) === void 0 ? {} : { cookies: text$4(raw.cookies) },
		...number(raw.sessionExpiresAt) === void 0 ? {} : { sessionExpiresAt: number(raw.sessionExpiresAt) }
	};
}
function codeartsRecord(value) {
	const raw = record$4(value);
	const accessKeyId = text$4(raw?.accessKeyId);
	const secretAccessKey = text$4(raw?.secretAccessKey);
	const securityToken = text$4(raw?.securityToken);
	if (raw === void 0 || accessKeyId === void 0 || secretAccessKey === void 0 || securityToken === void 0) return;
	const jwk = record$4(raw.dpopPrivateJwk);
	const key = jwk !== void 0 && text$4(jwk.x) !== void 0 && text$4(jwk.y) !== void 0 && text$4(jwk.d) !== void 0 ? {
		kty: "EC",
		crv: "P-256",
		x: text$4(jwk.x),
		y: text$4(jwk.y),
		d: text$4(jwk.d)
	} : void 0;
	const noBenefit = Array.isArray(raw.noBenefit) ? raw.noBenefit.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()) : [];
	return {
		accessKeyId,
		secretAccessKey,
		securityToken,
		loginAt: number(raw.loginAt) ?? Date.now(),
		...number(raw.expiresAt) === void 0 ? {} : { expiresAt: number(raw.expiresAt) },
		...text$4(raw.refreshToken) === void 0 ? {} : { refreshToken: text$4(raw.refreshToken) },
		...text$4(raw.codeVerifier) === void 0 ? {} : { codeVerifier: text$4(raw.codeVerifier) },
		...key === void 0 ? {} : { dpopPrivateJwk: key },
		...text$4(raw.userName) === void 0 ? {} : { userName: text$4(raw.userName) },
		...noBenefit.length === 0 ? {} : { noBenefit }
	};
}
var AccountStore = class {
	root;
	writeChain = Promise.resolve();
	constructor(root = defaultRoot) {
		this.root = root;
	}
	path() {
		return path.join(this.root(), FILE_NAME);
	}
	/** The plugin's own data directory (also holds the OpenRouter snapshot). */
	directory() {
		return this.root();
	}
	async read() {
		let parsed;
		try {
			parsed = JSON.parse(await promises.readFile(this.path(), "utf8"));
		} catch {
			return {};
		}
		const raw = record$4(parsed);
		if (raw === void 0) return {};
		const out = {};
		const loomy = record$4(raw.loomy);
		const loomySession = text$4(loomy?.session);
		if (loomySession !== void 0) out.loomy = {
			session: loomySession,
			deviceId: text$4(loomy?.deviceId) ?? `web-${randomBytes(8).toString("hex")}`,
			loginAt: number(loomy?.loginAt) ?? Date.now(),
			expiresAt: number(loomy?.expiresAt) ?? Date.now(),
			...text$4(loomy?.userId) === void 0 ? {} : { userId: text$4(loomy?.userId) },
			...text$4(loomy?.phone) === void 0 ? {} : { phone: text$4(loomy?.phone) },
			...text$4(loomy?.name) === void 0 ? {} : { name: text$4(loomy?.name) }
		};
		const raccoon = record$4(raw.raccoon);
		const access = text$4(raccoon?.accessToken);
		if (access !== void 0) out.raccoon = {
			accessToken: access,
			loginAt: number(raccoon?.loginAt) ?? Date.now(),
			...text$4(raccoon?.phone) === void 0 ? {} : { phone: text$4(raccoon?.phone) },
			...text$4(raccoon?.name) === void 0 ? {} : { name: text$4(raccoon?.name) },
			...text$4(raccoon?.ownerType) === void 0 ? {} : { ownerType: text$4(raccoon?.ownerType) }
		};
		const trae = record$4(raw.trae);
		if (trae !== void 0) {
			const cn = traeRecord(trae.cn, "cn");
			const global = traeRecord(trae.global, "global");
			if (cn !== void 0 || global !== void 0) out.trae = {
				...cn === void 0 ? {} : { cn },
				...global === void 0 ? {} : { global }
			};
		}
		const codearts = codeartsRecord(raw.codearts);
		if (codearts !== void 0) out.codearts = codearts;
		return out;
	}
	async loomy() {
		return (await this.read()).loomy;
	}
	async raccoon() {
		return (await this.read()).raccoon;
	}
	async trae(region) {
		return (await this.read()).trae?.[normalizeTraeRegion(region)];
	}
	async codearts() {
		return (await this.read()).codearts;
	}
	async saveLoomy(record) {
		await this.update((current) => ({
			...current,
			loomy: record
		}));
	}
	async saveRaccoon(record) {
		await this.update((current) => ({
			...current,
			raccoon: record
		}));
	}
	async saveTrae(record) {
		const region = normalizeTraeRegion(record.region);
		await this.update((current) => ({
			...current,
			trae: {
				...current.trae ?? {},
				[region]: {
					...record,
					region
				}
			}
		}));
	}
	async saveCodearts(record) {
		await this.update((current) => ({
			...current,
			codearts: record
		}));
	}
	async clear(brand, region) {
		await this.update((current) => {
			const next = { ...current };
			if (brand === "trae") {
				if (region === void 0) {
					delete next.trae;
					return next;
				}
				const accounts = { ...next.trae ?? {} };
				delete accounts[normalizeTraeRegion(region)];
				if (Object.keys(accounts).length === 0) delete next.trae;
				else next.trae = accounts;
				return next;
			}
			if (brand === "loomy") delete next.loomy;
			else if (brand === "raccoon") delete next.raccoon;
			else delete next.codearts;
			return next;
		});
	}
	/**
	* A device id for the Loomy account service.
	*
	* Generated once and reused, so an account keeps looking like one device
	* across logins; `traceid` remains per-request.
	*/
	async loomyDeviceId() {
		return (await this.loomy())?.deviceId ?? `web-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	}
	/**
	* Read-modify-write inside the write queue.
	*
	* The read has to happen there too: a token refresh and a login landing at
	* the same time would otherwise both read the same old file and the second
	* write would drop the first one's brand.
	*/
	async update(mutator) {
		this.writeChain = this.writeChain.then(async () => {
			const current = await this.read();
			await this.writeFile(mutator(current));
		}, () => void 0);
		await this.writeChain;
	}
	async writeFile(next) {
		const file = this.path();
		const body = `${JSON.stringify(next, null, 2)}\n`;
		await promises.mkdir(path.dirname(file), { recursive: true });
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		await promises.writeFile(temp, body, {
			encoding: "utf8",
			mode: 384
		});
		await promises.rename(temp, file);
	}
};
// src/api.ts
const API_PREFIX = "/api/llm-adapters";
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
const WINDOW_CHOICES = [
	32e3,
	64e3,
	128e3,
	2e5,
	256e3,
	4e5,
	5e5,
	1e6
];
/** The same label the settings page prints, so two sizes never read alike. */
function windowLabel(value) {
	if (value >= 1e6) return `${Number((value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1))}M`;
	if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
	return String(value);
}
async function buildRows(adapter) {
	return (await adapter.describeCatalog()).map((model) => {
		const override = adapter.contextWindowFor(model.id);
		const explicit = [model.contextWindow];
		if (model.maxContextWindow !== void 0 && model.maxContextWindow > model.contextWindow) {
			if (model.maxContextWindow >= 5e5 && 5e5 > model.contextWindow) explicit.push(5e5);
			explicit.push(model.maxContextWindow);
		}
		if (override !== void 0) explicit.push(override);
		const labels = new Set(explicit.map(windowLabel));
		const choices = new Set(explicit);
		for (const choice of WINDOW_CHOICES) if (choice < model.contextWindow && !labels.has(windowLabel(choice))) choices.add(choice);
		return {
			id: model.id,
			name: model.name,
			...model.description === void 0 ? {} : { description: model.description },
			...model.labels === void 0 ? {} : { labels: model.labels },
			enabled: !adapter.isModelDisabled(model.id),
			vision: model.vision,
			contextWindow: override ?? model.contextWindow,
			...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
			contextWindows: [...choices].sort((a, b) => a - b),
			defaultContextWindow: model.contextWindow,
			...override === void 0 ? {} : { override },
			...model.priceFactor === void 0 ? {} : { priceFactor: model.priceFactor },
			...model.badge === void 0 ? {} : { badge: model.badge },
			reasoning: model.reasoning
		};
	});
}
function brandFrom(value) {
	if (value === null || value === void 0 || value === "") return void 0;
	return isBrandId(value) ? value : void 0;
}
/** Largest request body this route accepts; credentials are small. */
const MAX_BODY_BYTES$1 = 4096;
async function readJson$1(req) {
	const chunks = [];
	let size = 0;
	for await (const part of req) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part));
		size += chunk.length;
		if (size > MAX_BODY_BYTES$1) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new Error("缺少请求体");
	return JSON.parse(text);
}
function regionFrom(value) {
	return value === "cn" || value === "global" ? value : void 0;
}
async function sendStatus(res, adapter, fresh) {
	send(res, 200, await adapter.usageInfo(fresh));
}
/** Browser sign-in control and sign-out; the page never sends credentials. */
async function handleAccount(req, res, adapters) {
	let body;
	try {
		body = await readJson$1(req) ?? {};
	} catch (error) {
		send(res, 400, { error: `请求体无法解析：${error instanceof Error ? error.message : String(error)}` });
		return;
	}
	const brand = brandFrom(body.brand);
	if (brand === void 0) {
		send(res, 400, { error: "brand 只接受 loomy、raccoon、trae 或 codearts" });
		return;
	}
	const adapter = adapters[brand];
	const action = body.action;
	if (action === "logout") {
		await adapter.logoutAccount();
		await sendStatus(res, adapter, false);
		return;
	}
	if (action === "browser") {
		try {
			send(res, 200, {
				brand,
				...await adapter.startBrowserLogin(regionFrom(body.region))
			});
		} catch (error) {
			send(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	if (action === "browser-cancel") {
		await adapter.cancelBrowserLogin();
		send(res, 200, {
			brand,
			...adapter.browserLoginStatus()
		});
		return;
	}
	if (action === "checkin") {
		try {
			send(res, 200, {
				brand,
				checkin: await adapter.claimCheckin()
			});
		} catch (error) {
			send(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}
	send(res, 400, { error: "action 只接受 browser、browser-cancel、checkin 或 logout" });
}
async function handleApi(req, res, adapters, openRouter) {
	try {
		const url = new URL(req.url ?? "/", "http://localhost");
		const path = url.pathname.slice(17) || "/";
		const method = req.method ?? "GET";
		if (path === "/openrouter" && method === "GET") {
			if (openRouter === void 0) {
				send(res, 503, { error: "OpenRouter 同步未启用" });
				return;
			}
			send(res, 200, openRouter.status());
			return;
		}
		if (path === "/openrouter/sync" && method === "POST") {
			if (openRouter === void 0) {
				send(res, 503, { error: "OpenRouter 同步未启用" });
				return;
			}
			send(res, 200, await openRouter.sync());
			return;
		}
		if (path === "/account" && method === "POST") {
			await handleAccount(req, res, adapters);
			return;
		}
		const brand = brandFrom(url.searchParams.get("brand"));
		if (brand === void 0) {
			send(res, 400, { error: "brand 只接受 loomy、raccoon、trae 或 codearts" });
			return;
		}
		const adapter = adapters[brand];
		const fresh = url.searchParams.get("fresh") === "1";
		if (path === "/account/browser" && method === "GET") {
			send(res, 200, {
				brand,
				...adapter.browserLoginStatus()
			});
			return;
		}
		if (path === "/models" && method === "GET") {
			if (fresh) adapter.invalidateCatalog();
			if (!await adapter.isSignedIn()) {
				send(res, 200, {
					brand,
					models: [],
					signedIn: false,
					notice: await adapter.catalogError()
				});
				return;
			}
			const rows = await buildRows(adapter);
			const error = await adapter.catalogError();
			send(res, 200, {
				brand,
				models: rows,
				signedIn: true,
				...error === void 0 ? {} : { notice: error },
				...rows.length === 0 && error === void 0 ? { notice: "账号没有返回任何模型。" } : {}
			});
			return;
		}
		if (path === "/status" && method === "GET") {
			if (fresh) adapter.invalidateUsage();
			send(res, 200, await adapter.usageInfo(fresh));
			return;
		}
		send(res, 404, { error: "未知接口" });
	} catch (error) {
		send(res, 500, { error: error instanceof Error ? error.message : String(error) });
	}
}
// src/codearts-endpoints.ts
/**
* Where Huawei CodeArts lives, and the two facts about it that are not HTTP.
*
* CodeArts Agent is an IDE with a signed gateway behind it, so every call needs
* a `SDK-HMAC-SHA256` signature over the exact body. The host names below come
* from the IDE's own `product.json` (snap-access) and its OAuth portal; none of
* them is a documented public API.
*
* The context windows are the one thing the gateway never publishes: neither
* `/v1/model/builtin` nor `opengw gateway/config` carries any window field. The
* table below is the IDE's own provider configuration (`limit.context`), read
* out of its kernel log on 2026-10-21 — the only authoritative source. It does
* change over time (GLM-5.2 went from 202 752 to 1 048 576 on 10-21), so the
* table is a cache of a measurement, not a spec: an unknown model falls back to
* the smallest window the catalogue currently reports, which is the safe side
* (too small only compresses early; too large makes the upstream reject a
* conversation that already overflows).
*
* @module dsh-llm-adapters/codearts-endpoints
*/
/** Gateway host for models, quota and chat. */
const CODEARTS_SNAP_BASE = "https://snap-access.cn-north-4.myhuaweicloud.com";
/** Chat completions live under the v2 prefix; models and quota do not. */
const CODEARTS_CHAT_URL = `${CODEARTS_SNAP_BASE}/api/v2/chat/completions`;
const CODEARTS_MODEL_BUILTIN_PATH = "/v1/model/builtin";
const CODEARTS_PACKAGE_INFO_PATH = "/snap-manager/v1/statistics/plugin";
const CODEARTS_OPS_DELIVERY_PATH = "/v1/ops/delivery";
const CODEARTS_OPS_CLAIM_PATH = "/v1/ops/claim";
const CODEARTS_OPS_CONFIRM_PATH = "/v1/ops/confirm";
/** The `benefit` (free-allowance) models are listed by a second gateway. */
const CODEARTS_GATEWAY_CONFIG_URL = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config";
/** The daily sign-in activity's `type`; the other three are invite/new-user/student. */
const CODEARTS_DAILY_LOGIN_TYPE = "USER_LOGIN";
/** Activity states that mean "already taken", not "not eligible". */
const CODEARTS_CLAIMED_STATUSES = [
	"CLAIMED",
	"CONFIRMED",
	"CONSUMED"
];
/**
* Headers every snap-access call carries.
*
* They are appended **after** signing on purpose: putting `Agent-Type` into the
* canonical request makes the gateway answer `APIG.0301 … verify ak sk signature
* fail`, while the same header sent unsigned is required for routing.
*/
const CODEARTS_EXTRA_HEADERS = {
	"Agent-Type": "PromptCenter",
	"X-Language": "zh-cn"
};
/** OAuth client id = the IDE's URI scheme. */
const CODEARTS_CLIENT_ID = "codearts-agent";
/** Local callback path the portal redirects to. */
const CODEARTS_REDIRECT_PATH = "/oauth/callback";
const CODEARTS_STS_TOKEN_URL = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens";
const CODEARTS_PORTAL_AUTHORIZE = "https://codearts.huaweicloud.com/portal/authorize";
const CODEARTS_PORTAL_LOGIN = "https://codearts.huaweicloud.com/portal/login";
/** Plugin identity the portal expects; these are the real extension's values. */
const CODEARTS_LOGIN_PLUGIN_NAME = "snap_AIIDE";
const CODEARTS_LOGIN_PLUGIN_VERSION = "5.2.0";
/** The gateway rejects a larger `max_tokens`; 65 536 is the IDE's own cap. */
const CODEARTS_MAX_OUTPUT_TOKENS = 65536;
/**
* `reasoning_effort` values the gateway validates, in the order the settings
* page shows them.
*
* `none` is deliberately absent: it is only the legacy spelling of `off`,
* which is sent as `thinking: disabled` instead, and `glm-5.3` rejects it as a
* level outright. OpenRouter's `supported_efforts` is intersected with this
* list, so an editor-only level (`minimal`) never reaches a model that would
* answer 4xx for it.
*/
const CODEARTS_EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* Window used when a model is not in the table: the smallest one the catalogue
* is known to publish (openpangu / sft-harmony). Erring small costs an early
* compaction; erring large costs a rejected turn.
*/
const CODEARTS_FALLBACK_CONTEXT_WINDOW = 524288;
/**
* `limit.context` per model, from the IDE provider configuration.
*
* Keys are lowercase; lookups are case-insensitive because the gateway spells
* the same model `GLM-5.2` in one roster and `glm-5.2` in the other.
*/
const CODEARTS_CONTEXT_WINDOWS = {
	"glm-5.2": 1048576,
	"glm-5.3": 1048576,
	"glm-5.2-sft-harmony": 202752,
	"openpangu-2.0-flash": 524288,
	"openpangu-2.0-pro": 524288,
	"deepseek-v4.1-flash": 1048576,
	"kimi-k2.6-vl": 262144,
	"qwen3-vl-235b": 262144
};
/** The window a model gets, with the documented fallback. */
function codeartsContextWindow(modelId) {
	return CODEARTS_CONTEXT_WINDOWS[modelId.trim().toLowerCase()] ?? 524288;
}
/**
* Models that can take an image, measured from `supports_images`.
*
* Every other model answers `InferHub.001001020.406 The request model is not
* multimodal`, so the route declares image input only for these. Both are
* `display_enabled: false` upstream but `enable: true`, and both answer tool
* calls, so they are listed even though the IDE hides them.
*/
const CODEARTS_VISION_MODELS = ["kimi-k2.6-vl", "Qwen3-VL-235B"];
/**
* Free-allowance models known to need `maas_type: benefit`.
*
* The authoritative set is the `opengw gateway/config` roster, fetched with the
* catalogue; this is only the fallback for the first call after a fresh install.
* `deepseek-v4-flash` / `deepseek-v4-pro` are deliberately absent: they are
* registered as ordinary models and the header makes them `unsupported model`.
*/
const CODEARTS_BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4.1-flash"];
// src/codearts-oauth.ts
/**
* CodeArts login: PKCE + DPoP against Huawei's STS, and the credential shape
* that survives a restart.
*
* The portal hands the local callback a one-time `code`; exchanging it needs two
* proofs that no other provider in this plugin uses:
*
* - **PKCE** (`S256`) ties the code to the process that asked for it.
* - **DPoP** (`ES256`, `typ: dpop+jwt`) ties the token request to a key pair.
*   The private key is stored with the credential because every refresh has to
*   sign with the *same* key — a new one is rejected.
*
* Both are implemented on `node:crypto` (no dependency): a JWS signature is the
* raw 64-byte `R||S` pair, which `dsaEncoding: 'ieee-p1363'` produces directly.
*
* @module dsh-llm-adapters/codearts-oauth
*/
/** The refresh token itself is gone; only a new login helps. */
var RefreshTokenExpiredError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "RefreshTokenExpiredError";
	}
};
function generatePkcePair() {
	const codeVerifier = randomBytes(48).toString("base64url");
	return {
		codeVerifier,
		codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url")
	};
}
function generateDpopKeyPair() {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const privateKeyJwk = privateKey.export({ format: "jwk" });
	const publicKeyJwk = publicKey.export({ format: "jwk" });
	return {
		privateKeyJwk: {
			kty: "EC",
			crv: "P-256",
			x: privateKeyJwk.x,
			y: privateKeyJwk.y,
			d: privateKeyJwk.d
		},
		publicKeyJwk: {
			kty: "EC",
			crv: "P-256",
			x: publicKeyJwk.x,
			y: publicKeyJwk.y
		}
	};
}
/** Rebuild the key pair from the stored private JWK (the public half is in it). */
function keyPairFromStoredJwk(jwk) {
	return {
		privateKeyJwk: jwk,
		publicKeyJwk: {
			kty: jwk.kty,
			crv: jwk.crv,
			x: jwk.x,
			y: jwk.y
		}
	};
}
function privateKeyOf(keyPair) {
	return createPrivateKey({
		key: keyPair.privateKeyJwk,
		format: "jwk"
	});
}
/** A `dpop+jwt` proof binding this request method and URL to the key pair. */
function signDpopJws(keyPair, htm, htu) {
	const header = {
		alg: "ES256",
		typ: "dpop+jwt",
		jwk: keyPair.publicKeyJwk
	};
	const payload = {
		htm,
		htu,
		iat: Math.floor(Date.now() / 1e3),
		jti: randomBytes(32).toString("hex")
	};
	const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
	return `${signingInput}.${sign("sha256", Buffer.from(signingInput), {
		key: privateKeyOf(keyPair),
		dsaEncoding: "ieee-p1363"
	}).toString("base64url")}`;
}
/** Read `exp` from a JWT without verifying it (scheduling only, never trust). */
function readJwtExpiry(token) {
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	const exp = decodeBase64UrlJson(parts[1])?.exp;
	if (typeof exp !== "number" || !Number.isFinite(exp)) return void 0;
	const ms = exp * 1e3;
	return Math.abs(ms) > 0x5af3107a4000 ? void 0 : ms;
}
function decodeBase64UrlJson(value) {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		return parsed === null || typeof parsed !== "object" ? void 0 : parsed;
	} catch {
		return;
	}
}
/**
* Read the account identity out of a refresh token.
*
* The STS response carries no profile — `credentials` is the AK/SK/token triple
* and nothing else — so a card built from it alone has nothing to put next to
* 账号. The portal does name the user, but only inside the refresh token: its
* `user_profile` claim is a second base64 JSON blob holding `account_name`,
* `principal_id` and `account_id`. Decoding it is read-only and needs no extra
* request; without it the field stays empty and the page says so.
*/
function readUserProfile(token) {
	if (token === void 0) return void 0;
	const parts = token.split(".");
	if (parts.length !== 3) return void 0;
	const encoded = decodeBase64UrlJson(parts[1])?.user_profile;
	if (typeof encoded !== "string") return void 0;
	const profile = decodeBase64UrlJson(encoded);
	if (profile === void 0) return void 0;
	const name = typeof profile.account_name === "string" ? profile.account_name.trim() : "";
	const userId = typeof profile.principal_id === "string" ? profile.principal_id : void 0;
	const domainId = typeof profile.account_id === "string" ? profile.account_id : void 0;
	if (name === "" && userId === void 0 && domainId === void 0) return void 0;
	return {
		...name === "" ? {} : { userName: name },
		...userId === void 0 ? {} : { userId },
		...domainId === void 0 ? {} : { domainId }
	};
}
/** The portal URL the browser opens; the callback is on loopback. */
function buildAuthorizeUrl(port, pkce, ticketId) {
	return `${CODEARTS_PORTAL_AUTHORIZE}?theme=2&locale=zh-cn&uri_scheme=${CODEARTS_CLIENT_ID}&client_id=${CODEARTS_CLIENT_ID}&port=${port}&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256&ticket_id=${ticketId}&plugin-name=snap_AIIDE&plugin-version=5.2.0`;
}
/** Where the browser lands after a successful or failed exchange. */
function buildLoginResultUrl(succeeded) {
	return `${CODEARTS_PORTAL_LOGIN}?login_succeed=${succeeded}&uri_scheme=${CODEARTS_CLIENT_ID}&locale=zh-cn`;
}
function redirectUri(port) {
	return `http://127.0.0.1:${port}${CODEARTS_REDIRECT_PATH}`;
}
async function requestToken(body, keyPair, fetcher) {
	const response = await fetcher(CODEARTS_STS_TOKEN_URL, {
		method: "POST",
		headers: {
			DPoP: signDpopJws(keyPair, "POST", CODEARTS_STS_TOKEN_URL),
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(6e4)
	});
	let data = null;
	try {
		data = await response.json();
	} catch {
		data = null;
	}
	if (!response.ok || data?.credentials === void 0) {
		const message = `CodeArts 令牌请求失败：HTTP ${response.status}${data === null ? "" : ` ${JSON.stringify(data)}`}`;
		if (data?.error === "invalid_grant" || String(data?.error_code ?? "").includes("ExpiredRefreshToken")) throw new RefreshTokenExpiredError(message);
		throw new Error(message);
	}
	return data;
}
async function exchangeAuthorizationCode(code, codeVerifier, port, keyPair, fetcher = fetch) {
	return credentialFrom(await requestToken({
		client_id: CODEARTS_CLIENT_ID,
		code,
		code_verifier: codeVerifier,
		grant_type: "authorization_code",
		redirect_uri: redirectUri(port)
	}, keyPair, fetcher), codeVerifier, keyPair);
}
async function exchangeRefreshToken(refreshToken, codeVerifier, keyPair, fetcher = fetch) {
	const credential = credentialFrom(await requestToken({
		client_id: CODEARTS_CLIENT_ID,
		code_verifier: codeVerifier,
		grant_type: "refresh_token",
		refresh_token: refreshToken
	}, keyPair, fetcher), codeVerifier, keyPair);
	const userName = credential.userName ?? readUserProfile(refreshToken)?.userName;
	return {
		...credential,
		refreshToken: credential.refreshToken ?? refreshToken,
		...userName === void 0 ? {} : { userName }
	};
}
function credentialFrom(token, codeVerifier, keyPair) {
	const credentials = token.credentials ?? {};
	const expiration = credentials.expiration;
	const expiresAt = expiration === void 0 ? void 0 : Date.parse(expiration);
	const userName = readUserProfile(token.refresh_token)?.userName;
	return {
		accessKeyId: credentials.access_key_id ?? "",
		secretAccessKey: credentials.secret_access_key ?? "",
		securityToken: credentials.security_token ?? "",
		...expiresAt === void 0 || Number.isNaN(expiresAt) ? {} : { expiresAt },
		...token.refresh_token === void 0 ? {} : { refreshToken: token.refresh_token },
		...userName === void 0 ? {} : { userName },
		codeVerifier,
		dpopPrivateJwk: keyPair.privateKeyJwk
	};
}
// src/wire.ts
/**
* OpenAI Chat Completions transport shared by both providers.
*
* The harness vocabulary is richer than the wire format: durable images and
* files, reasoning blocks, and tool calls arrive as structured content. This
* module projects those to OpenAI messages and turns the SSE stream back into
* the harness's block-oriented chunks.
*
* @module dsh-llm-adapters/wire
*/
/**
* Model-facing handle for one image.
*
* The harness's own adapters append exactly this text — attachment identity,
* pixel size, the read-only normalized copy on disk, and the instruction to
* copy it to a writable path before editing. Reusing the helper keeps the
* wording (and therefore the model's behaviour) identical across routes.
*/
function imageRefText(ref, path) {
	if (path === void 0) return `[图片附件 ${String(ref.attachmentId)}（${ref.width}×${ref.height}px，${ref.mediaType}）]`;
	return requestImageHandleText(ref, {
		width: ref.width,
		height: ref.height
	}, { readonlyPath: path });
}
var ProviderHttpError = class extends Error {
	status;
	constructor(message, status) {
		super(message);
		this.status = status;
		this.name = "ProviderHttpError";
	}
};
/** A small, bounded body read used for error diagnostics. */
async function errorMessage(response) {
	const text = await response.text().catch(() => "");
	if (text === "") return `HTTP ${response.status}`;
	try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") {
			const record = parsed;
			const nested = record.error;
			if (typeof nested === "string" && nested.length > 0) return nested;
			if (nested !== null && typeof nested === "object") {
				const message = nested.message;
				if (typeof message === "string" && message.length > 0) return message;
			}
			if (typeof record.message === "string" && record.message.length > 0) return record.message;
			if (typeof record.error_description === "string" && record.error_description.length > 0) return record.error_description;
		}
	} catch {}
	return text.slice(0, 400);
}
function textOf$1(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function filePlaceholder(block) {
	return `[附件：${block.attachment.name}（${block.attachment.bytes} 字节）]`;
}
async function userContent(blocks, readImage, signal) {
	const parts = [];
	let hasImage = false;
	for (const block of blocks) if (block.type === "text") parts.push({
		type: "text",
		text: block.text
	});
	else if (block.type === "image") {
		if (block.offloaded === true) {
			parts.push({
				type: "text",
				text: offloadedImageText(block.attachment)
			});
			continue;
		}
		if (readImage === void 0) {
			parts.push({
				type: "text",
				text: imageRefText(block.attachment, void 0)
			});
			continue;
		}
		let image;
		try {
			image = await readImage(block.attachment, signal);
		} catch {
			image = void 0;
		}
		if (image === void 0) {
			parts.push({
				type: "text",
				text: "[图片读取失败]"
			});
			continue;
		}
		parts.push({
			type: "text",
			text: imageRefText(block.attachment, image.path)
		});
		parts.push({
			type: "image_url",
			image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}` }
		});
		hasImage = true;
	} else if (block.type === "file") parts.push({
		type: "text",
		text: filePlaceholder(block)
	});
	if (!hasImage) return parts.filter((part) => part.type === "text").map((part) => String(part.text)).join("");
	return parts.filter((part) => part.type === "text" ? String(part.text).length > 0 : true);
}
/**
* Project the harness request onto OpenAI messages.
*
* Explanatory reasoning from earlier assistant turns is deliberately dropped:
* providers either reject it or treat it as answer text on replay.
*/
async function buildMessages(options, readImage) {
	const out = [];
	const system = [];
	if (options.system !== void 0 && options.system.trim().length > 0) system.push(options.system);
	for (const message of options.messages) {
		if (message.role === "system") {
			const text = textOf$1(message.content);
			if (text.length > 0) system.push(text);
			continue;
		}
		if (message.role === "developer") {
			const text = textOf$1(message.content);
			if (text.length > 0) system.push(text);
			continue;
		}
		if (message.role === "user") {
			out.push({
				role: "user",
				content: await userContent(message.content, readImage, options.signal)
			});
			continue;
		}
		if (message.role === "tool") {
			out.push({
				role: "tool",
				tool_call_id: String(message.toolCallId),
				content: textOf$1(message.content)
			});
			continue;
		}
		const text = textOf$1(message.content);
		const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
			id: String(block.id),
			type: "function",
			function: {
				name: block.name,
				arguments: block.arguments === "" ? "{}" : block.arguments
			}
		}));
		out.push({
			role: "assistant",
			content: text,
			...toolCalls.length === 0 ? {} : { tool_calls: toolCalls }
		});
	}
	if (system.length > 0) out.unshift({
		role: "system",
		content: system.join("\n\n")
	});
	return out;
}
function buildTools(options) {
	if (options.tools === void 0 || options.tools.length === 0) return void 0;
	return options.tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
}
/** Add generation controls without overwriting a provider-specific field. */
function buildBody(options, model, messages, tools) {
	return {
		model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...options.maxTokens === void 0 ? {} : { max_tokens: Math.floor(options.maxTokens) },
		...options.temperature === void 0 ? {} : { temperature: options.temperature },
		...options.stop === void 0 || options.stop.length === 0 ? {} : { stop: options.stop },
		...tools === void 0 ? {} : {
			tools,
			tool_choice: "auto"
		}
	};
}
/** Split a byte stream into SSE data payloads, tolerating CRLF and comments. */
async function* sseEvents(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
			while (match !== null) {
				const block = buffer.slice(0, match.index);
				buffer = buffer.slice(match.index + match[0].length);
				const data = block.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
				if (data.length > 0) yield { data };
				match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
			}
		}
		buffer += decoder.decode();
		for (const block of buffer.split(/\r\n\r\n|\n\n|\r\r/)) {
			const data = block.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
			if (data.length > 0) yield { data };
		}
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
const int = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
function usageOf(usage) {
	if (usage === void 0) return void 0;
	const prompt = int(usage.prompt_tokens);
	const completion = int(usage.completion_tokens);
	const cached = int(usage.prompt_tokens_details?.cached_tokens);
	const reasoning = Math.min(int(usage.completion_tokens_details?.reasoning_tokens), completion);
	const input = Math.max(0, prompt - cached);
	const total = int(usage.total_tokens) || input + cached + completion;
	if (prompt === 0 && completion === 0) return void 0;
	return {
		type: "usage",
		usage: {
			inputTokens: input,
			outputTokens: completion,
			totalTokens: total,
			...cached === 0 ? {} : { cacheReadTokens: cached },
			...reasoning === 0 ? {} : { reasoningTokens: reasoning }
		}
	};
}
/** A finish reason mapper for the two compatible gateways. */
function finishReason(raw) {
	if (raw === "stop" || raw === "end_turn") return "stop";
	if (raw === "tool_calls" || raw === "function_call") return "tool-calls";
	if (raw === "length" || raw === "max_tokens" || raw === "max_output_tokens") return "max-tokens";
}
function deltaText(delta) {
	for (const key of ["content", "text"]) if (typeof delta[key] === "string") return delta[key];
	return "";
}
function deltaReasoning(delta) {
	for (const key of [
		"reasoning_content",
		"reasoning",
		"reasoning_text"
	]) if (typeof delta[key] === "string") return delta[key];
	return "";
}
function toolDeltas(delta) {
	if (!Array.isArray(delta.tool_calls)) return [];
	const out = [];
	for (const entry of delta.tool_calls) {
		if (entry === null || typeof entry !== "object") continue;
		const record = entry;
		const fn = record.function !== null && typeof record.function === "object" ? record.function : {};
		out.push({
			index: typeof record.index === "number" ? record.index : 0,
			...typeof record.id === "string" && record.id.length > 0 ? { id: record.id } : {},
			...typeof fn.name === "string" && fn.name.length > 0 ? { name: fn.name } : {},
			arguments: typeof fn.arguments === "string" ? fn.arguments : ""
		});
	}
	return out;
}
/**
* Consume one OpenAI-compatible streaming response.
*
* Text and reasoning are emitted as they arrive. Tool-call fragments are
* buffered until the stream ends because the harness requires a stable call id
* on every delta; emitting fragments with placeholder ids would disconnect
* them from the matching tool result.
*/
async function* openAiStream(options) {
	const response = await (options.fetchImpl ?? fetch)(options.url, {
		method: "POST",
		headers: {
			...attributionHeaders(),
			accept: "text/event-stream",
			"content-type": "application/json",
			...options.headers
		},
		body: JSON.stringify(options.body),
		signal: options.signal
	});
	if (!response.ok) {
		const message = await errorMessage(response);
		if (response.status === 401 || response.status === 403) options.onUnauthorized?.();
		throw new ProviderHttpError(message, response.status);
	}
	if (response.body === null) throw new ProviderHttpError("上游没有返回响应体", 502);
	if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
		yield* nonStreaming(response, options.signal);
		return;
	}
	yield* consumeOpenAiStream(response, {
		...options.signal === void 0 ? {} : { signal: options.signal },
		...options.onFrame === void 0 ? {} : { onFrame: options.onFrame }
	});
}
/**
* Turn an already-open OpenAI-compatible SSE response into harness chunks.
*
* Split out from {@link openAiStream} so a gateway that has to sign the exact
* request body (CodeArts) can do its own fetch and still reuse the frame
* handling. `onFrame` sees every parsed frame before it is interpreted, which
* is how a gateway that reports errors inside a 200 stream is caught.
*/
async function* consumeOpenAiStream(response, options = {}) {
	if (response.body === null) throw new ProviderHttpError("上游没有返回响应体", 502);
	let nextIndex = 0;
	let current;
	const tools = /* @__PURE__ */ new Map();
	let finish;
	let usage;
	let sawDone = false;
	let sawContent = false;
	const start = (kind) => {
		current = {
			kind,
			index: nextIndex++,
			text: ""
		};
		return {
			type: "block-start",
			index: current.index,
			blockType: kind
		};
	};
	const close = () => {
		if (current === void 0) return void 0;
		const block = current.kind === "text" ? {
			type: "text",
			text: current.text
		} : {
			type: "reasoning",
			text: current.text
		};
		const chunk = {
			type: "block-end",
			index: current.index,
			block
		};
		current = void 0;
		return chunk;
	};
	for await (const event of sseEvents(response.body)) {
		if (event.data.trim() === "[DONE]") {
			sawDone = true;
			break;
		}
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			continue;
		}
		options.onFrame?.(frame);
		if (frame.error !== void 0) throw new ProviderHttpError(typeof frame.error === "string" ? frame.error : typeof frame.error === "object" && frame.error !== null ? String(frame.error.message ?? "上游返回错误") : "上游返回错误", 502);
		usage = usageOf(frame.usage) ?? usage;
		const choice = frame.choices?.[0];
		if (choice === void 0) continue;
		const delta = choice.delta ?? {};
		const reasoning = deltaReasoning(delta);
		if (reasoning.length > 0) {
			if (current?.kind !== "reasoning") {
				const ended = close();
				if (ended !== void 0) yield ended;
				yield start("reasoning");
			}
			current.text += reasoning;
			sawContent = true;
			yield {
				type: "reasoning-delta",
				index: current.index,
				text: reasoning
			};
		}
		const text = deltaText(delta);
		if (text.length > 0) {
			if (current?.kind !== "text") {
				const ended = close();
				if (ended !== void 0) yield ended;
				yield start("text");
			}
			current.text += text;
			sawContent = true;
			yield {
				type: "text-delta",
				index: current.index,
				text
			};
		}
		for (const tool of toolDeltas(delta)) {
			const held = tools.get(tool.index) ?? { arguments: "" };
			if (tool.id !== void 0) held.id = tool.id;
			if (tool.name !== void 0) held.name = (held.name ?? "") + tool.name;
			held.arguments += tool.arguments;
			tools.set(tool.index, held);
			sawContent = true;
		}
		if (choice.finish_reason !== void 0) finish = choice.finish_reason;
	}
	const ended = close();
	if (ended !== void 0) yield ended;
	let toolCalls = 0;
	for (const [index, tool] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
		const callId = tool.id ?? `call_${crypto.randomUUID()}`;
		const name = tool.name ?? "unknown_tool";
		const args = tool.arguments === "" ? "{}" : tool.arguments;
		const blockIndex = nextIndex++;
		yield {
			type: "block-start",
			index: blockIndex,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index: blockIndex,
			id: callId,
			name,
			argumentsDelta: args
		};
		yield {
			type: "block-end",
			index: blockIndex,
			block: {
				type: "tool-call",
				id: callId,
				name,
				arguments: args
			}
		};
		toolCalls++;
	}
	if (usage !== void 0) yield usage;
	let reason = finishReason(finish);
	if (reason === void 0 && toolCalls > 0) reason = "tool-calls";
	if (reason === void 0 && sawDone) reason = sawContent ? "max-tokens" : "stop";
	if (reason === void 0) reason = "stop";
	yield {
		type: "finish",
		reason: { kind: reason }
	};
}
/** Non-streaming fallback for a gateway that ignores `stream: true`. */
async function* nonStreaming(response, signal) {
	const payload = await response.json();
	if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");
	const message = payload.choices?.[0]?.message ?? {};
	const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : typeof message.reasoning === "string" ? message.reasoning : "";
	let index = 0;
	if (reasoning.length > 0) {
		yield {
			type: "block-start",
			index,
			blockType: "reasoning"
		};
		yield {
			type: "reasoning-delta",
			index,
			text: reasoning
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "reasoning",
				text: reasoning
			}
		};
		index++;
	}
	const text = typeof message.content === "string" ? message.content : "";
	if (text.length > 0) {
		yield {
			type: "block-start",
			index,
			blockType: "text"
		};
		yield {
			type: "text-delta",
			index,
			text
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "text",
				text
			}
		};
		index++;
	}
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const raw of toolCalls) {
		if (raw === null || typeof raw !== "object") continue;
		const record = raw;
		const fn = record.function !== null && typeof record.function === "object" ? record.function : {};
		const callId = typeof record.id === "string" ? record.id : `call_${crypto.randomUUID()}`;
		const name = typeof fn.name === "string" ? fn.name : "unknown_tool";
		const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
		yield {
			type: "block-start",
			index,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index,
			id: callId,
			name,
			argumentsDelta: args
		};
		yield {
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: callId,
				name,
				arguments: args
			}
		};
		index++;
	}
	const usage = usageOf(payload.usage);
	if (usage !== void 0) yield usage;
	yield {
		type: "finish",
		reason: { kind: finishReason(payload.choices?.[0]?.finish_reason) ?? (toolCalls.length > 0 ? "tool-calls" : "stop") }
	};
}
// src/http.ts
/** JSON request helpers shared by the two provider clients. @module dsh-llm-adapters/http */
async function responseError(response) {
	const text = await response.text().catch(() => "");
	if (text === "") return `HTTP ${response.status}`;
	try {
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object") {
			const record = parsed;
			const nested = record.error;
			if (typeof nested === "string" && nested.length > 0) return nested;
			if (nested !== null && typeof nested === "object") {
				const message = nested.message;
				if (typeof message === "string" && message.length > 0) return message;
			}
			if (typeof record.message === "string" && record.message.length > 0) return record.message;
		}
	} catch {}
	return text.slice(0, 400);
}
async function fetchJson(url, request = {}) {
	const timeout = AbortSignal.timeout(request.timeoutMs ?? 2e4);
	const signal = request.signal === void 0 ? timeout : AbortSignal.any([request.signal, timeout]);
	let response;
	try {
		response = await (request.fetchImpl ?? fetch)(url, {
			method: request.method ?? "GET",
			headers: {
				...request.attribution === false ? {} : attributionHeaders(),
				accept: "application/json",
				...request.body === void 0 ? {} : { "content-type": "application/json" },
				...request.headers
			},
			...request.body === void 0 ? {} : { body: JSON.stringify(request.body) },
			signal
		});
	} catch (error) {
		if (timeout.aborted) throw new ProviderHttpError(`请求超时（${Math.round((request.timeoutMs ?? 2e4) / 1e3)} 秒）`, 504);
		throw error;
	}
	if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status);
	try {
		return await response.json();
	} catch {
		throw new ProviderHttpError("上游返回的不是 JSON", 502);
	}
}
// src/trae-endpoints.ts
const TRAE_REGION_PROFILES = {
	cn: {
		id: "cn",
		label: "Trae 国内版",
		webOrigin: "https://www.trae.cn",
		apiBase: "https://api.trae.cn",
		chatBase: "https://trae-api-cn.mchost.guru",
		remoteBase: "https://solo.trae.cn/api/remote/v1",
		payBase: "https://api.trae.cn",
		timezone: "Asia/Shanghai",
		language: "zh-cn",
		checkin: true
	},
	global: {
		id: "global",
		label: "Trae 国际版",
		webOrigin: "https://www.trae.ai",
		apiBase: "https://ug-normal.trae.ai",
		chatBase: "https://coresg-normal.trae.ai",
		remoteBase: "https://coresg-normal.trae.ai/api/remote/v1",
		payBase: "https://growsg-normal.trae.ai",
		timezone: "Asia/Singapore",
		language: "en",
		checkin: false
	}
};
/** The app id Trae's own clients send; not account-specific. */
const TRAE_APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
/**
* Numeric build code sent as `x-app-version-code` / `x-ide-version-code`.
*
* The gateway binds those headers as a number and rejects the request with
* `4001 ... expr_path=app_version_code, cause=missing required parameter` when
* they are absent — on chat AND on `get_detail_param`, where the silent variant
* is an empty roster. A web login has no desktop build number, so this fixed
* numeric code is used; only the format is normalized, nothing impersonates a
* device.
*/
const TRAE_VERSION_CODE = "20260716";
const TRAE_SOLO_CHAT_PATH = "/api/agent/v3/llm_utils_chat";
const TRAE_SOLO_MODELS_PATH = "/api/ide/v1/get_detail_param";
/** A browser User-Agent; the gateways reject obviously non-browser clients. */
const TRAE_WEB_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// src/auth.ts
/** Expiry margin for Raccoon's JWT, so a call does not start on a dead token. */
const RACCOON_EXPIRY_MARGIN_MS = 3e4;
/** Renew Trae's token well before its eight-hour expiry. */
const TRAE_EXPIRY_MARGIN_MS = 3e5;
function traeLabel(region) {
	return region === "cn" ? "Trae 国内版" : "Trae 国际版";
}
function traeAccount(record) {
	const account = {};
	if (record.name !== void 0) account.name = record.name;
	if (record.userId !== void 0) account.userId = record.userId;
	return account;
}
function loomyAccount(record) {
	const account = {};
	if (record.name !== void 0) account.name = record.name;
	if (record.phone !== void 0) account.phone = record.phone;
	if (record.userId !== void 0) account.userId = record.userId;
	return account;
}
function raccoonAccount(record, facts) {
	const account = {};
	const name = record.name ?? facts.name;
	const phone = record.phone ?? facts.phone;
	if (name !== void 0) account.name = name;
	if (phone !== void 0) account.phone = phone;
	account.ownerType = record.ownerType ?? facts.ownerType ?? "personal";
	if (facts.sessionId !== void 0) account.sessionId = facts.sessionId;
	return account;
}
var LoomyAuth = class {
	store;
	constructor(store) {
		this.store = store;
	}
	async status() {
		const stored = await this.store.loomy();
		if (stored === void 0) return {
			signedIn: false,
			error: "Loomy 尚未登录。请在设置页点「打开扫码登录」。"
		};
		const account = loomyAccount(stored);
		const expired = stored.expiresAt <= Date.now();
		return {
			signedIn: !expired,
			loginAt: stored.loginAt,
			expiresAt: stored.expiresAt,
			...expired ? { possiblyExpired: true } : {},
			...Object.keys(account).length === 0 ? {} : { account },
			...expired ? { error: "Loomy 登录已过期，请在设置页重新扫码登录。" } : {}
		};
	}
	/** The bearer session, or undefined when there is no stored login. */
	async session() {
		return (await this.store.loomy())?.session;
	}
	async logout() {
		await this.store.clear("loomy");
	}
};
/** Normalize seconds, milliseconds, and ISO strings to epoch milliseconds. */
function timestampOf(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e10 ? value * 1e3 : value;
	if (typeof value === "string") {
		if (/^\d+$/.test(value)) return timestampOf(Number(value));
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/** Read non-secret JWT claims; malformed tokens simply yield no facts. */
function decodeJwtFacts(token) {
	const parts = token.split(".");
	if (parts.length < 2) return {};
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		if (payload === null || typeof payload !== "object") return {};
		const record = payload;
		return {
			...timestampOf(record.exp) === void 0 ? {} : { expiresAt: timestampOf(record.exp) },
			...typeof record.name === "string" ? { name: record.name } : {},
			...typeof record.phone === "string" ? { phone: record.phone } : {},
			...typeof record.owner_type === "string" ? { ownerType: record.owner_type } : {},
			...typeof record.sid === "string" ? { sessionId: record.sid } : {}
		};
	} catch {
		return {};
	}
}
var RaccoonAuth = class {
	store;
	constructor(store) {
		this.store = store;
	}
	async status() {
		const stored = await this.store.raccoon();
		if (stored === void 0) return {
			signedIn: false,
			error: "小浣熊尚未登录。请在设置页点「打开扫码登录」。"
		};
		const facts = decodeJwtFacts(stored.accessToken);
		const signedIn = facts.expiresAt === void 0 || facts.expiresAt > Date.now() + RACCOON_EXPIRY_MARGIN_MS;
		const account = raccoonAccount(stored, facts);
		return {
			signedIn,
			loginAt: stored.loginAt,
			...facts.expiresAt === void 0 ? {} : { expiresAt: facts.expiresAt },
			...signedIn ? {} : { possiblyExpired: true },
			...Object.keys(account).length === 0 ? {} : { account },
			...signedIn ? {} : { error: "小浣熊登录已过期，请在设置页重新扫码登录。" }
		};
	}
	/**
	* The stored access token.
	*
	* A QR login has no refresh flow. `force` marks a gateway 401, so the only
	* honest answer then is to ask for a new scan.
	*/
	async accessToken(force = false) {
		const stored = await this.store.raccoon();
		if (stored === void 0) throw new Error("小浣熊尚未登录。请在设置页点「打开扫码登录」。");
		if (force) throw new Error("小浣熊登录已失效，请在设置页重新扫码登录。");
		const facts = decodeJwtFacts(stored.accessToken);
		if (facts.expiresAt !== void 0 && facts.expiresAt <= Date.now() + RACCOON_EXPIRY_MARGIN_MS) throw new Error("小浣熊登录已过期，请在设置页重新扫码登录。");
		return stored.accessToken;
	}
	async logout() {
		await this.store.clear("raccoon");
	}
};
/**
* The two expiries a Trae record can carry.
*
* Older records stored the website-session expiry in `expiresAt` because the
* short JWT was not known separately. The JWT's own `exp` is authoritative, so
* read it from the token and treat a much longer stored value as the session.
*/
function traeExpiries(stored) {
	const jwt = decodeJwtFacts(stored.accessToken).expiresAt;
	const token = jwt ?? stored.expiresAt;
	const session = stored.sessionExpiresAt ?? (jwt !== void 0 && stored.expiresAt !== void 0 && stored.expiresAt > jwt + 6e4 ? stored.expiresAt : void 0);
	return {
		...token === void 0 ? {} : { token },
		...session === void 0 ? {} : { session }
	};
}
/** The token document `GetUserToken` returns, tolerating the nested envelope. */
function traeTokenOf(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const result = payload.Result;
	if (result === null || typeof result !== "object") return void 0;
	const token = result.Token;
	return typeof token === "string" && token.trim().length > 0 ? token.trim() : void 0;
}
function traeSessionExpiryOf(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const result = payload.Result;
	if (result === null || typeof result !== "object") return void 0;
	return timestampOf(result.ExpiredAt);
}
/** Merge `Set-Cookie` lines into the stored jar, so a rotated session survives. */
function mergeSetCookies(current, headers) {
	const jar = /* @__PURE__ */ new Map();
	for (const part of current.split(";")) {
		const index = part.indexOf("=");
		if (index <= 0) continue;
		const name = part.slice(0, index).trim();
		if (name !== "") jar.set(name, part.slice(index + 1).trim());
	}
	for (const header of headers) {
		const first = header.split(";", 1)[0] ?? "";
		const index = first.indexOf("=");
		if (index <= 0) continue;
		const name = first.slice(0, index).trim();
		if (name === "") continue;
		if (/(?:^|;)\s*max-age=0\b/i.test(header)) {
			jar.delete(name);
			continue;
		}
		jar.set(name, first.slice(index + 1).trim());
	}
	return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
/**
* Trae's web login, one per region.
*
* The `Cloud-IDE-JWT` the website issues lives about eight hours, but the
* website session behind it lives about fourteen days. The cookies captured at
* sign-in are replayed against `GetUserToken` to renew the short token silently;
* only when the session itself dies does the user have to sign in again.
*/
var TraeAuth = class {
	store;
	currentRegion;
	fetchImpl;
	inflight = /* @__PURE__ */ new Map();
	lastError;
	constructor(store, currentRegion, fetchImpl = fetch) {
		this.store = store;
		this.currentRegion = currentRegion;
		this.fetchImpl = fetchImpl;
	}
	region() {
		return this.currentRegion();
	}
	async status() {
		const region = this.region();
		const stored = await this.store.trae(region);
		if (stored === void 0) return {
			signedIn: false,
			error: `${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。`
		};
		const now = Date.now();
		const { token, session } = traeExpiries(stored);
		const tokenExpired = token !== void 0 && token <= now + TRAE_EXPIRY_MARGIN_MS;
		const sessionExpired = session !== void 0 && session <= now + TRAE_EXPIRY_MARGIN_MS;
		const refreshable = stored.cookies !== void 0 && !sessionExpired;
		const signedIn = !tokenExpired || refreshable;
		const account = traeAccount(stored);
		const expiresAt = refreshable ? session ?? token : token;
		return {
			signedIn,
			loginAt: stored.loginAt,
			...expiresAt === void 0 ? {} : { expiresAt },
			...!signedIn ? { possiblyExpired: true } : {},
			...Object.keys(account).length === 0 ? {} : { account },
			...!signedIn ? { error: sessionExpired ? `${traeLabel(region)}网页会话已过期，请重新登录。` : `${traeLabel(region)}登录已过期，请在设置页重新登录。` } : tokenExpired && this.lastError !== void 0 ? { error: this.lastError } : {}
		};
	}
	/**
	* The bearer token, or an actionable error when there is none.
	*
	* A token near its expiry is renewed first; `force` means the gateway already
	* rejected it, so the renewal is attempted even if the clock disagrees.
	*/
	async accessToken(force = false) {
		const region = this.region();
		const stored = await this.store.trae(region);
		if (stored === void 0) throw new Error(`${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。`);
		const { token, session } = traeExpiries(stored);
		const expired = token !== void 0 && token <= Date.now() + TRAE_EXPIRY_MARGIN_MS;
		if (!force && !expired) return stored.accessToken;
		if (stored.cookies === void 0) throw new Error(`${traeLabel(region)}登录已${force ? "失效" : "过期"}，请在设置页重新登录。`);
		if (session !== void 0 && session <= Date.now() + TRAE_EXPIRY_MARGIN_MS) throw new Error(`${traeLabel(region)}网页会话已过期，请重新登录。`);
		return this.refresh(region);
	}
	/** Renew the eight-hour JWT with the stored website cookies. */
	async refresh(region) {
		const existing = this.inflight.get(region);
		if (existing !== void 0) return existing;
		const task = (async () => {
			const stored = await this.store.trae(region);
			if (stored === void 0 || stored.cookies === void 0) throw new Error(`${traeLabel(region)}登录已失效，请在设置页重新登录。`);
			const profile = TRAE_REGION_PROFILES[region];
			let response;
			try {
				response = await this.fetchImpl(`${profile.apiBase}/cloudide/api/v3/common/GetUserToken`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
						cookie: stored.cookies,
						origin: profile.webOrigin,
						referer: `${profile.webOrigin}/`,
						"user-agent": TRAE_WEB_USER_AGENT
					},
					body: "{}",
					signal: AbortSignal.timeout(15e3)
				});
			} catch (error) {
				const message = `Trae 令牌续期失败：${error instanceof Error ? error.message : String(error)}`;
				this.lastError = message;
				throw new Error(message);
			}
			if (!response.ok) {
				const message = response.status === 401 || response.status === 403 ? `${traeLabel(region)}网页会话已失效，请重新登录。` : `Trae 令牌续期失败：${await responseError(response)}`;
				this.lastError = message;
				throw new Error(message);
			}
			const payload = await response.json().catch(() => void 0);
			const token = traeTokenOf(payload);
			if (token === void 0) {
				const message = "Trae 令牌续期失败：响应里没有令牌。";
				this.lastError = message;
				throw new Error(message);
			}
			const sessionExpiresAt = traeSessionExpiryOf(payload) ?? stored.sessionExpiresAt;
			const expiresAt = decodeJwtFacts(token).expiresAt ?? sessionExpiresAt;
			const setCookies = response.headers.getSetCookie?.() ?? [];
			const cookies = setCookies.length === 0 ? stored.cookies : mergeSetCookies(stored.cookies, setCookies);
			await this.store.saveTrae({
				...stored,
				accessToken: token,
				cookies,
				...expiresAt === void 0 ? {} : { expiresAt },
				...sessionExpiresAt === void 0 ? {} : { sessionExpiresAt }
			});
			this.lastError = void 0;
			return token;
		})();
		this.inflight.set(region, task);
		try {
			return await task;
		} finally {
			this.inflight.delete(region);
		}
	}
	/** The fingerprints captured from the web session, replayed on every call. */
	async identity() {
		const region = this.region();
		const stored = await this.store.trae(region);
		if (stored === void 0) throw new Error(`${traeLabel(region)}尚未登录。请在设置页点「打开浏览器登录」。`);
		return {
			deviceId: stored.deviceId,
			machineId: stored.machineId,
			...stored.userId === void 0 ? {} : { userId: stored.userId }
		};
	}
	async logout() {
		const region = this.region();
		const running = this.inflight.get(region);
		if (running !== void 0) await running.catch(() => void 0);
		this.inflight.delete(region);
		this.lastError = void 0;
		await this.store.clear("trae", region);
	}
};
/** Margin before the STS token's own expiry, so a call never starts on a dead one. */
const CODEARTS_EXPIRY_MARGIN_MS = 3e5;
/**
* CodeArts credentials.
*
* There is no bearer token: the gateway verifies a signature over each request,
* so what this class hands out is the AK/SK/security-token triple. The STS token
* lives two hours and is renewed with the refresh token; both the PKCE verifier
* and the DPoP private key from the original login have to be reused, or Huawei
* rejects the renewal.
*/
var CodeArtsAuth = class {
	store;
	inflight;
	lastError;
	constructor(store) {
		this.store = store;
	}
	async status() {
		const stored = await this.store.codearts();
		if (stored === void 0) return {
			signedIn: false,
			error: "CodeArts 尚未登录。请在设置页点「打开浏览器登录」。"
		};
		const expired = stored.expiresAt !== void 0 && stored.expiresAt <= Date.now();
		const refreshable = stored.refreshToken !== void 0 && stored.codeVerifier !== void 0 && stored.dpopPrivateJwk !== void 0;
		const userName = stored.userName ?? readUserProfile(stored.refreshToken)?.userName;
		const account = userName === void 0 ? {} : { name: userName };
		return {
			signedIn: !expired || refreshable,
			loginAt: stored.loginAt,
			...stored.expiresAt === void 0 ? {} : { expiresAt: stored.expiresAt },
			...expired && !refreshable ? { possiblyExpired: true } : {},
			...Object.keys(account).length === 0 ? {} : { account },
			...expired && !refreshable ? { error: "CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。" } : {},
			...this.lastError === void 0 ? {} : { error: this.lastError }
		};
	}
	/** A usable triple, renewed first when it is close to expiring. */
	async credential() {
		const stored = await this.store.codearts();
		if (stored === void 0) throw new Error("CodeArts 尚未登录。请在设置页点「打开浏览器登录」。");
		if (!(stored.expiresAt !== void 0 && stored.expiresAt <= Date.now() + CODEARTS_EXPIRY_MARGIN_MS)) return credentialOf(stored);
		if (stored.refreshToken === void 0 || stored.codeVerifier === void 0 || stored.dpopPrivateJwk === void 0) throw new Error("CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。");
		return this.refresh(false);
	}
	/**
	* Renew the triple.
	*
	* `force` is used when the gateway rejected a signature the local clock still
	* considered valid (revoked or rotated token). A single in-flight renewal is
	* shared, so parallel requests do not each spend a refresh.
	*/
	async refresh(force) {
		if (this.inflight !== void 0) return this.inflight;
		this.inflight = (async () => {
			const stored = await this.store.codearts();
			if (stored === void 0) throw new Error("CodeArts 尚未登录。请在设置页点「打开浏览器登录」。");
			if (stored.refreshToken === void 0 || stored.codeVerifier === void 0 || stored.dpopPrivateJwk === void 0) throw new Error("CodeArts 登录已过期（STS 令牌两小时），请在设置页重新登录。");
			try {
				const next = await exchangeRefreshToken(stored.refreshToken, stored.codeVerifier, keyPairFromStoredJwk(stored.dpopPrivateJwk));
				await this.store.saveCodearts({
					...stored,
					accessKeyId: next.accessKeyId,
					secretAccessKey: next.secretAccessKey,
					securityToken: next.securityToken,
					...next.expiresAt === void 0 ? {} : { expiresAt: next.expiresAt },
					...next.refreshToken === void 0 ? {} : { refreshToken: next.refreshToken },
					...next.userName === void 0 ? {} : { userName: next.userName }
				});
				this.lastError = void 0;
				return next;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.lastError = error instanceof RefreshTokenExpiredError ? "CodeArts 登录已失效（续期令牌过期），请在设置页重新登录。" : `CodeArts 续期失败：${message}`;
				throw new Error(this.lastError);
			} finally {
				this.inflight = void 0;
			}
		})();
		return this.inflight;
	}
	async logout() {
		await this.store.clear("codearts");
		this.lastError = void 0;
	}
};
function credentialOf(record) {
	return {
		accessKeyId: record.accessKeyId,
		secretAccessKey: record.secretAccessKey,
		securityToken: record.securityToken,
		...record.expiresAt === void 0 ? {} : { expiresAt: record.expiresAt },
		...record.refreshToken === void 0 ? {} : { refreshToken: record.refreshToken },
		...record.codeVerifier === void 0 ? {} : { codeVerifier: record.codeVerifier },
		...record.dpopPrivateJwk === void 0 ? {} : { dpopPrivateJwk: record.dpopPrivateJwk }
	};
}
// src/config.ts
/**
* The plugin's configuration surface.
*
* DSH renders this schema in the generated part of the settings UI and, more
* importantly, treats every `.volatile()` field as an in-place edit: changing
* it must never restart the plugin. The adapters therefore read values through
* thunks from {@link liveConfig}.
*
* @module dsh-llm-adapters/config
*/
const Config$1 = z.object({
	loomyEnabled: z.boolean().default(true).description("启用 Loomy。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	raccoonEnabled: z.boolean().default(true).description("启用商汤小浣熊。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	traeEnabled: z.boolean().default(true).description("启用 Trae。关闭后该设置页、模型列表与 provider 路由都会移除；两个区域的登录态与模型选择会保留。").volatile(),
	traeRegion: z.string().default("cn").description("Trae 登录区域：cn（国内版 trae.cn）或 global（国际版 trae.ai）。两个区域各自保存账号，切换后立即恢复对应账号。").volatile(),
	codeartsEnabled: z.boolean().default(true).description("启用华为云 CodeArts。关闭后该设置页、模型列表与 provider 路由都会移除；登录态与模型选择会保留。").volatile(),
	loomyDisplayName: z.string().default("Loomy").description("模型选择器里 Loomy 分组的名称。").volatile(),
	raccoonDisplayName: z.string().default("商汤小浣熊").description("模型选择器里小浣熊分组的名称。").volatile(),
	traeDisplayName: z.string().default("Trae").description("模型选择器里 Trae 分组的名称。").volatile(),
	codeartsDisplayName: z.string().default("华为云 CodeArts").description("模型选择器里 CodeArts 分组的名称。").volatile(),
	loomyDisabledModels: z.array(z.string()).default([]).description("Loomy 已关闭的模型 ID 列表。关闭的模型不会出现在模型选择器里。").volatile(),
	raccoonDisabledModels: z.array(z.string()).default([]).description("小浣熊已关闭的模型 ID 列表。").volatile(),
	traeDisabledModels: z.array(z.string()).default([]).description("Trae 已关闭的模型 ID 列表。").volatile(),
	codeartsDisabledModels: z.array(z.string()).default([]).description("CodeArts 已关闭的模型 ID 列表。").volatile(),
	loomyModelContextWindows: z.dict(z.number()).default({}).description("Loomy 按模型指定上下文窗口（token 数）。未指定的模型使用上游声明的窗口。").volatile(),
	raccoonModelContextWindows: z.dict(z.number()).default({}).description("小浣熊按模型指定上下文窗口（token 数）。").volatile(),
	traeModelContextWindows: z.dict(z.number()).default({}).description("Trae 按模型指定上下文窗口（token 数）。").volatile(),
	codeartsModelContextWindows: z.dict(z.number()).default({}).description("CodeArts 按模型指定上下文窗口（token 数）。上游不下发窗口，默认使用 IDE 配置里的实测值。").volatile(),
	loomyModelAliases: z.dict(z.string()).default({}).description("Loomy 模型别名映射：DSH 侧名称 → 上游模型 ID。").volatile(),
	raccoonModelAliases: z.dict(z.string()).default({}).description("小浣熊模型别名映射：DSH 侧名称 → 上游模型 ID。").volatile(),
	traeModelAliases: z.dict(z.string()).default({}).description("Trae 模型别名映射：DSH 侧名称 → 上游模型 ID。").volatile(),
	codeartsModelAliases: z.dict(z.string()).default({}).description("CodeArts 模型别名映射：DSH 侧名称 → 上游模型 ID。").volatile(),
	loomyVisionModelIds: z.array(z.string()).default([]).description("Loomy 强制按“能读图”声明的模型 ID，优先级高于目录标签。").volatile(),
	loomyTextOnlyModelIds: z.array(z.string()).default([]).description("Loomy 强制按“纯文本”声明的模型 ID，优先级最高。").volatile(),
	raccoonVisionModelIds: z.array(z.string()).default([]).description("小浣熊强制按“能读图”声明的模型 ID。用于纠正上游标签错误。").volatile(),
	raccoonTextOnlyModelIds: z.array(z.string()).default([]).description("小浣熊强制按“纯文本”声明的模型 ID，优先级最高。").volatile(),
	traeVisionModelIds: z.array(z.string()).default([]).description("Trae 强制按“能读图”声明的模型 ID。目录标注 multimodal 的模型会自动启用。").volatile(),
	traeTextOnlyModelIds: z.array(z.string()).default([]).description("Trae 强制按“纯文本”声明的模型 ID，优先级最高。").volatile(),
	codeartsVisionModelIds: z.array(z.string()).default([]).description("CodeArts 强制按“能读图”声明的模型 ID。只有 VL 模型能收图。").volatile(),
	codeartsTextOnlyModelIds: z.array(z.string()).default([]).description("CodeArts 强制按“纯文本”声明的模型 ID，优先级最高。").volatile(),
	defaultMaxTokens: z.number().step(1).min(1).default(32e3).description("模型目录未声明输出上限时使用的输出上限。").volatile(),
	modelCacheTtlSeconds: z.number().step(1).min(10).max(86400).default(120).description("模型列表缓存时长（秒）。调小可更快看到账号侧变化。").volatile(),
	catalogFetchTimeoutSeconds: z.number().step(1).min(1).max(300).default(20).description("读取模型目录、额度等请求的时限（秒）。").volatile(),
	openRouterSyncMinutes: z.number().step(1).min(0).max(43200).default(60).description("OpenRouter 模型元数据的自动同步间隔（分钟）。0 表示关闭自动同步；缓存保存在本机，连不上时继续使用上次成功同步的数据。").volatile(),
	raccoonCheckinMinutes: z.number().step(1).min(0).max(1440).default(30).description("小浣熊每日积分自动监测间隔（分钟）：到点核对积分流水，未到账时按网页方式尝试触发。0 表示关闭自动监测；「打开网页签到」入口始终保留。").volatile()
});
function liveConfig(config) {
	const source = config ?? {};
	const field = (key) => {
		const value = source[key];
		return isVolatile(value) ? value.get() : value;
	};
	return {
		loomyEnabled: () => bool(field("loomyEnabled"), true),
		raccoonEnabled: () => bool(field("raccoonEnabled"), true),
		traeEnabled: () => bool(field("traeEnabled"), true),
		traeRegion: () => normalizeTraeRegion(field("traeRegion")),
		codeartsEnabled: () => bool(field("codeartsEnabled"), true),
		loomyDisplayName: () => nonEmpty(field("loomyDisplayName"), "Loomy"),
		raccoonDisplayName: () => nonEmpty(field("raccoonDisplayName"), "商汤小浣熊"),
		traeDisplayName: () => nonEmpty(field("traeDisplayName"), "Trae"),
		codeartsDisplayName: () => nonEmpty(field("codeartsDisplayName"), "华为云 CodeArts"),
		loomyDisabledModels: () => stringList(field("loomyDisabledModels")),
		raccoonDisabledModels: () => stringList(field("raccoonDisabledModels")),
		traeDisabledModels: () => stringList(field("traeDisabledModels")),
		codeartsDisabledModels: () => stringList(field("codeartsDisabledModels")),
		loomyModelContextWindows: () => numberMap(field("loomyModelContextWindows")),
		raccoonModelContextWindows: () => numberMap(field("raccoonModelContextWindows")),
		traeModelContextWindows: () => numberMap(field("traeModelContextWindows")),
		codeartsModelContextWindows: () => numberMap(field("codeartsModelContextWindows")),
		loomyModelAliases: () => stringMap(field("loomyModelAliases")),
		raccoonModelAliases: () => stringMap(field("raccoonModelAliases")),
		traeModelAliases: () => stringMap(field("traeModelAliases")),
		codeartsModelAliases: () => stringMap(field("codeartsModelAliases")),
		loomyVisionModelIds: () => stringList(field("loomyVisionModelIds")),
		loomyTextOnlyModelIds: () => stringList(field("loomyTextOnlyModelIds")),
		raccoonVisionModelIds: () => stringList(field("raccoonVisionModelIds")),
		raccoonTextOnlyModelIds: () => stringList(field("raccoonTextOnlyModelIds")),
		traeVisionModelIds: () => stringList(field("traeVisionModelIds")),
		traeTextOnlyModelIds: () => stringList(field("traeTextOnlyModelIds")),
		codeartsVisionModelIds: () => stringList(field("codeartsVisionModelIds")),
		codeartsTextOnlyModelIds: () => stringList(field("codeartsTextOnlyModelIds")),
		defaultMaxTokens: () => positive(field("defaultMaxTokens"), 32e3),
		modelCacheTtlMs: () => positive(field("modelCacheTtlSeconds"), 120) * 1e3,
		catalogFetchTimeoutMs: () => positive(field("catalogFetchTimeoutSeconds"), 20) * 1e3,
		openRouterSyncMinutes: () => nonNegative(field("openRouterSyncMinutes"), 60),
		raccoonCheckinMinutes: () => nonNegative(field("raccoonCheckinMinutes"), 30)
	};
}
function resolveConfig(config) {
	const live = liveConfig(config);
	return {
		loomyEnabled: live.loomyEnabled(),
		raccoonEnabled: live.raccoonEnabled(),
		traeEnabled: live.traeEnabled(),
		traeRegion: live.traeRegion(),
		codeartsEnabled: live.codeartsEnabled(),
		loomyDisplayName: live.loomyDisplayName(),
		raccoonDisplayName: live.raccoonDisplayName(),
		traeDisplayName: live.traeDisplayName(),
		codeartsDisplayName: live.codeartsDisplayName(),
		loomyDisabledModels: live.loomyDisabledModels(),
		raccoonDisabledModels: live.raccoonDisabledModels(),
		traeDisabledModels: live.traeDisabledModels(),
		codeartsDisabledModels: live.codeartsDisabledModels(),
		loomyModelContextWindows: live.loomyModelContextWindows(),
		raccoonModelContextWindows: live.raccoonModelContextWindows(),
		traeModelContextWindows: live.traeModelContextWindows(),
		codeartsModelContextWindows: live.codeartsModelContextWindows(),
		loomyModelAliases: live.loomyModelAliases(),
		raccoonModelAliases: live.raccoonModelAliases(),
		traeModelAliases: live.traeModelAliases(),
		codeartsModelAliases: live.codeartsModelAliases(),
		loomyVisionModelIds: live.loomyVisionModelIds(),
		loomyTextOnlyModelIds: live.loomyTextOnlyModelIds(),
		raccoonVisionModelIds: live.raccoonVisionModelIds(),
		raccoonTextOnlyModelIds: live.raccoonTextOnlyModelIds(),
		traeVisionModelIds: live.traeVisionModelIds(),
		traeTextOnlyModelIds: live.traeTextOnlyModelIds(),
		codeartsVisionModelIds: live.codeartsVisionModelIds(),
		codeartsTextOnlyModelIds: live.codeartsTextOnlyModelIds(),
		defaultMaxTokens: live.defaultMaxTokens(),
		modelCacheTtlMs: live.modelCacheTtlMs(),
		catalogFetchTimeoutMs: live.catalogFetchTimeoutMs(),
		openRouterSyncMinutes: live.openRouterSyncMinutes(),
		raccoonCheckinMinutes: live.raccoonCheckinMinutes()
	};
}
function text$3(value) {
	return typeof value === "string" ? value.trim() : "";
}
function nonEmpty(value, fallback) {
	const valueText = text$3(value);
	return valueText.length > 0 ? valueText : fallback;
}
function positive(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function nonNegative(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function stringList(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}
function numberMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "number" && Number.isFinite(entry) && entry > 0) out[key] = entry;
	return out;
}
function stringMap(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string" && entry.trim().length > 0) out[key] = entry.trim();
	return out;
}
// src/codearts-login.ts
/**
* CodeArts browser sign-in: a loopback callback server plus the portal handoff.
*
* The flow is two-legged and both legs matter:
*
* 1. The settings page asks the host to start; the host opens a loopback server
*    on a port ≥ 10000 (the portal refuses lower ones) and returns the portal
*    URL. The page opens that URL in a normal browser tab.
* 2. Huawei redirects to `http://127.0.0.1:<port>/oauth/callback?code=…`; the
*    host exchanges the code (PKCE + DPoP), stores the credential and closes the
*    server. The page polls `/account/browser` and adopts the account.
*
* The portal can also answer the *legacy* way, with `?secret=` instead of a
* code. That branch polls the ticket endpoint for a plain AK/SK/ST triple: it
* still signs correctly, but it carries no refresh token, so the account lasts
* two hours and then needs another sign-in. Both branches are reported as
* success — hiding the second one would leave users stuck on a page that says
* "waiting" forever.
*
* @module dsh-llm-adapters/codearts-login
*/
/** The portal rejects callback ports below 10000. */
const MIN_CALLBACK_PORT = 1e4;
const DEFAULT_TIMEOUT_MS$2 = 18e4;
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type"
};
/** Listen on loopback, retrying with a high port when the kernel picks a low one. */
async function listenHigh(server, attempt = 0) {
	return new Promise((resolve, reject) => {
		const onError = (error) => reject(error);
		server.once("error", onError);
		server.listen(attempt === 0 ? 0 : MIN_CALLBACK_PORT + Math.floor(Math.random() * 55536), "127.0.0.1", () => {
			server.removeListener("error", onError);
			const port = server.address()?.port ?? 0;
			if (port >= MIN_CALLBACK_PORT || attempt >= 3) {
				resolve(port);
				return;
			}
			server.close(() => {
				listenHigh(server, attempt + 1).then(resolve, reject);
			});
		});
	});
}
/** Poll the legacy ticket endpoint until the credential appears. */
async function pollTicket(ticketId, secret, fetcher) {
	const url = `${CODEARTS_SNAP_BASE}/snap-manager/v1/login/ticket?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
	for (let attempt = 0; attempt < 30; attempt++) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1e3));
		try {
			const response = await fetcher(url, {
				headers: {
					"content-type": "application/json;charset=UTF-8",
					"plugin-name": CODEARTS_LOGIN_PLUGIN_NAME,
					"plugin-version": CODEARTS_LOGIN_PLUGIN_VERSION
				},
				signal: AbortSignal.timeout(15e3)
			});
			if (!response.ok) continue;
			const body = await response.json();
			const credential = body.credential;
			const result = body.result;
			const ak = String(credential?.access ?? result?.accessKeyId ?? "");
			const st = String(credential?.securitytoken ?? credential?.securityToken ?? result?.securityToken ?? "");
			const sk = String(credential?.secret ?? result?.secretAccessKey ?? "");
			if (ak !== "" && st !== "") {
				const raw = String(credential?.expires_at ?? result?.expiration ?? "");
				const expiresAt = Date.parse(raw);
				return {
					accessKeyId: ak,
					secretAccessKey: sk,
					securityToken: st,
					...Number.isNaN(expiresAt) ? {} : { expiresAt }
				};
			}
		} catch {}
	}
}
/**
* One in-flight sign-in.
*
* A second `start()` while one is running returns the existing status: two
* callback servers would race for the same credential and the losing one would
* report a spurious timeout.
*/
var CodeArtsLogin = class {
	options;
	server;
	state = {
		running: false,
		phase: "idle"
	};
	timer;
	ticketId = "";
	keyPair;
	pkce;
	constructor(options) {
		this.options = options;
	}
	get fetcher() {
		return this.options.fetcher ?? fetch;
	}
	status() {
		return { ...this.state };
	}
	async start() {
		if (this.state.running) return this.status();
		await this.dispose();
		const ticketId = randomUUID();
		const pkce = generatePkcePair();
		const keyPair = generateDpopKeyPair();
		this.ticketId = ticketId;
		this.pkce = pkce;
		this.keyPair = keyPair;
		const server = createServer((request, response) => {
			this.handle(request.url ?? "/", response);
		});
		const port = await listenHigh(server);
		this.server = server;
		const url = buildAuthorizeUrl(port, pkce, ticketId);
		this.state = {
			running: true,
			phase: "waiting",
			url,
			startedAt: Date.now(),
			message: "已打开华为云登录页：完成授权后会自动接回，无需复制任何令牌。"
		};
		const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS$2;
		this.timer = setTimeout(() => {
			this.fail(/* @__PURE__ */ new Error(`登录超时（${Math.round(timeout / 6e4)} 分钟）。请重新点一次登录。`));
		}, timeout);
		this.timer.unref?.();
		return this.status();
	}
	async handle(rawUrl, response) {
		let url;
		try {
			url = new URL(rawUrl, "http://127.0.0.1");
		} catch {
			response.writeHead(400, CORS_HEADERS).end("Bad request");
			return;
		}
		if (!url.pathname.startsWith("/oauth/callback")) {
			response.writeHead(404, CORS_HEADERS).end("Not found");
			return;
		}
		if (url.searchParams.get("code") === null && url.searchParams.get("secret") === null) {
			response.writeHead(400, CORS_HEADERS).end("Missing authorization code");
			return;
		}
		const code = url.searchParams.get("code");
		const secret = url.searchParams.get("secret");
		if (secret !== null) {
			response.writeHead(307, {
				...CORS_HEADERS,
				location: buildLoginResultUrl(true)
			}).end();
			const credential = await pollTicket(this.ticketId, secret, this.fetcher);
			if (credential === void 0) {
				this.fail(/* @__PURE__ */ new Error("华为云没有返回凭据，请重新登录。"));
				return;
			}
			await this.finish(credential);
			return;
		}
		const port = (this.server?.address())?.port ?? 0;
		const pkce = this.pkce;
		const keyPair = this.keyPair;
		if (pkce === void 0 || keyPair === void 0) {
			response.writeHead(400, CORS_HEADERS).end("No login in progress");
			return;
		}
		try {
			const credential = await exchangeAuthorizationCode(code, pkce.codeVerifier, port, keyPair, this.fetcher);
			response.writeHead(307, {
				...CORS_HEADERS,
				location: buildLoginResultUrl(true)
			}).end();
			await this.finish(credential);
		} catch (error) {
			response.writeHead(307, {
				...CORS_HEADERS,
				location: buildLoginResultUrl(false)
			}).end();
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}
	async finish(credential) {
		await this.options.save({
			...credential,
			loginAt: Date.now()
		});
		this.state = {
			running: false,
			phase: "done",
			signedIn: true,
			startedAt: this.state.startedAt,
			finishedAt: Date.now(),
			message: "登录成功。"
		};
		await this.dispose();
	}
	fail(error) {
		this.state = {
			running: false,
			phase: "error",
			error: error.message,
			startedAt: this.state.startedAt,
			finishedAt: Date.now()
		};
		this.options.logger?.(`codearts login: ${error.message}`);
		this.dispose();
	}
	async cancel() {
		if (this.state.running) this.state = {
			running: false,
			phase: "cancelled",
			finishedAt: Date.now()
		};
		await this.dispose();
	}
	async close() {
		await this.cancel();
	}
	async dispose() {
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		const server = this.server;
		this.server = void 0;
		if (server !== void 0) await new Promise((resolve) => server.close(() => resolve()));
	}
};
// src/codearts-sign.ts
/**
* Huawei `SDK-HMAC-SHA256` request signing.
*
* The gateway verifies a canonical request built from the method, the path
* (with a trailing slash), the raw query string, a sorted set of headers and
* the SHA-256 of the body. Two details are easy to get wrong and both fail as a
* generic `APIG.0301 verify ak sk signature fail`:
*
* 1. The path must end with `/` even when the URL does not.
* 2. `host` participates in the signature but must not be sent as a header —
*    `fetch` derives it from the URL.
*
* `extraHeaders` (only `maas_type: benefit` in practice) **does** participate:
* dropping it from the signed set makes the gateway reject the request.
*
* @module dsh-llm-adapters/codearts-sign
*/
function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}
function hmacSha256Hex(key, data) {
	return createHmac("sha256", key).update(data).digest("hex");
}
/** Huawei's timestamp form: `20261026T133000Z`. */
function sdkDateStamp(now = /* @__PURE__ */ new Date()) {
	return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}
/**
* Sign one request and return every header that must accompany it.
*
* The returned map still contains `host`; callers drop it before calling
* `fetch`, because a hand-set `Host` is either ignored or rejected.
*/
async function signRequestHuawei(ak, sk, securityToken, method, urlStr, body = "", extraHeaders) {
	const url = new URL(urlStr);
	let uri = url.pathname;
	if (!uri.endsWith("/")) uri += "/";
	const query = url.search.slice(1);
	const dateStamp = sdkDateStamp();
	const payloadHash = sha256Hex(typeof body === "string" ? body : Buffer.from(body));
	const headers = /* @__PURE__ */ new Map();
	headers.set("host", url.host);
	headers.set("x-sdk-date", dateStamp);
	headers.set("x-sdk-content-sha256", payloadHash);
	headers.set("x-security-token", securityToken);
	if (extraHeaders !== void 0) for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
	if (method.toUpperCase() !== "GET") headers.set("content-type", "application/json");
	const signedHeaders = [...headers.keys()].sort();
	const signature = hmacSha256Hex(sk, `SDK-HMAC-SHA256\n${dateStamp}\n${sha256Hex([
		method.toUpperCase(),
		uri,
		query,
		signedHeaders.map((key) => `${key}:${headers.get(key) ?? ""}`).join("\n"),
		"",
		signedHeaders.join(";"),
		payloadHash
	].join("\n"))}`);
	headers.set("Authorization", `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(";")},Signature=${signature}`);
	return headers;
}
/** The signed headers minus `host`, ready to merge into a request. */
function headersForFetch(signed) {
	const out = {};
	for (const [key, value] of signed) {
		if (key === "host") continue;
		out[key] = value;
	}
	return out;
}
// src/codearts-window.ts
/**
* The trial plan's chat budget.
*
* The gateway opens one "session" per chat request and allows **three per
* rolling minute** for the whole account. The window is shared by every model,
* it is not keyed by `session-id` (re-sending the same id does not buy a slot),
* and a request rejected with `InferHub.4004.200` spends a slot just like a
* successful one. Measured behaviour, three slots then a lockout:
*
* ```
* t+0s   ok ok ok cap cap cap     burst of six
* t+10s  cap                      …
* t+51s  cap
* t+61s  ok ok ok                 the burst ages out of the window
* ```
*
* So a turn cannot be made to "go faster" by retrying: the only way a request
* stops failing is to spend the budget deliberately — wait for the oldest start
* to age out instead of firing into a wall. This class owns that bookkeeping and
* is shared by every provider instance in the process, because a hot reload
* must not reset the count the gateway still remembers.
*
* @module dsh-llm-adapters/codearts-window
*/
/** Sessions the trial plan allows inside one window. */
const CODEARTS_SESSION_LIMIT = 3;
/** How long a start keeps its slot. Measured: the burst frees at ~60 s. */
const CODEARTS_SESSION_WINDOW_MS = 6e4;
/** A little slack so a request never lands a few milliseconds early. */
const MARGIN_MS = 1500;
function sleep$2(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
var CodeArtsSessionWindow = class {
	limit;
	windowMs;
	now;
	starts = [];
	/** Serialises waiters so two callers cannot both take the last slot. */
	tail = Promise.resolve();
	constructor(limit = 3, windowMs = CODEARTS_SESSION_WINDOW_MS, now = Date.now) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.now = now;
	}
	/** Starts recorded inside the current window. */
	get size() {
		this.trim();
		return this.starts.length;
	}
	/** Milliseconds until another start fits; `0` when the window has room. */
	waitMs() {
		this.trim();
		if (this.starts.length < this.limit) return 0;
		const oldest = this.starts[0] ?? 0;
		return Math.max(0, this.windowMs - (this.now() - oldest));
	}
	/**
	* Claim a slot, waiting for the window to roll over when it is full.
	*
	* The slot is recorded on return, not on completion: the gateway counts the
	* start, and holds it for a fixed time whether the answer was short or long.
	*/
	async open(signal) {
		const run = this.tail.then(async () => {
			for (;;) {
				const wait = this.waitMs();
				if (wait === 0) {
					const start = this.now();
					this.starts.push(start);
					return { release: () => {
						const index = this.starts.indexOf(start);
						if (index >= 0) this.starts.splice(index, 1);
					} };
				}
				await sleep$2(wait + MARGIN_MS, signal);
			}
		});
		this.tail = run.then(() => void 0, () => void 0);
		return await run;
	}
	/** Forget every start (tests, and a fresh login on another account). */
	reset() {
		this.starts.length = 0;
	}
	trim() {
		const now = this.now();
		while (this.starts.length > 0 && now - (this.starts[0] ?? 0) >= this.windowMs) this.starts.shift();
	}
};
let shared;
/** The process-wide window; a plugin reload reuses it on purpose. */
function sharedSessionWindow() {
	shared ??= new CodeArtsSessionWindow();
	return shared;
}
// src/openrouter.ts
/**
* Live capability lookup from OpenRouter's public model catalog.
*
* Raccoon's own catalog does not expose reasoning-effort levels, and both
* providers carry names the model vendor spells differently (`GLM-5-3` vs
* `GLM 5.3`). OpenRouter publishes `reasoning.supported_efforts` and
* `architecture.input_modalities`, so this module fetches that catalog on
* demand and matches entries by normalized name.
*
* The data is fetched at runtime, refreshed by the plugin's scheduler, and kept
* on disk, so a temporary outage keeps the last successful snapshot instead of
* silently dropping every capability control.
*
* @module dsh-llm-adapters/openrouter
*/
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const REQUEST_TIMEOUT_MS$2 = 2e4;
const CACHE_VERSION = 1;
const EMPTY_OPENROUTER_INDEX = {
	models: [],
	match: () => void 0
};
function recordOf(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringsOf(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter((entry) => entry.length > 0);
}
function textOf(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/** OpenRouter ids carry a vendor prefix; upstream Raccoon ids often carry `sn-`. */
function openRouterIdKey(id) {
	const withoutTilde = id.startsWith("~") ? id.slice(1) : id;
	const slash = withoutTilde.lastIndexOf("/");
	return modelKey(slash >= 0 ? withoutTilde.slice(slash + 1) : withoutTilde);
}
/** OpenRouter display names look like `MoonshotAI: Kimi K3`; the tail is the model. */
function openRouterNameKey(name) {
	const colon = name.indexOf(":");
	return modelKey(colon >= 0 ? name.slice(colon + 1) : name);
}
/** Prefer canonical entries over batch and `~latest` aliases when keys collide. */
function variantScore(model) {
	return (model.id.startsWith("~") ? 10 : 0) + (model.id.includes(":batch") ? 5 : 0);
}
/**
* Containment score for a normalized upstream name against a normalized
* OpenRouter name. A shorter needle inside a longer candidate is the common
* case (upstream drops a version suffix); the reverse is allowed at a lower
* score so a vendor suffix does not defeat the match.
*/
function wildcardScore(needle, candidate) {
	if (needle.length < 5 || candidate.length < 5) return 0;
	if (candidate === needle) return 100;
	if (candidate.startsWith(needle)) return 80;
	if (candidate.endsWith(needle)) return 70;
	if (candidate.includes(needle)) return 60;
	if (needle.includes(candidate)) return 50;
	return 0;
}
function buildOpenRouterIndex(models) {
	const byName = /* @__PURE__ */ new Map();
	const byId = /* @__PURE__ */ new Map();
	const indexed = [];
	for (const model of models) {
		const nameKey = openRouterNameKey(model.name);
		const idKey = openRouterIdKey(model.id);
		const keys = [...new Set([nameKey, idKey].filter((key) => key.length > 0))];
		indexed.push({
			model,
			keys,
			variant: variantScore(model)
		});
		for (const [map, key] of [[byName, nameKey], [byId, idKey]]) {
			if (key.length === 0) continue;
			const existing = map.get(key);
			if (existing === void 0) map.set(key, model);
			else if (existing === null) continue;
			else if (existing !== model) {
				const currentVariant = variantScore(model);
				const existingVariant = variantScore(existing);
				if (currentVariant < existingVariant) map.set(key, model);
				else if (currentVariant > existingVariant) continue;
				else map.set(key, null);
			}
		}
	}
	const wildcard = (needle) => {
		if (needle.length < 5) return void 0;
		let best;
		let ambiguous = false;
		for (const entry of indexed) {
			let score = 0;
			for (const key of entry.keys) score = Math.max(score, wildcardScore(needle, key));
			if (score === 0) continue;
			if (best === void 0 || score > best.score || score === best.score && entry.variant < best.variant) {
				best = {
					model: entry.model,
					score,
					variant: entry.variant
				};
				ambiguous = false;
			} else if (score === best.score && entry.variant === best.variant && entry.model.id !== best.model.id) ambiguous = true;
		}
		return ambiguous ? void 0 : best?.model;
	};
	return {
		models,
		match(name, id) {
			const nameKey = modelKey(name);
			const idKey = id === void 0 ? "" : modelKey(id);
			const exactName = nameKey.length === 0 ? void 0 : byName.get(nameKey);
			if (exactName !== void 0) return exactName ?? void 0;
			const exactId = idKey.length === 0 ? void 0 : byId.get(idKey);
			if (exactId !== void 0) return exactId ?? void 0;
			return wildcard(nameKey) ?? wildcard(idKey);
		}
	};
}
/** Parse the subset of `GET /api/v1/models` this plugin uses. */
function parseOpenRouterModels(payload) {
	const root = recordOf(payload);
	const data = Array.isArray(root.data) ? root.data : [];
	const out = [];
	for (const candidate of data) {
		const record = recordOf(candidate);
		const id = textOf(record.id);
		if (id === void 0) continue;
		const name = textOf(record.name) ?? id;
		const architecture = recordOf(record.architecture);
		const reasoning = recordOf(record.reasoning);
		const mandatory = reasoning.mandatory === true;
		const declared = stringsOf(reasoning.supported_efforts);
		const efforts = mandatory ? declared.filter((effort) => effort !== "none") : declared;
		out.push({
			id,
			name,
			inputModalities: stringsOf(architecture.input_modalities).map((mode) => mode.toLowerCase()),
			...efforts.length === 0 ? {} : { efforts },
			...textOf(reasoning.default_effort) === void 0 ? {} : { defaultEffort: textOf(reasoning.default_effort) },
			mandatory
		});
	}
	return out;
}
/** Validate one model read back from the on-disk cache. */
function storedModel(value) {
	const record = recordOf(value);
	const id = textOf(record.id);
	const name = textOf(record.name);
	if (id === void 0 || name === void 0) return void 0;
	return {
		id,
		name,
		inputModalities: stringsOf(record.inputModalities),
		...Array.isArray(record.efforts) ? { efforts: stringsOf(record.efforts) } : {},
		...textOf(record.defaultEffort) === void 0 ? {} : { defaultEffort: textOf(record.defaultEffort) },
		mandatory: record.mandatory === true
	};
}
/**
* A persistent, atomically-replaced OpenRouter snapshot.
*
* `models()` never triggers a network request once a snapshot exists: refreshes
* are driven by {@link sync}, which the plugin calls on a schedule and the
* settings page can trigger. A failed sync leaves both the in-memory and the
* on-disk copy untouched, so an offline start still has the last known levels
* and modalities.
*/
var OpenRouterCatalog = class {
	fetchImpl;
	options;
	snapshot;
	inflight;
	lastError;
	constructor(fetchImpl = fetch, options = {}) {
		this.fetchImpl = fetchImpl;
		this.options = options;
		this.loadFromDisk();
	}
	loadFromDisk() {
		const file = this.options.cacheFile;
		if (file === void 0) return;
		try {
			const document = recordOf(JSON.parse(readFileSync(file, "utf8")));
			if (document.version !== CACHE_VERSION || !Array.isArray(document.models) || typeof document.at !== "number") return;
			const models = document.models.map(storedModel).filter((model) => model !== void 0);
			if (models.length === 0) return;
			this.snapshot = {
				index: buildOpenRouterIndex(models),
				at: document.at
			};
		} catch {}
	}
	/** Replace the cache file only after the new document is complete (tmp + rename). */
	persist(models, at) {
		const file = this.options.cacheFile;
		if (file === void 0) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
			const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(temporary, JSON.stringify({
				version: CACHE_VERSION,
				at,
				models
			}), {
				encoding: "utf8",
				mode: 384
			});
			renameSync(temporary, file);
		} catch {}
	}
	async fetchAndReplace() {
		try {
			const response = await this.fetchImpl(OPENROUTER_MODELS_URL, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$2)
			});
			if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}`);
			const models = parseOpenRouterModels(await response.json());
			if (models.length === 0) throw new Error("OpenRouter 没有返回任何模型");
			const index = buildOpenRouterIndex(models);
			const at = Date.now();
			this.snapshot = {
				index,
				at
			};
			this.lastError = void 0;
			this.persist(models, at);
			return {
				ok: true,
				models: models.length,
				at,
				syncing: false
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = message;
			return {
				ok: false,
				models: this.snapshot?.index.models.length ?? 0,
				...this.snapshot === void 0 ? {} : { at: this.snapshot.at },
				error: message,
				syncing: false
			};
		}
	}
	/**
	* Fetch and replace the snapshot. Concurrent callers share one request, and
	* a failure keeps the previous snapshot and reports why.
	*/
	sync() {
		if (this.inflight !== void 0) return this.inflight;
		this.inflight = this.fetchAndReplace().finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	async models(fresh = false) {
		if (fresh || this.snapshot === void 0) await this.sync();
		return this.snapshot?.index ?? EMPTY_OPENROUTER_INDEX;
	}
	/** A read-only reading for the settings card; never starts a request. */
	status() {
		return {
			models: this.snapshot?.index.models.length ?? 0,
			...this.snapshot === void 0 ? {} : { at: this.snapshot.at },
			...this.lastError === void 0 ? {} : { error: this.lastError },
			syncing: this.inflight !== void 0
		};
	}
	/** Drop the in-memory copy; the next read refetches (the file stays). */
	invalidate() {
		this.snapshot = void 0;
		this.lastError = void 0;
	}
};
// src/codearts.ts
/**
* Huawei CodeArts (码道) gateway client.
*
* Three things separate it from the other routes:
*
* 1. **No bearer token.** Every call is signed (`SDK-HMAC-SHA256`) with the
*    AK/SK/security-token triple from the OAuth exchange.
* 2. **The catalogue is two rosters.** `opengw gateway/config` lists the
*    free-allowance ("benefit") models and `/v1/model/builtin` the ordinary
*    ones; a model is only callable on the roster that listed it.
* 3. **No context window anywhere.** The upstream publishes none, so the value
*    comes from the IDE's own provider configuration (see
*    {@link codeartsContextWindow}).
*
* @module dsh-llm-adapters/codearts
*/
/**
* Levels the gateway accepts, plus the two-state switch this route started with.
*
* `reasoning_effort` is validated per model (deepseek accepts
* `none|low|medium|high|xhigh|max`, glm-5.3 rejects `none` outright), and the
* IDE's own client offers the levels, so they are forwarded as-is. Whether a
* level changes the answer is up to the model: on a proof prompt
* `deepseek-v4.1-flash` spent 388 reasoning tokens on `none`, 480 on `low`,
* 515 on `max` and 595 with the field omitted. `off` (and a legacy `none`)
* keeps using the one switch that definitely works, `thinking: disabled`;
* `on` is the old default and sends neither field.
*/
const CODEARTS_DEFAULT_EFFORT = "on";
/**
* The levels one model offers: `off` / `on` always, then the graded levels the
* gateway validates and OpenRouter says the model accepts.
*
* The router's list is intersected with {@link CODEARTS_EFFORT_LEVELS} rather
* than copied, so an editor-only level (`minimal`) never reaches a model that
* answers 4xx for it. A model the router does not list, and a router with no
* snapshot yet, keep every graded level: hiding controls the upstream does
* accept is worse than offering one that has no measured effect.
*/
function codeartsEfforts(live) {
	const declared = live?.efforts;
	return [
		"off",
		"on",
		...declared === void 0 ? [...CODEARTS_EFFORT_LEVELS] : CODEARTS_EFFORT_LEVELS.filter((level) => declared.includes(level))
	];
}
/** Every level a CodeArts model can get: the fallback when the router is silent. */
const CODEARTS_EFFORTS = codeartsEfforts();
function record$3(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text$2(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function num$1(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
}
/**
* Unwrap the `{ code, message, data }` envelope the ops endpoints use.
*
* The catalogue and `statistics/plugin` answer with a bare object instead, so
* only the calls known to be enveloped go through here. A non-zero business
* code is a failure even though the HTTP status is 200.
*/
function unwrapEnvelope(payload) {
	if (payload === void 0) return void 0;
	const code = payload.code;
	if (typeof code !== "number") return payload;
	if (code !== 0) return void 0;
	return record$3(payload.data);
}
/** `deepseek-v4-flash-0731` → `deepseek-v4-flash`; chat only knows the latter. */
function normalizeCodeArtsModelId(id) {
	return /^(.*)-\d{4}$/.exec(id)?.[1] ?? id;
}
/**
* Pick the credit entry that applies right now.
*
* `deepseek-v4.1-flash` carries two: 0.18x by default and 0.09x from 21:00 for
* eleven hours. Showing `credit[0]` would advertise the wrong number for a third
* of the day. Only the measured shape is understood (an hour-of-day start plus
* an hour count); anything else falls back to the first entry, which is exactly
* how the upstream behaves when a model has no slots at all.
*/
function pickActiveCredit(credit, slots, nowMs = Date.now()) {
	const entries = credit.map((entry) => record$3(entry)).filter((entry) => entry !== void 0);
	if (entries.length === 0) return void 0;
	const table = record$3(slots);
	if (table === void 0) return entries[0];
	for (const entry of entries) {
		const slotId = text$2(entry.time_slot_id);
		if (slotId === void 0) continue;
		const slot = record$3(table[slotId]);
		if (slot === void 0) continue;
		if (slotActive(slot, nowMs)) return entry;
	}
	return entries[0];
}
function slotActive(slot, nowMs) {
	const schedule = text$2(slot.schedule);
	if (schedule === void 0) return false;
	const parts = schedule.split(/\s+/);
	if (parts.length < 3) return false;
	const minute = Number(parts[1]);
	const hour = Number(parts[2]);
	if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
	const duration = Number(slot.duration);
	if (!Number.isFinite(duration) || duration <= 0) return false;
	if (slot.timeunit !== "hour") return false;
	return (Math.floor((nowMs + 288e5) / 6e4) % 1440 - (hour * 60 + minute) + 1440) % 1440 < duration * 60;
}
/** Read one roster into rows, dropping duplicates. */
function parseCodeArtsRoster(items, nowMs = Date.now()) {
	if (!Array.isArray(items)) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const item of items) {
		const entry = record$3(item);
		if (entry === void 0) continue;
		const rawId = text$2(entry.model_id);
		if (rawId === void 0) continue;
		const id = normalizeCodeArtsModelId(rawId);
		const key = id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const rateLabel = text$2(pickActiveCredit(Array.isArray(entry.credit) ? entry.credit : [], entry.time_slots, nowMs)?.ratio_display);
		out.push({
			id,
			name: text$2(entry.model_name) ?? id,
			...rateLabel === void 0 ? {} : { rateLabel },
			...entry.supports_images === true ? { images: true } : {}
		});
	}
	return out;
}
/** `0.7x` → `0.7`; anything else is left alone rather than guessed. */
function priceFactorOfLabel(label) {
	if (label === void 0) return void 0;
	const match = /^(\d+(?:\.\d+)?)\s*x$/i.exec(label.trim());
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : void 0;
}
function isVisionModel(id) {
	return CODEARTS_VISION_MODELS.some((entry) => entry.toLowerCase() === id.toLowerCase());
}
/** Raised inside the stream loop for conditions a retry can fix. */
var CodeArtsRetry = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "CodeArtsRetry";
	}
};
const QUEUE_MARKERS = [
	"TM.00001041",
	"ModelArts.81111.429",
	"too many requests",
	"queue"
];
const AUTH_MARKERS = [
	"APIG.0602",
	"APIG.0301",
	"invalid token",
	"token expired",
	"not logged in"
];
function classifyFailure(status, body) {
	const lower = body.toLowerCase();
	if (body.includes("InferHub.4004.200")) return new CodeArtsRetry("benefit", "该账号没有这个模型的免费额度包");
	if (status === 401 || status === 403 || AUTH_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return new CodeArtsRetry("auth", body === "" ? `HTTP ${status}` : body);
	if (status === 429 || QUEUE_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return new CodeArtsRetry("queue", body === "" ? `HTTP ${status}` : body);
	if (body.includes("InferHub.4291.200") || lower.includes("insufficient balance") || lower.includes("quota")) return new ProviderHttpError("CodeArts 额度已用完。可换一个模型，或等免费额度重置后再试。", 402);
	return new ProviderHttpError(body === "" ? `HTTP ${status}` : body.slice(0, 400), status);
}
const sleep$1 = (ms, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted === true) {
		reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
		return;
	}
	const onAbort = () => {
		clearTimeout(timer);
		reject(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal?.addEventListener("abort", onAbort, { once: true });
});
/** Retries for a gateway that is busy for reasons the window cannot predict. */
const QUEUE_ATTEMPTS = 3;
/** Minimum pause before retrying a rejected call; the window adds its own. */
const QUEUE_BACKOFF_MS = 2e4;
/**
* The message a user sees once waiting is hopeless.
*
* The raw gateway text (`TM.00001041`) reads like a bug; the limit is the
* trial plan's, and the only fix on this side is to say so.
*/
function queueExhausted() {
	return new ProviderHttpError("CodeArts 体验版每分钟只允许 3 个会话，当前已被占满。请稍等片刻再发，或关闭其它 CodeArts 会话。", 429);
}
var CodeArtsProvider = class {
	options;
	catalog;
	login;
	quotaSnapshot;
	quotaInflight;
	benefitModels = new Set(CODEARTS_BENEFIT_FALLBACK);
	/** Models that answered `InferHub.4004.200`: no allowance pack to bill. */
	noBenefit = /* @__PURE__ */ new Set();
	noBenefitLoaded = false;
	window;
	openRouter;
	sessionId = randomUUID();
	constructor(options) {
		this.options = options;
		this.window = options.window ?? sharedSessionWindow();
		this.openRouter = options.openRouter ?? new OpenRouterCatalog(options.fetchImpl ?? fetch);
		this.catalog = new ModelCatalog(() => this.loadModels(), options.ttlMs);
		this.login = new CodeArtsLogin({
			...options.loginTimeoutMs === void 0 ? {} : { timeoutMs: options.loginTimeoutMs },
			...options.fetchImpl === void 0 ? {} : { fetcher: options.fetchImpl },
			...options.logger === void 0 ? {} : { logger: options.logger },
			save: async (account) => {
				await options.store.saveCodearts(account);
				this.window.reset();
				this.noBenefit.clear();
				this.invalidateModels();
				this.invalidateQuota();
			}
		});
	}
	get fetcher() {
		return this.options.fetchImpl ?? fetch;
	}
	async credential() {
		return this.options.auth.credential();
	}
	async models(fresh = false) {
		return this.catalog.models(fresh);
	}
	catalogError() {
		return this.catalog.error();
	}
	invalidateModels() {
		this.catalog.invalidate();
	}
	/** Signed GET returning the parsed body, or `undefined` on any failure. */
	async signedGet(credential, url) {
		const signed = await signRequestHuawei(credential.accessKeyId, credential.secretAccessKey, credential.securityToken, "GET", url);
		try {
			const response = await this.fetcher(url, {
				method: "GET",
				headers: {
					...headersForFetch(signed),
					...CODEARTS_EXTRA_HEADERS,
					accept: "application/json"
				},
				signal: AbortSignal.timeout(this.options.timeoutMs())
			});
			if (!response.ok) return void 0;
			return await response.json();
		} catch {
			return;
		}
	}
	async loadModels() {
		const credential = await this.credential();
		const now = Date.now();
		const gateway = await this.signedGet(credential, CODEARTS_GATEWAY_CONFIG_URL);
		const builtin = await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_MODEL_BUILTIN_PATH}`);
		const gatewayRows = parseCodeArtsRoster(record$3(record$3(gateway)?.result)?.models, now);
		const builtinRows = parseCodeArtsRoster(record$3(builtin)?.builtinModels, now);
		if (gatewayRows.length === 0 && builtinRows.length === 0) throw new Error("CodeArts 没有返回任何模型（签名、凭据或网关异常）");
		if (gatewayRows.length > 0) this.benefitModels = new Set(gatewayRows.map((row) => row.id));
		const textOnly = this.options.textOnly();
		const forceVision = this.options.forceVision();
		const index = await this.openRouter.models().catch(() => void 0);
		const rows = [];
		const seen = /* @__PURE__ */ new Set();
		for (const row of [...gatewayRows, ...builtinRows]) {
			const key = row.id.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			const vision = textOnly.has(row.id) ? false : forceVision.has(row.id) || row.images === true || isVisionModel(row.id);
			const factor = priceFactorOfLabel(row.rateLabel);
			rows.push({
				id: row.id,
				name: row.name,
				contextWindow: codeartsContextWindow(row.id),
				maxTokens: CODEARTS_MAX_OUTPUT_TOKENS,
				vision,
				reasoning: true,
				reasoningEfforts: codeartsEfforts(index?.match(parseModelName(row.name).name, row.id)),
				defaultReasoningEffort: "on",
				...factor === void 0 ? {} : { priceFactor: factor }
			});
		}
		return rows;
	}
	/** Whether this model must be called with `maas_type: benefit`. */
	isBenefitModel(model) {
		const key = model.trim().toLowerCase();
		if (this.noBenefit.has(key)) return false;
		for (const id of this.benefitModels) if (id.toLowerCase() === key) return true;
		return false;
	}
	/** Load the persisted "no allowance pack" verdicts once. */
	async loadNoBenefit() {
		if (this.noBenefitLoaded) return;
		this.noBenefitLoaded = true;
		const stored = await this.options.store.codearts();
		for (const id of stored?.noBenefit ?? []) this.noBenefit.add(id.trim().toLowerCase());
	}
	async rememberNoBenefit(model) {
		const key = model.trim().toLowerCase();
		this.noBenefit.add(key);
		try {
			const stored = await this.options.store.codearts();
			if (stored === void 0) return;
			const known = new Set((stored.noBenefit ?? []).map((id) => id.toLowerCase()));
			if (known.has(key)) return;
			await this.options.store.saveCodearts({
				...stored,
				noBenefit: [...known, key]
			});
		} catch {}
	}
	async quota(fresh = false) {
		if (!fresh && this.quotaSnapshot !== void 0 && Date.now() - this.quotaSnapshot.at < this.options.ttlMs()) return this.quotaSnapshot.value;
		if (this.quotaInflight !== void 0) return this.quotaInflight;
		this.quotaInflight = (async () => {
			try {
				const value = await this.readQuota();
				this.quotaSnapshot = {
					value,
					at: Date.now()
				};
				return value;
			} finally {
				this.quotaInflight = void 0;
			}
		})();
		return this.quotaInflight;
	}
	invalidateQuota() {
		this.quotaSnapshot = void 0;
	}
	async readQuota() {
		const credential = await this.credential();
		const payload = record$3(await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_PACKAGE_INFO_PATH}`));
		if (payload === void 0) throw new Error("CodeArts 没有返回账户信息");
		const info = parseCodeArtsPackage(payload);
		const total = info.credit.amount ?? info.credit.remaining;
		return {
			...total === void 0 ? {} : { total },
			...info.credit.used === void 0 ? {} : { used: info.credit.used },
			...info.packageName === "" ? {} : { plan: info.packageName },
			...info.credit.packs.length === 0 ? {} : { packs: info.credit.packs },
			at: Date.now()
		};
	}
	async checkinStatus() {
		const credential = await this.credential();
		const info = await this.accountInfo(credential);
		if (info === void 0) return {
			available: false,
			claimed: false,
			deviceClaimed: false,
			message: "账户信息读取失败"
		};
		if (!info.isCreditPackage) return {
			available: false,
			claimed: false,
			deviceClaimed: false,
			message: "非积分计费账户，没有签到活动"
		};
		const activities = await this.activities(credential);
		if (activities === void 0) return {
			available: false,
			claimed: false,
			deviceClaimed: false,
			message: "活动列表读取失败"
		};
		const activity = activities.find((entry) => entry.type === CODEARTS_DAILY_LOGIN_TYPE);
		if (activity === void 0) return {
			available: false,
			claimed: false,
			deviceClaimed: false,
			message: "当前账号没有每日签到活动"
		};
		const claimed = !activity.claimable && CODEARTS_CLAIMED_STATUSES.includes(activity.status);
		return {
			available: true,
			claimed,
			deviceClaimed: false,
			...activity.amount > 0 ? { reward: activity.amount } : {},
			...claimed ? { message: "今天已领取" } : {}
		};
	}
	async claimCheckin() {
		const before = await this.checkinStatus();
		if (!before.available) throw new Error(before.message ?? "没有可领取的签到活动");
		if (before.claimed) return before;
		const credential = await this.credential();
		const activity = (await this.activities(credential))?.find((entry) => entry.type === CODEARTS_DAILY_LOGIN_TYPE);
		if (activity === void 0) throw new Error("没有找到每日签到活动");
		if (!activity.claimable) return {
			...before,
			claimed: CODEARTS_CLAIMED_STATUSES.includes(activity.status),
			message: `当前不可领取（${activity.status}）`
		};
		const claimed = await this.signedPost(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_CLAIM_PATH}`, {
			campaignId: activity.campaignId,
			channel: "IDE"
		});
		if (claimed === void 0) throw new Error("领取失败，请稍后再试");
		if (claimed.id !== null && claimed.id !== void 0) await this.signedPost(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_CONFIRM_PATH}`, { campaignId: activity.campaignId });
		this.invalidateQuota();
		const reward = num$1(claimed.totalAmount) ?? num$1(claimed.benefitAmount) ?? num$1(claimed.credit) ?? num$1(claimed.creditAmount) ?? activity.amount;
		return {
			available: true,
			claimed: true,
			deviceClaimed: false,
			...reward > 0 ? { reward } : {}
		};
	}
	async signedPost(credential, url, body) {
		const payload = JSON.stringify(body);
		const signed = await signRequestHuawei(credential.accessKeyId, credential.secretAccessKey, credential.securityToken, "POST", url, payload);
		try {
			const response = await this.fetcher(url, {
				method: "POST",
				headers: {
					...headersForFetch(signed),
					...CODEARTS_EXTRA_HEADERS,
					accept: "application/json"
				},
				body: payload,
				signal: AbortSignal.timeout(this.options.timeoutMs())
			});
			if (!response.ok) return void 0;
			return unwrapEnvelope(record$3(await response.json()));
		} catch {
			return;
		}
	}
	async accountInfo(credential) {
		const payload = record$3(await this.signedGet(credential, `${CODEARTS_SNAP_BASE}${CODEARTS_PACKAGE_INFO_PATH}`));
		return payload === void 0 ? void 0 : parseCodeArtsPackage(payload);
	}
	async activities(credential) {
		const url = `${CODEARTS_SNAP_BASE}${CODEARTS_OPS_DELIVERY_PATH}?channel=IDE`;
		const items = unwrapEnvelope(record$3(await this.signedGet(credential, url)))?.items;
		if (!Array.isArray(items)) return void 0;
		return items.map((item) => {
			const entry = record$3(item) ?? {};
			return {
				campaignId: String(entry.campaignId ?? ""),
				type: text$2(entry.type) ?? "",
				claimable: entry.claimable === true || String(entry.claimable).toLowerCase() === "true",
				status: text$2(entry.status) ?? "",
				amount: num$1(entry.benefitAmount) ?? num$1(entry.amount) ?? num$1(entry.creditAmount) ?? 0
			};
		});
	}
	async *stream(options, model, readImage, onInvalidate) {
		const messages = await buildMessages(options, readImage);
		const tools = buildTools(options);
		const effort = options.reasoningEffort;
		const thinkingOff = effort === "off" || effort === "none";
		const wireEffort = effort === void 0 || thinkingOff || effort === "on" ? void 0 : effort;
		const chatId = randomUUID();
		const body = {
			model,
			messages,
			stream: true,
			prompt_cache_key: this.sessionId,
			include: ["reasoning.encrypted_content"],
			reasoning_summary: "auto",
			...thinkingOff ? { thinking: { type: "disabled" } } : {},
			...wireEffort === void 0 ? {} : { reasoning_effort: wireEffort },
			tool_stream: true,
			max_tokens: clampMaxTokens(options.maxTokens),
			...tools === void 0 || tools.length === 0 ? {} : { tools }
		};
		const payload = JSON.stringify(body);
		await this.loadNoBenefit();
		let authRefreshed = false;
		let benefitDropped = false;
		let queueAttempts = 0;
		for (;;) {
			const slot = await this.window.open(options.signal);
			let response;
			try {
				response = await this.send(chatId, payload, model, benefitDropped, options.signal);
			} catch (error) {
				if (error instanceof CodeArtsRetry) {
					if (error.kind === "auth" && !authRefreshed) {
						authRefreshed = true;
						await this.options.auth.refresh(true);
						continue;
					}
					if (error.kind === "benefit" && !benefitDropped) {
						benefitDropped = true;
						await this.rememberNoBenefit(model);
						continue;
					}
					if (error.kind === "queue" && queueAttempts < QUEUE_ATTEMPTS) {
						queueAttempts++;
						slot.release();
						await sleep$1(Math.max(this.window.waitMs(), QUEUE_BACKOFF_MS), options.signal);
						continue;
					}
					if (error.kind === "queue") throw queueExhausted();
				}
				throw error;
			}
			let produced = false;
			try {
				for await (const chunk of consumeOpenAiStream(response, {
					...options.signal === void 0 ? {} : { signal: options.signal },
					onFrame: (frame) => {
						const code = text$2(frame.error_code);
						if (code === void 0) return;
						const message = text$2(frame.error_msg) ?? code;
						if (QUEUE_MARKERS.some((marker) => code.includes(marker))) throw new CodeArtsRetry("queue", message);
						if (code.includes("InferHub.4004.200")) throw new CodeArtsRetry("benefit", message);
						throw new ProviderHttpError(message, 502);
					}
				})) {
					produced = true;
					yield chunk;
				}
				return;
			} catch (error) {
				if (!produced && error instanceof CodeArtsRetry && error.kind === "queue" && queueAttempts < QUEUE_ATTEMPTS) {
					queueAttempts++;
					slot.release();
					await sleep$1(Math.max(this.window.waitMs(), QUEUE_BACKOFF_MS), options.signal);
					continue;
				}
				if (error instanceof CodeArtsRetry && error.kind === "queue") throw queueExhausted();
				if (!produced && error instanceof CodeArtsRetry && error.kind === "benefit" && !benefitDropped) {
					benefitDropped = true;
					await this.rememberNoBenefit(model);
					continue;
				}
				if (error instanceof CodeArtsRetry && error.kind === "auth") {
					onInvalidate();
					throw new Error("CodeArts 登录已失效，请在设置页重新登录。");
				}
				throw error;
			}
		}
	}
	async send(chatId, payload, model, benefitDropped, signal) {
		const credential = await this.credential();
		const benefit = !benefitDropped && this.isBenefitModel(model);
		const headers = {
			...headersForFetch(await signRequestHuawei(credential.accessKeyId, credential.secretAccessKey, credential.securityToken, "POST", CODEARTS_CHAT_URL, payload, benefit ? { maas_type: "benefit" } : void 0)),
			"content-type": "application/json",
			accept: "text/event-stream",
			"chat-id": chatId,
			"session-id": this.sessionId,
			lang: "en"
		};
		const timeout = AbortSignal.timeout(Math.max(this.options.timeoutMs(), 6e4));
		const response = await this.fetcher(CODEARTS_CHAT_URL, {
			method: "POST",
			headers,
			body: payload,
			signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
		});
		if (response.ok) return response;
		const text = await response.text().catch(() => "");
		throw classifyFailure(response.status, text);
	}
	async status() {
		return this.options.auth.status();
	}
	async signedIn() {
		return (await this.options.auth.status()).signedIn;
	}
	async startBrowserLogin() {
		return this.login.start();
	}
	browserLoginStatus() {
		return this.login.status();
	}
	async cancelBrowserLogin() {
		await this.login.cancel();
	}
	async logoutAccount() {
		await this.options.auth.logout();
		this.window.reset();
		this.invalidateModels();
		this.invalidateQuota();
	}
	close() {
		this.login.close();
	}
};
/** Cap `max_tokens` at the gateway's limit; a larger value is a hard 4xx. */
function clampMaxTokens(value) {
	const fallback = CODEARTS_MAX_OUTPUT_TOKENS;
	if (value === void 0) return fallback;
	const integer = Math.floor(value);
	if (!Number.isFinite(integer) || integer <= 0) return fallback;
	return Math.min(integer, CODEARTS_MAX_OUTPUT_TOKENS);
}
/**
* Parse `snap-manager/v1/statistics/plugin`.
*
* The total row is a summary of the three category rows, so it is never also
* listed as a pack — summing both would double every credit. It is, however,
* the only row that reports the allowance *and* the spend together, which is
* what a used/total bar needs, so its three figures are kept as-is. Only the
* basic pack gets a real expiry (the subscription's `end_date`); the bonus and
* on-demand packs have no per-pack date, and borrowing the subscription date
* for them would claim credits expire when they do not.
*/
function parseCodeArtsPackage(payload) {
	const pkg = record$3(payload.package) ?? {};
	const endDate = text$2(payload.end_date);
	const endMs = endDate === void 0 ? void 0 : Date.parse(endDate);
	const labels = {
		usageBasicPackageCredit: "基础积分包",
		usageOnDemandPackageCredit: "按需积分包",
		usageBonusPackageCredit: "赠送积分包"
	};
	const packs = [];
	let summary;
	for (const item of Array.isArray(payload.metrics) ? payload.metrics : []) {
		const metric = record$3(item);
		if (metric === void 0) continue;
		const name = text$2(metric.name) ?? "";
		const amount = num$1(metric.package_credit_amount);
		const used = num$1(metric.package_credit_used);
		const remain = num$1(metric.package_credit_remain);
		if (name === "usageTotalPackageCredit") {
			summary = {
				...amount === void 0 ? {} : { amount },
				...used === void 0 ? {} : { used },
				...remain === void 0 ? {} : { remaining: remain }
			};
			continue;
		}
		const label = labels[name];
		if (label === void 0) continue;
		const granted = amount ?? 0;
		if (granted <= 0 && (remain ?? 0) <= 0) continue;
		const expiresAt = name === "usageBasicPackageCredit" && endMs !== void 0 && !Number.isNaN(endMs) ? endMs : void 0;
		packs.push({
			label,
			total: granted,
			used: used ?? 0,
			...expiresAt === void 0 ? {} : { expiresAt }
		});
	}
	const granted = packs.reduce((sum, pack) => sum + (pack.total ?? 0), 0);
	const spent = packs.reduce((sum, pack) => sum + (pack.used ?? 0), 0);
	const credit = summary ?? (packs.length === 0 ? {} : {
		amount: granted,
		used: spent,
		remaining: Math.max(0, granted - spent)
	});
	return {
		isCreditPackage: pkg.is_credit_package === true || String(pkg.is_credit_package).toLowerCase() === "true",
		packageName: text$2(pkg.package_name_cn) ?? text$2(pkg.package_name_en) ?? "",
		packageStatus: text$2(pkg.status) ?? "",
		credit: {
			...credit,
			packs
		}
	};
}
// src/login-page.ts
/**
* Host-side login page for the two QR sign-in flows.
*
* The provider's own web login cannot hand a credential back to this plugin:
* the page has no callback we can receive. So the host serves a small page on
* `127.0.0.1`, renders the QR there, and polls the provider itself. The browser
* window is only a display; credentials never pass through the page.
*
* The page is bound to a random loopback port and a random path prefix, so no
* other local process can drive the login state by guessing URLs. It loads no
* external resources.
*
* @module dsh-llm-adapters/login-page
*/
const DEFAULT_TIMEOUT_MS$1 = 3e5;
const MAX_BODY_BYTES = 8192;
const CLOSE_AFTER_TERMINAL_MS = 6e4;
function escapeHtml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function sendJson(response, payload) {
	const body = JSON.stringify(payload);
	response.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	response.end(body);
}
function sendHtml(response, html) {
	response.writeHead(200, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'"
	});
	response.end(html);
}
async function readJson(request) {
	const chunks = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buffer.length;
		if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}
function listenOnLoopback(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			if (port === 0) {
				reject(/* @__PURE__ */ new Error("本地登录页未能获得端口"));
				return;
			}
			resolve(port);
		});
	});
}
/**
* Start the page and the host-side poll loop. Resolves as soon as the loopback
* server listens; the QR may still be preparing, and the page polls for it.
*/
async function startLoginPage(spec) {
	const prefix = `/${randomBytes(16).toString("hex")}`;
	const paths = {
		login: `${prefix}/login`,
		status: `${prefix}/status`,
		send: `${prefix}/send`,
		verify: `${prefix}/verify`
	};
	const startedAt = Date.now();
	let phase = "preparing";
	let qr = "";
	let qrDelivered = false;
	let message = "正在准备二维码…";
	let finishedAt;
	let terminal = false;
	let closed = false;
	let url = "";
	let polling;
	let resolveResult;
	let rejectResult;
	const result = new Promise((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	result.catch(() => {});
	let closeTimer;
	let pump;
	let closeNow = async () => {};
	const scheduleClose = () => {
		closeTimer = setTimeout(() => {
			closeNow();
		}, CLOSE_AFTER_TERMINAL_MS);
		closeTimer.unref?.();
	};
	const settle = (next, reason) => {
		if (terminal) return;
		terminal = true;
		phase = next;
		finishedAt = Date.now();
		if (reason !== void 0) message = reason;
		if (next === "done") resolveResult();
		else rejectResult(new Error(reason ?? "登录失败"));
		scheduleClose();
	};
	const snapshot = () => {
		const base = {
			running: !terminal,
			phase,
			startedAt,
			...url.length === 0 ? {} : { url },
			...finishedAt === void 0 ? {} : { finishedAt },
			...phase === "done" ? { signedIn: true } : {}
		};
		if (terminal && phase !== "done" && message.length > 0) base.error = message;
		return base;
	};
	async function advance() {
		if (polling !== void 0) return polling;
		polling = (async () => {
			const state = await spec.poll();
			if (terminal) return state;
			if (state.phase === "done") {
				await spec.finish?.();
				phase = "done";
				message = state.message ?? "登录成功，可以关闭此窗口。";
				settle("done");
			} else if (state.phase === "error" || state.phase === "cancelled" || state.phase === "expired") settle(state.phase, state.message);
			else {
				phase = state.phase;
				message = state.message ?? "";
				if (state.qr !== void 0) {
					qr = state.qr;
					qrDelivered = true;
				}
			}
			return state;
		})();
		try {
			return await polling;
		} finally {
			polling = void 0;
		}
	}
	const server = createServer((request, response) => {
		serve(request, response).catch((error) => {
			try {
				sendJson(response, { error: error instanceof Error ? error.message : String(error) });
			} catch {}
		});
	});
	async function serve(request, response) {
		const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
		if (incoming.pathname === paths.login) {
			sendHtml(response, renderPage(spec, paths, qr));
			return;
		}
		if (incoming.pathname === paths.status) {
			if (terminal) {
				sendJson(response, {
					phase,
					message,
					...phase === "done" ? { done: true } : {}
				});
				return;
			}
			if (phase === "preparing") {
				sendJson(response, {
					phase,
					message
				});
				return;
			}
			if (qr.length > 0 && !qrDelivered) {
				qrDelivered = true;
				sendJson(response, {
					phase,
					message,
					qr
				});
				return;
			}
			if (phase === "binding") {
				sendJson(response, {
					phase,
					message
				});
				return;
			}
			if (polling !== void 0) {
				sendJson(response, {
					phase,
					message
				});
				return;
			}
			try {
				const state = await advance();
				const payload = {
					phase: state.phase,
					message: state.message ?? ""
				};
				if (state.qr !== void 0) payload.qr = state.qr;
				else if (qr.length > 0 && !qrDelivered) {
					payload.qr = qr;
					qrDelivered = true;
				}
				sendJson(response, payload);
			} catch (error) {
				if (closed) return;
				settle("error", error instanceof Error ? error.message : String(error));
				sendJson(response, {
					phase,
					message
				});
			}
			return;
		}
		if (incoming.pathname === paths.send && request.method === "POST") {
			const body = await readJson(request);
			const phone = typeof body.phone === "string" ? body.phone.trim() : "";
			if (spec.binding === void 0) {
				sendJson(response, {
					ok: false,
					message: "当前登录流程不需要绑定手机号"
				});
				return;
			}
			if (!/^1[3-9]\d{9}$/.test(phone)) {
				sendJson(response, {
					ok: false,
					message: "请输入 11 位手机号"
				});
				return;
			}
			try {
				await spec.binding.send(phone);
				sendJson(response, { ok: true });
			} catch (error) {
				sendJson(response, {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				});
			}
			return;
		}
		if (incoming.pathname === paths.verify && request.method === "POST") {
			const body = await readJson(request);
			const phone = typeof body.phone === "string" ? body.phone.trim() : "";
			const code = typeof body.code === "string" ? body.code.trim() : "";
			if (spec.binding === void 0) {
				sendJson(response, {
					ok: false,
					message: "当前登录流程不需要绑定手机号"
				});
				return;
			}
			if (!/^1[3-9]\d{9}$/.test(phone) || !/^\d{4,8}$/.test(code)) {
				sendJson(response, {
					ok: false,
					message: "请填写手机号和短信验证码"
				});
				return;
			}
			try {
				await spec.binding.verify(phone, code);
				await spec.finish?.();
				phase = "done";
				message = "登录成功，可以关闭此窗口。";
				settle("done");
				sendJson(response, {
					ok: true,
					done: true
				});
			} catch (error) {
				sendJson(response, {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				});
			}
			return;
		}
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
	}
	url = `http://127.0.0.1:${await listenOnLoopback(server)}${paths.login}`;
	const timeoutTimer = setTimeout(() => {
		if (!terminal) settle("error", "登录等待超时，请重新发起登录。");
	}, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS$1);
	timeoutTimer.unref?.();
	const handle = {
		url,
		result,
		status: snapshot,
		close: async () => {
			if (closed) return;
			closed = true;
			clearTimeout(timeoutTimer);
			if (pump !== void 0) clearInterval(pump);
			if (closeTimer !== void 0) clearTimeout(closeTimer);
			if (!terminal) {
				terminal = true;
				phase = "cancelled";
				finishedAt = Date.now();
				message = "登录已取消。";
				rejectResult(new Error(message));
			}
			await new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		}
	};
	closeNow = handle.close;
	pump = setInterval(() => {
		if (terminal || phase === "preparing" || phase === "binding" || polling !== void 0) return;
		advance().catch((error) => {
			if (!closed) settle("error", error instanceof Error ? error.message : String(error));
		});
	}, 2e3);
	pump.unref?.();
	(async () => {
		try {
			const prepared = await spec.prepare();
			if (terminal) return;
			qr = prepared.qr;
			if (qr.length === 0) throw new Error("二维码内容为空");
			phase = "waiting";
			message = "等待扫码…";
		} catch (error) {
			if (!terminal) settle("error", error instanceof Error ? error.message : String(error));
		}
	})();
	return handle;
}
function renderPage(spec, paths, qr) {
	const form = spec.binding === void 0 ? "" : `
    <div class="form" id="form" hidden>
      <div class="hint">${escapeHtml(spec.binding.hint)}</div>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号">
        <button id="send" type="button">获取验证码</button>
      </div>
      <input id="code" type="text" inputmode="numeric" maxlength="8" placeholder="短信验证码">
      <button id="verify" type="button" class="primary">完成绑定并登录</button>
    </div>`;
	const formScript = spec.binding === void 0 ? "" : `
  var form = document.getElementById('form');
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('send');
  var verifyBtn = document.getElementById('verify');
  function digits(value) { return (value || '').replace(/[^0-9]/g, ''); }
  sendBtn.addEventListener('click', function () {
    var phone = digits(phoneEl.value);
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('正在发送验证码…');
    post('${paths.send}', { phone: phone }).then(function (res) {
      setStatus(res.ok ? '验证码已发送' : (res.message || '发送失败'), res.ok ? 'ok' : 'err');
    }).catch(function () { setStatus('发送失败，请重试', 'err'); })
      .finally(function () { sendBtn.disabled = false; });
  });
  verifyBtn.addEventListener('click', function () {
    var phone = digits(phoneEl.value);
    var code = digits(codeEl.value);
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    if (code.length === 0) { setStatus('请输入短信验证码', 'err'); return; }
    verifyBtn.disabled = true;
    setStatus('正在完成绑定…');
    post('${paths.verify}', { phone: phone, code: code }).then(function (res) {
      if (res.ok && res.done) { done = true; setStatus('登录成功，可以关闭此窗口。', 'ok'); form.hidden = true; }
      else setStatus(res.message || '验证码错误，请重试', 'err');
    }).catch(function () { setStatus('绑定失败，请重试', 'err'); })
      .finally(function () { verifyBtn.disabled = false; });
  });`;
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(spec.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 26px 30px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 17px; margin: 0 0 6px; font-weight: 600; }
  .sub { font-size: 13px; color: #8a9099; margin: 0 0 16px; }
  .qr { width: 220px; height: 220px; display: flex; align-items: center; justify-content: center;
        margin: 0 auto; border: 1px solid #eceef1; border-radius: 8px; background: #fff;
        font-size: 12px; color: #8a9099; }
  .qr img, .qr svg { width: 100%; height: 100%; display: block; border-radius: 6px; }
  .status { margin-top: 16px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  .form { margin-top: 16px; text-align: left; }
  .hint { font-size: 12px; color: #8a9099; margin-bottom: 8px; }
  .row { display: flex; gap: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 8px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button { padding: 8px 12px; font-size: 13px; border: 0; border-radius: 6px; background: #f2f3f5;
           color: #1f2329; cursor: pointer; white-space: nowrap; }
  button.primary { width: 100%; background: #07c160; color: #fff; padding: 9px; font-size: 14px; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .row button { margin-bottom: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(spec.heading)}</h1>
    <p class="sub">${escapeHtml(spec.subtitle)}</p>
    <div class="qr" id="qr">${qr.length > 0 ? qr : "正在准备二维码…"}</div>
    <div class="status" id="status">${qr.length > 0 ? "等待扫码…" : "正在准备二维码…"}</div>
    ${form}
  </div>
<script>
(function () {
  var statusEl = document.getElementById('status');
  var qrEl = document.getElementById('qr');
  var done = false;
  var bindingShown = false;
  var qrShown = ${qr.length > 0 ? "true" : "false"};
  var missed = 0;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  function post(path, payload) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (response) { return response.json(); });
  }

  function poll() {
    if (done) return;
    fetch('${paths.status}')
      .then(function (response) { return response.json(); })
      .then(function (res) {
        missed = 0;
        if (res.qr && !qrShown) { qrEl.innerHTML = res.qr; qrShown = true; }
        if (res.phase === 'done') { done = true; setStatus(res.message || '登录成功，可以关闭此窗口。', 'ok'); return; }
        if (res.phase === 'error' || res.phase === 'cancelled' || res.phase === 'expired') {
          done = true; setStatus(res.message || '登录失败', 'err'); return;
        }
        if (res.phase === 'binding') {
          if (!bindingShown) {
            bindingShown = true;
            setStatus('已扫码，请绑定手机号');
            ${spec.binding === void 0 ? "" : "document.getElementById('form').hidden = false;"}
          }
          // Keep polling so a server-side timeout or cancellation still shows.
          setTimeout(poll, 2000);
          return;
        }
        if (res.phase === 'scanned') setStatus('已扫码，请在手机上确认');
        else if (res.phase === 'preparing') setStatus('正在准备二维码…');
        else setStatus('等待扫码…');
        setTimeout(poll, 1200);
      })
      .catch(function () {
        missed += 1;
        if (missed >= 20) { setStatus('连接登录页失败，请刷新重试', 'err'); return; }
        setTimeout(poll, 1500);
      });
  }

  ${formScript}

  poll();
})();
<\/script>
</body>
</html>`;
}
// src/loomy-login.ts
/**
* Loomy WeChat QR sign-in.
*
* The Loomy client intercepts the WeChat redirect inside Electron and never
* loads the callback page; that page is 404 for everyone else. The host mirrors
* the client's actual account API instead: fetch the WeChat authorization page,
* read the QR uuid out of it, long-poll the QR status, and exchange the
* confirmed `code` through the signed iFlytek account endpoints.
*
* The QR image is inlined into the local page, so the page needs no network of
* its own beyond the host it came from.
*
* @module dsh-llm-adapters/loomy-login
*/
const LOOMY_ACCOUNT_BASE = "https://account.xfinfr.com";
const LOOMY_WECHAT_APP_ID = "wx18d60be432287cf8";
const LOOMY_WECHAT_REDIRECT_URI = "https://loomy.xunfei.cn/oauth/wechat/callback";
const LOOMY_ACCESS_KEY_ID = "2thryby66wxi53sk";
const LOOMY_ACCESS_KEY_SECRET = "zsak6eadrbawz683wf5r3m2snrwj868r";
const LOOMY_APP_ID = "GM3LOOMY";
const LOOMY_OK_CODE = "000000";
const LOOMY_SESSION_TTL_SECONDS = 1209600;
const REQUEST_TIMEOUT_MS$1 = 3e4;
const POLL_TIMEOUT_MS = 4e4;
const WECHAT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/** RFC 3986 escaping used by the iFlytek signer (also covers `!'()*`). */
function escapeRfc3986(value) {
	return encodeURIComponent(value).replace(/!/g, "%21").replace(/'/g, "%27").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}
function contentMd5(body) {
	return body.length === 0 ? "" : createHash("md5").update(body, "utf8").digest("base64");
}
function escapedPath(raw) {
	let value = raw.startsWith("/") ? raw : `/${raw}`;
	if (value.length > 1 && value.endsWith("/")) value = value.slice(0, -1);
	return value.split("/").map((part) => part.length === 0 ? "" : escapeRfc3986(part)).join("/");
}
/** The nine-line string iFlytek signs; the last two lines are empty here. */
function buildLoomySigningString(input) {
	return [
		input.method.toUpperCase(),
		escapedPath(input.path),
		"",
		contentMd5(input.body ?? ""),
		input.contentType ?? "",
		input.date,
		input.nonce,
		"",
		""
	].join("\n");
}
/** Headers for one signed iFlytek account request. */
function loomyAccountHeaders(input) {
	const date = (/* @__PURE__ */ new Date()).toUTCString();
	const nonce = randomUUID();
	const contentType = input.contentType ?? "application/json";
	const signature = createHmac("sha1", LOOMY_ACCESS_KEY_SECRET).update(buildLoomySigningString({
		accessKeyId: LOOMY_ACCESS_KEY_ID,
		accessKeySecret: LOOMY_ACCESS_KEY_SECRET,
		method: input.method,
		path: input.path,
		body: input.body,
		contentType,
		date,
		nonce
	}), "utf8").digest("base64");
	const headers = {
		authorization: `account ${LOOMY_ACCESS_KEY_ID}:${signature}`,
		date,
		nonce,
		"content-type": contentType
	};
	const md5 = contentMd5(input.body);
	if (md5.length > 0) headers["content-md5"] = md5;
	return headers;
}
/**
* iFlytek account call. The body is serialized once and the same string is
* signed and sent; re-serializing would change bytes and invalidate the HMAC.
*/
async function postLoomyAccount(path, param, fetchImpl) {
	const body = JSON.stringify({
		base: {
			appid: LOOMY_APP_ID,
			modelid: "Web",
			version: "1.0.0",
			devid: "web",
			ua: "Loomy|Desktop|Electron|macOS",
			traceid: randomUUID().replace(/-/g, "")
		},
		param
	});
	let response;
	try {
		response = await fetchImpl(`${LOOMY_ACCOUNT_BASE}${path}`, {
			method: "POST",
			headers: loomyAccountHeaders({
				method: "POST",
				path,
				body
			}),
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
		});
	} catch (error) {
		throw new Error(`讯飞账号请求失败：${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		throw new Error(`讯飞账号响应不是 JSON（HTTP ${response.status}）`);
	}
	const root = parsed !== null && typeof parsed === "object" ? parsed : {};
	const code = typeof root.code === "string" ? root.code : "";
	if (code !== LOOMY_OK_CODE) {
		const message = typeof root.desc === "string" && root.desc.length > 0 ? root.desc : `讯飞账号返回错误 ${code || "(缺少 code)"}`;
		throw new Error(message);
	}
	return root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};
}
/** WeChat open-platform authorization URL; the redirect page itself is never loaded. */
function buildLoomyWechatAuthUrl(state) {
	return `https://open.weixin.qq.com/connect/qrconnect?appid=${encodeURIComponent(LOOMY_WECHAT_APP_ID)}&redirect_uri=${encodeURIComponent(LOOMY_WECHAT_REDIRECT_URI)}&response_type=code&scope=snsapi_login&state=${encodeURIComponent(state)}#wechat_redirect`;
}
/** Read the QR uuid out of the authorization page HTML. */
function extractWechatUuid(html) {
	const fromImage = html.match(/\/connect\/qrcode\/([A-Za-z0-9_\-=+/]+)/);
	const fromPoll = html.match(/l\/qrconnect\?uuid=([A-Za-z0-9_\-=+/]+)/);
	const value = fromImage?.[1] ?? fromPoll?.[1] ?? "";
	return /^[A-Za-z0-9_\-=+/]{6,64}$/.test(value) ? value : "";
}
/** Fetch the authorization page and return its QR uuid. */
async function fetchLoomyWechatUuid(state, fetchImpl = fetch) {
	const authUrl = buildLoomyWechatAuthUrl(state);
	let response;
	try {
		response = await fetchImpl(authUrl, {
			headers: {
				"user-agent": WECHAT_UA,
				referer: "https://open.weixin.qq.com/"
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
		});
	} catch (error) {
		throw new Error(`微信授权页拉取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`微信授权页返回 HTTP ${response.status}`);
	const uuid = extractWechatUuid(await response.text());
	if (uuid.length === 0) throw new Error("微信授权页里没有二维码（页面结构可能已变化）");
	return uuid;
}
function imageMime(bytes) {
	if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
	if (bytes.length >= 4 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "image/gif";
	return "";
}
/** Download the QR image and inline it as a data URL. */
async function fetchLoomyWechatQr(uuid, fetchImpl = fetch) {
	const url = `https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(uuid)}`;
	let response;
	try {
		response = await fetchImpl(url, {
			headers: {
				"user-agent": WECHAT_UA,
				referer: "https://open.weixin.qq.com/"
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
		});
	} catch (error) {
		throw new Error(`微信二维码下载失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`微信二维码返回 HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	const mime = imageMime(bytes);
	if (mime === "" || bytes.length < 200) throw new Error("微信二维码响应不是图片");
	return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}
/** One long poll; 405 carries the one-time authorization code. */
async function pollLoomyWechat(uuid, lastErrcode, fetchImpl = fetch) {
	const query = `uuid=${encodeURIComponent(uuid)}` + (lastErrcode.length > 0 ? `&last=${encodeURIComponent(lastErrcode)}` : "") + `&_=${Date.now()}`;
	let body;
	try {
		body = await (await fetchImpl(`https://long.open.weixin.qq.com/connect/l/qrconnect?${query}`, {
			headers: {
				"user-agent": WECHAT_UA,
				referer: buildLoomyWechatAuthUrl("")
			},
			signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
		})).text();
	} catch {
		return {
			status: "error",
			code: "",
			errcode: "network"
		};
	}
	const errcode = (body.match(/wx_errcode\s*=\s*(\d+)/) ?? [])[1] ?? "";
	const code = (body.match(/wx_code\s*=\s*'([^']*)'/) ?? [])[1] ?? "";
	if (errcode === "405") return code.length > 0 ? {
		status: "confirmed",
		code,
		errcode
	} : {
		status: "scanned",
		code: "",
		errcode
	};
	if (errcode === "404") return {
		status: "scanned",
		code: "",
		errcode
	};
	if (errcode === "403") return {
		status: "cancelled",
		code: "",
		errcode
	};
	if (errcode === "402") return {
		status: "expired",
		code: "",
		errcode
	};
	return {
		status: "waiting",
		code: "",
		errcode
	};
}
/** First WeChat step: exchange a code for `rcode` and learn whether a phone is bound. */
async function bindLoomyThirdAccount(code, fetchImpl) {
	const data = await postLoomyAccount("/login/thirdAccount/bind/auth", {
		tcode: { code },
		type: "wx"
	}, fetchImpl);
	const rcode = typeof data.rcode === "string" ? data.rcode : "";
	if (rcode.length === 0) throw new Error("微信授权响应缺少 rcode");
	return {
		bind: data.bind === 1,
		rcode,
		...typeof data.nickname === "string" && data.nickname.length > 0 ? { nickname: data.nickname } : {}
	};
}
async function sendLoomyBindSms(rcode, phone, fetchImpl) {
	const data = await postLoomyAccount("/login/thirdAccount/bind/sendMsg", {
		rcode,
		phone,
		ccode: "86",
		expire: 300
	}, fetchImpl);
	const msgid = typeof data.msgid === "string" ? data.msgid : "";
	if (msgid.length === 0) throw new Error("短信验证码响应缺少 msgid");
	return msgid;
}
async function verifyLoomyBindSms(rcode, code, msgid, fetchImpl) {
	const data = await postLoomyAccount("/login/thirdAccount/bind/checkCode", {
		rcode,
		mcode: code,
		msgid,
		expire: LOOMY_SESSION_TTL_SECONDS
	}, fetchImpl);
	const session = typeof data.session === "string" ? data.session : "";
	const userid = typeof data.userid === "string" ? data.userid : "";
	if (session.length === 0) throw new Error("绑定登录响应缺少 session");
	if (userid.length === 0) throw new Error("绑定登录响应缺少 userid");
	return {
		session,
		userid,
		phone: typeof data.phone === "string" ? data.phone : ""
	};
}
async function skipLoomyBind(rcode, fetchImpl) {
	const data = await postLoomyAccount("/login/thirdAccount/bind/skip", {
		rcode,
		expire: LOOMY_SESSION_TTL_SECONDS
	}, fetchImpl);
	const session = typeof data.session === "string" ? data.session : "";
	const userid = typeof data.userid === "string" ? data.userid : "";
	if (session.length === 0) throw new Error("微信登录响应缺少 session");
	if (userid.length === 0) throw new Error("微信登录响应缺少 userid");
	return {
		session,
		userid
	};
}
/** One running Loomy QR login. */
var LoomyQrLogin = class {
	options;
	handle;
	failure;
	constructor(options) {
		this.options = options;
	}
	status() {
		if (this.handle !== void 0) return this.handle.status();
		return this.failure ?? {
			running: false,
			phase: "idle"
		};
	}
	async start() {
		const current = this.handle?.status();
		if (current?.running === true) return current;
		if (this.handle !== void 0) {
			await this.handle.close();
			this.handle = void 0;
		}
		this.failure = void 0;
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const state = randomUUID();
		let uuid = "";
		let lastErrcode = "";
		let rcode = "";
		let msgid = "";
		let nickname;
		let account;
		try {
			const handle = await startLoginPage({
				title: "Loomy 登录",
				heading: "使用微信扫码登录 Loomy",
				subtitle: "打开微信扫一扫，扫描下方二维码",
				prepare: async () => {
					uuid = await fetchLoomyWechatUuid(state, fetchImpl);
					return { qr: `<img src="${await fetchLoomyWechatQr(uuid, fetchImpl)}" alt="微信登录二维码">` };
				},
				poll: async () => {
					if (rcode.length > 0) return {
						phase: "binding",
						message: "请绑定手机号"
					};
					const polled = await pollLoomyWechat(uuid, lastErrcode, fetchImpl);
					if (polled.errcode.length > 0) lastErrcode = polled.errcode;
					if (polled.status === "scanned") return {
						phase: "scanned",
						message: "已扫码，请在手机上确认"
					};
					if (polled.status === "cancelled") return {
						phase: "cancelled",
						message: "你已取消授权，请重新登录。"
					};
					if (polled.status === "expired") return {
						phase: "expired",
						message: "二维码已失效，请重新登录。"
					};
					if (polled.status !== "confirmed") return {
						phase: "waiting",
						message: "等待扫码…"
					};
					const auth = await bindLoomyThirdAccount(polled.code, fetchImpl);
					nickname = auth.nickname;
					if (auth.bind) {
						const login = await skipLoomyBind(auth.rcode, fetchImpl);
						account = {
							token: login.session,
							userId: login.userid,
							...nickname === void 0 ? {} : { name: nickname }
						};
						return {
							phase: "done",
							message: "登录成功，可以关闭此窗口。"
						};
					}
					rcode = auth.rcode;
					return {
						phase: "binding",
						message: "首次登录需要绑定手机号"
					};
				},
				binding: {
					hint: "该微信账号还没有绑定手机号，绑定后才能登录 Loomy。",
					send: async (phone) => {
						msgid = await sendLoomyBindSms(rcode, phone, fetchImpl);
					},
					verify: async (phone, code) => {
						const login = await verifyLoomyBindSms(rcode, code, msgid, fetchImpl);
						account = {
							token: login.session,
							userId: login.userid,
							phone: login.phone.length > 0 ? login.phone : phone,
							...nickname === void 0 ? {} : { name: nickname }
						};
					}
				},
				finish: async () => {
					if (account === void 0) throw new Error("登录凭据缺失");
					await this.options.save(account);
				},
				...this.options.timeoutMs === void 0 ? {} : { timeoutMs: this.options.timeoutMs }
			});
			this.handle = handle;
			handle.result.catch(() => void 0);
			return handle.status();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failure = {
				running: false,
				phase: "error",
				error: message
			};
			throw error;
		}
	}
	async cancel() {
		await this.handle?.close();
	}
};
// src/loomy.ts
/**
* Loomy (iFlytek) gateway client.
*
* The gateway is OpenAI-compatible but requires client tracing headers on every
* call; without `traceparent` it accepts the connection and then never
* answers. The session comes from the plugin's QR login and cannot be
* refreshed, so an expired session is a user-visible login action.
*
* @module dsh-llm-adapters/loomy
*/
const LOOMY_BASE = "https://loomyad.xunfei.cn/api/v1";
const LOOMY_VERSION = "0.9.38";
/** Session lifetime the Loomy client itself requests (14 days). */
const LOOMY_SESSION_TTL_MS = 12096e5;
function traceparent() {
	return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}
function sessionChatId(options) {
	if (options.sessionId === void 0) return `chat-${randomUUID()}`;
	const cleaned = String(options.sessionId).replace(/[^a-zA-Z0-9-]/g, "").slice(-36);
	return `chat-${cleaned.length > 0 ? cleaned : randomUUID()}`;
}
function tracingHeaders(session, options, origin) {
	return {
		authorization: `Bearer ${session}`,
		token: session,
		"loomy-version": LOOMY_VERSION,
		chatid: sessionChatId(options),
		msgid: `msg-${randomUUID()}`,
		invokeorigin: origin,
		traceparent: traceparent()
	};
}
/**
* Whether the model gateway accepts a browser-obtained session.
*
* A web login can yield a session cookie that the web app itself uses; this
* probe is what decides whether that same value also works as a gateway
* credential. The gateway answers 200 with a JSON error code for a bad token,
* so HTTP status alone is not enough.
*/
async function loomyGatewaySessionValid(session, fetchImpl = fetch) {
	try {
		const response = await fetchImpl(`${LOOMY_BASE}/models`, {
			headers: {
				...attributionHeaders(),
				accept: "application/json",
				...tracingHeaders(session, {
					model: "",
					provider: "",
					messages: []
				}, "system")
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) return false;
		const payload = JSON.parse(await response.text());
		const root = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : void 0;
		const data = root?.data !== null && typeof root?.data === "object" ? root.data : void 0;
		if (Array.isArray(payload)) return true;
		if (Array.isArray(root?.data)) return true;
		if (Array.isArray(root?.models)) return true;
		return Array.isArray(data?.models);
	} catch {
		return false;
	}
}
function numeric$1(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
}
/** Find the balance record without depending on one response envelope. */
function findBalance(value, depth = 0) {
	if (value === null || typeof value !== "object" || depth > 4) return void 0;
	const record = value;
	if (numeric$1(record.balance) !== void 0 || numeric$1(record.availableBalance) !== void 0 || numeric$1(record.dailyBalance) !== void 0) return record;
	for (const nested of Object.values(record)) {
		const found = findBalance(nested, depth + 1);
		if (found !== void 0) return found;
	}
}
var LoomyProvider = class {
	options;
	catalog;
	quotaCache;
	quotaInflight;
	loginFlow;
	openRouter;
	constructor(options) {
		this.options = options;
		this.openRouter = options.openRouter ?? new OpenRouterCatalog(options.fetchImpl ?? fetch);
		this.catalog = new ModelCatalog(() => this.fetchModels(), options.ttlMs);
	}
	async status() {
		return this.options.auth.status();
	}
	async signedIn() {
		return (await this.options.auth.status()).signedIn;
	}
	/** Start the local WeChat QR page; the settings page opens the returned URL. */
	async startBrowserLogin() {
		return this.login().start();
	}
	browserLoginStatus() {
		return this.loginFlow?.status() ?? {
			running: false,
			phase: "idle"
		};
	}
	async cancelBrowserLogin() {
		await this.loginFlow?.cancel();
	}
	/** Stop a login page that outlived the plugin. */
	close() {
		this.loginFlow?.cancel();
	}
	login() {
		if (this.loginFlow !== void 0) return this.loginFlow;
		this.loginFlow = new LoomyQrLogin({
			fetchImpl: this.options.fetchImpl ?? fetch,
			save: async (account) => {
				const deviceId = await this.options.store.loomyDeviceId();
				const now = Date.now();
				await this.options.store.saveLoomy({
					session: account.token,
					deviceId,
					loginAt: now,
					expiresAt: now + LOOMY_SESSION_TTL_MS,
					...account.userId === void 0 ? {} : { userId: account.userId },
					...account.phone === void 0 ? {} : { phone: account.phone },
					...account.name === void 0 ? {} : { name: account.name }
				});
				this.invalidateModels();
				this.invalidateQuota();
			}
		});
		return this.loginFlow;
	}
	async logoutAccount() {
		await this.options.auth.logout();
		this.invalidateModels();
		this.invalidateQuota();
	}
	async session() {
		const session = await this.options.auth.session();
		if (session !== void 0) return session;
		const status = await this.options.auth.status();
		throw new Error(status.error ?? "Loomy 尚未登录。请在设置页点「打开扫码登录」。");
	}
	async fetchModels() {
		const session = await this.session();
		const [openRouter, payload] = await Promise.all([this.openRouter.models(), fetchJson(`${LOOMY_BASE}/models`, {
			headers: {
				...tracingHeaders(session, {
					model: "",
					provider: "",
					messages: []
				}, "system"),
				accept: "application/json"
			},
			timeoutMs: this.options.timeoutMs(),
			fetchImpl: this.options.fetchImpl
		})]);
		const models = parseLoomyCatalog(payload, {
			textOnly: this.options.textOnly(),
			forceVision: this.options.forceVision(),
			openRouter
		});
		if (models.length === 0) throw new Error("Loomy 返回的模型目录为空。");
		return models;
	}
	async models(fresh = false) {
		return this.catalog.models(fresh);
	}
	catalogError() {
		return this.catalog.error();
	}
	invalidateModels() {
		this.catalog.invalidate();
	}
	async quota(fresh = false) {
		if (!fresh && this.quotaCache !== void 0 && Date.now() - this.quotaCache.at < 6e4) return this.quotaCache.value;
		if (this.quotaInflight !== void 0) return this.quotaInflight;
		this.quotaInflight = (async () => {
			try {
				const session = await this.session();
				const record = findBalance(await fetchJson(`${LOOMY_BASE}/points/records`, {
					headers: {
						...tracingHeaders(session, {
							model: "",
							provider: "",
							messages: []
						}, "system"),
						accept: "application/json"
					},
					timeoutMs: this.options.timeoutMs(),
					fetchImpl: this.options.fetchImpl
				}));
				if (record === void 0) throw new Error("Loomy 额度响应格式无法识别。");
				const permanent = numeric$1(record.balance);
				const daily = numeric$1(record.dailyBalance);
				const available = numeric$1(record.availableBalance) ?? (permanent ?? 0) + (daily ?? 0);
				const cycle = typeof record.dailyCycleDate === "string" ? record.dailyCycleDate : void 0;
				const snapshot = {
					at: Date.now(),
					...available === void 0 ? {} : {
						available,
						total: available
					},
					...permanent === void 0 ? {} : { permanent },
					...daily === void 0 ? {} : { daily },
					...cycle === void 0 ? {} : { cycle }
				};
				this.quotaCache = {
					at: snapshot.at,
					value: snapshot
				};
				return snapshot;
			} finally {
				this.quotaInflight = void 0;
			}
		})();
		return this.quotaInflight;
	}
	invalidateQuota() {
		this.quotaCache = void 0;
	}
	async *stream(options, model, readImage, onUnauthorized) {
		const session = await this.session();
		const body = buildBody(options, model, await buildMessages(options, readImage), buildTools(options));
		if (options.reasoningEffort !== void 0) body.reasoning_effort = options.reasoningEffort;
		try {
			yield* openAiStream({
				url: `${LOOMY_BASE}/chat/completions`,
				headers: tracingHeaders(session, options, "user"),
				body,
				signal: options.signal,
				fetchImpl: this.options.fetchImpl,
				onUnauthorized: () => {
					this.invalidateModels();
					this.invalidateQuota();
					onUnauthorized?.();
				}
			});
		} catch (error) {
			if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) throw new Error("Loomy 登录态已失效。请在设置页点「打开扫码登录」重新扫码。");
			throw error;
		}
	}
};
// src/account-profile.ts
/**
* Non-secret account facts for the settings card.
*
* Browser login stores the credentials; this lookup only adds a display name,
* phone and account type. Failures are ignored — they must never turn a
* successful login into a failed one.
*
* @module dsh-llm-adapters/account-profile
*/
const RACCOON_WEB_BASE = "https://xiaohuanxiong.com/api/web";
const REQUEST_TIMEOUT_MS = 15e3;
function textField(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
async function raccoonAccountInfo(input) {
	const fetchImpl = input.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(`${RACCOON_WEB_BASE}/auth/v1/user_info`, {
			method: "GET",
			headers: {
				...attributionHeaders(),
				accept: "application/json",
				authorization: `Bearer ${input.accessToken}`
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (!response.ok) return {};
		const parsed = JSON.parse(await response.text());
		if (parsed === null || typeof parsed !== "object") return {};
		const root = parsed;
		const data = root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};
		const name = textField(data.name) ?? textField(data.nickname);
		const ownerType = textField(data.owner_type) ?? (Array.isArray(data.orgs) && data.orgs.length === 0 ? "personal" : void 0);
		return {
			...name === void 0 ? {} : { name },
			...textField(data.phone) === void 0 ? {} : { phone: textField(data.phone) },
			...ownerType === void 0 ? {} : { ownerType }
		};
	} catch {
		return {};
	}
}
// src/qr.ts
/** 各版本（1–10）纠错等级 M 的**数据码字**总数。 */
const DATA_CODEWORDS = [
	0,
	16,
	28,
	44,
	64,
	86,
	108,
	124,
	154,
	182,
	216
];
/** 各版本（1–10）纠错等级 M 的块结构。 */
const EC_BLOCKS_M = [
	void 0,
	{
		ecPerBlock: 10,
		groups: [[1, 16]]
	},
	{
		ecPerBlock: 16,
		groups: [[1, 28]]
	},
	{
		ecPerBlock: 26,
		groups: [[1, 44]]
	},
	{
		ecPerBlock: 18,
		groups: [[2, 32]]
	},
	{
		ecPerBlock: 24,
		groups: [[2, 43]]
	},
	{
		ecPerBlock: 16,
		groups: [[4, 27]]
	},
	{
		ecPerBlock: 18,
		groups: [[4, 31]]
	},
	{
		ecPerBlock: 22,
		groups: [[2, 38], [2, 39]]
	},
	{
		ecPerBlock: 22,
		groups: [[3, 36], [2, 37]]
	},
	{
		ecPerBlock: 26,
		groups: [[4, 43], [1, 44]]
	}
];
const GF_EXP = /* @__PURE__ */ new Uint8Array(512);
const GF_LOG = /* @__PURE__ */ new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if ((x & 256) !== 0) x ^= 285;
	}
	for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}
/** GF(256) 乘法。 */
function gfMul(a, b) {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}
/** 多项式乘法（最高次在前）。 */
function polyMul(a, b) {
	const result = new Array(a.length + b.length - 1).fill(0);
	for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) result[i + j] ^= gfMul(a[i] ?? 0, b[j] ?? 0);
	return result;
}
/** 生成 `degree` 次 Reed-Solomon 生成多项式（最高次在前）。 */
function rsGeneratorPoly(degree) {
	let poly = [1];
	for (let i = 0; i < degree; i++) poly = polyMul(poly, [1, GF_EXP[i] ?? 0]);
	return poly;
}
/** 计算 Reed-Solomon 纠错码字（综合除法取余）。 */
function rsEncode(data, ecCount) {
	const gen = rsGeneratorPoly(ecCount);
	const buf = [...data, ...new Array(ecCount).fill(0)];
	for (let i = 0; i < data.length; i++) {
		const coef = buf[i] ?? 0;
		if (coef === 0) continue;
		for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j] ?? 0, coef);
	}
	return buf.slice(data.length);
}
/** 选能容纳 `byteLength` 字节的最小版本；都装不下返回 undefined。 */
function pickVersion(byteLength) {
	for (let version = 1; version <= 10; version++) {
		const capacityBits = (DATA_CODEWORDS[version] ?? 0) * 8;
		if (4 + (version <= 9 ? 8 : 16) + byteLength * 8 <= capacityBits) return version;
	}
}
/**
* 把字节编码成**交织前**的完整码字序列（数据 + 纠错，按块交织）。
*/
function buildCodewords(bytes, version) {
	const blocks = EC_BLOCKS_M[version];
	if (blocks === void 0) throw new Error(`raccoon: 不支持的二维码版本 ${version}`);
	const capacityBits = (DATA_CODEWORDS[version] ?? 0) * 8;
	const bits = [];
	const pushBits = (value, length) => {
		for (let i = length - 1; i >= 0; i--) bits.push(value >> i & 1);
	};
	pushBits(4, 4);
	pushBits(bytes.length, version <= 9 ? 8 : 16);
	for (const byte of bytes) pushBits(byte, 8);
	pushBits(0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);
	const PAD_BYTES = [236, 17];
	for (let i = 0; bits.length < capacityBits; i++) pushBits(PAD_BYTES[i % 2] ?? 0, 8);
	const dataCodewords = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = byte << 1 | (bits[i + j] ?? 0);
		dataCodewords.push(byte);
	}
	const dataBlocks = [];
	const ecBlocks = [];
	let offset = 0;
	for (const [count, dataPerBlock] of blocks.groups) for (let b = 0; b < count; b++) {
		const block = dataCodewords.slice(offset, offset + dataPerBlock);
		offset += dataPerBlock;
		dataBlocks.push(block);
		ecBlocks.push(rsEncode(block, blocks.ecPerBlock));
	}
	const result = [];
	const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
	for (let i = 0; i < maxDataLen; i++) for (const block of dataBlocks) if (i < block.length) result.push(block[i] ?? 0);
	for (let i = 0; i < blocks.ecPerBlock; i++) for (const block of ecBlocks) result.push(block[i] ?? 0);
	return result;
}
/** 对齐图案中心坐标（版本 1 无）。 */
function alignmentPositions(version, size) {
	if (version === 1) return [];
	const numAlign = Math.floor(version / 7) + 2;
	const step = Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
	const result = [6];
	for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
	return result;
}
/** 画 finder pattern（含分隔符，`x`/`y` 是中心）。 */
function drawFinderPattern(modules, isFunction, size, x, y) {
	for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
		const xx = x + dx;
		const yy = y + dy;
		if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
		const dist = Math.max(Math.abs(dx), Math.abs(dy));
		const dark = dist !== 2 && dist !== 4;
		modules[yy][xx] = dark;
		isFunction[yy][xx] = true;
	}
}
/** 画 alignment pattern（`x`/`y` 是中心）。 */
function drawAlignmentPattern(modules, isFunction, x, y) {
	for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
		const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
		modules[y + dy][x + dx] = dark;
		isFunction[y + dy][x + dx] = true;
	}
}
/** 画全部功能图案（timing / finder / alignment / 版本信息）。 */
function drawFunctionPatterns(modules, isFunction, size, version) {
	for (let i = 0; i < size; i++) {
		const dark = i % 2 === 0;
		modules[6][i] = dark;
		isFunction[6][i] = true;
		modules[i][6] = dark;
		isFunction[i][6] = true;
	}
	drawFinderPattern(modules, isFunction, size, 3, 3);
	drawFinderPattern(modules, isFunction, size, size - 4, 3);
	drawFinderPattern(modules, isFunction, size, 3, size - 4);
	const positions = alignmentPositions(version, size);
	const n = positions.length;
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
		if (i === 0 && j === 0 || i === 0 && j === n - 1 || i === n - 1 && j === 0) continue;
		drawAlignmentPattern(modules, isFunction, positions[i] ?? 0, positions[j] ?? 0);
	}
	drawFormatBits(modules, isFunction, size, 0);
	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) rem = rem << 1 ^ (rem >>> 11) * 7973;
		const bits = version << 12 | rem;
		for (let i = 0; i < 18; i++) {
			const dark = (bits >> i & 1) === 1;
			const a = size - 11 + i % 3;
			const b = Math.floor(i / 3);
			modules[b][a] = dark;
			isFunction[b][a] = true;
			modules[a][b] = dark;
			isFunction[a][b] = true;
		}
	}
}
/**
* 写入格式信息（纠错等级 + 掩码号），两份拷贝。
*
* 纠错等级 M 的 `formatBits` 是 `0b00`。
*/
function drawFormatBits(modules, isFunction, size, mask) {
	const data = 0 | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = rem << 1 ^ (rem >>> 9) * 1335;
	const bits = (data << 10 | rem) ^ 21522;
	const set = (x, y, dark) => {
		modules[y][x] = dark;
		isFunction[y][x] = true;
	};
	const bit = (i) => (bits >> i & 1) === 1;
	for (let i = 0; i <= 5; i++) set(8, i, bit(i));
	set(8, 7, bit(6));
	set(8, 8, bit(7));
	set(7, 8, bit(8));
	for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
	for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
	for (let i = 8; i < 15; i++) set(8, size - 7 + (i - 8), bit(i));
	set(8, size - 8, true);
}
/** 按 zigzag 从右下向上填充数据位。 */
function drawCodewords(modules, isFunction, size, codewords) {
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
			const x = right - j;
			const y = (right + 1 & 2) === 0 ? size - 1 - vert : vert;
			if (isFunction[y][x] !== true && i < codewords.length * 8) {
				const byte = codewords[i >>> 3] ?? 0;
				modules[y][x] = (byte >> 7 - (i & 7) & 1) === 1;
				i++;
			}
		}
	}
}
/** 应用掩码（XOR，自逆）。 */
function applyMask(modules, isFunction, size, mask) {
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		if (isFunction[y][x] === true) continue;
		let invert;
		switch (mask) {
			case 0:
				invert = (x + y) % 2 === 0;
				break;
			case 1:
				invert = y % 2 === 0;
				break;
			case 2:
				invert = x % 3 === 0;
				break;
			case 3:
				invert = (x + y) % 3 === 0;
				break;
			case 4:
				invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
				break;
			case 5:
				invert = x * y % 2 + x * y % 3 === 0;
				break;
			case 6:
				invert = (x * y % 2 + x * y % 3) % 2 === 0;
				break;
			default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0;
		}
		if (invert) modules[y][x] = !modules[y][x];
	}
}
/**
* 按规范的 4 条规则计算掩码惩罚分（越小越好）。
*
* - N1 = 3：同色连续 5 个以上，每多一个 +1
* - N2 = 3：2×2 同色块
* - N3 = 40：出现 finder-like 图案（`1011101` 前后带 4 个浅色）
* - N4 = 10：深浅比例偏离 50%（每 5% 一档）
*/
function computePenalty(modules, size) {
	const N1 = 3;
	const N2 = 3;
	const N3 = 40;
	const N4 = 10;
	let result = 0;
	for (let y = 0; y < size; y++) {
		const row = modules[y];
		result += penaltyForLine(row, size, N1, N3);
	}
	for (let x = 0; x < size; x++) {
		const col = [];
		for (let y = 0; y < size; y++) col.push(modules[y][x] === true);
		result += penaltyForLine(col, size, N1, N3);
	}
	for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
		const c = modules[y][x];
		if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += N2;
	}
	let dark = 0;
	for (const row of modules) for (const cell of row) if (cell) dark++;
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	result += Math.max(0, k) * N4;
	return result;
}
/** 单行/单列的规则 1 与规则 3 惩罚。 */
function penaltyForLine(line, size, N1, N3) {
	let result = 0;
	let runLength = 1;
	for (let i = 1; i < size; i++) if (line[i] === line[i - 1]) runLength++;
	else {
		if (runLength >= 5) result += N1 + (runLength - 5);
		runLength = 1;
	}
	if (runLength >= 5) result += N1 + (runLength - 5);
	const PATTERN_A = [
		true,
		false,
		true,
		true,
		true,
		false,
		true,
		false,
		false,
		false,
		false
	];
	const PATTERN_B = [
		false,
		false,
		false,
		false,
		true,
		false,
		true,
		true,
		true,
		false,
		true
	];
	for (let i = 0; i + 11 <= size; i++) {
		let matchA = true;
		let matchB = true;
		for (let j = 0; j < 11; j++) {
			if (line[i + j] !== PATTERN_A[j]) matchA = false;
			if (line[i + j] !== PATTERN_B[j]) matchB = false;
			if (!matchA && !matchB) break;
		}
		if (matchA) result += N3;
		if (matchB) result += N3;
	}
	return result;
}
/**
* 生成 QR 模块矩阵。
*
* ⚠️ 只实现 byte 模式 + 纠错等级 M + 版本 1–10 —— 本插件的用途是编码一个
* 约 145 字节的固定形态 URL。超出容量时**抛错**，由调用方缩短内容，
* 而不是静默产出扫不出来的坏码。
*/
function buildQrMatrix(text, options = {}) {
	const level = options.errorCorrection ?? "M";
	if (level !== "M") throw new Error(`二维码目前只支持纠错等级 M（收到 ${level}）`);
	const forcedMask = options.mask;
	if (forcedMask !== void 0 && (!Number.isInteger(forcedMask) || forcedMask < 0 || forcedMask > 7)) throw new Error(`掩码必须是 0..7 的整数（收到 ${String(forcedMask)}）`);
	const bytes = Array.from(new TextEncoder().encode(text));
	const version = pickVersion(bytes.length);
	if (version === void 0) throw new Error(`二维码内容过长（${bytes.length} 字节，上限 213 字节），请缩短内容`);
	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array(size).fill(false));
	const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
	drawFunctionPatterns(modules, isFunction, size, version);
	drawCodewords(modules, isFunction, size, buildCodewords(bytes, version));
	let bestMask = 0;
	if (forcedMask !== void 0) bestMask = forcedMask;
	else {
		let bestPenalty = Number.POSITIVE_INFINITY;
		for (let mask = 0; mask < 8; mask++) {
			applyMask(modules, isFunction, size, mask);
			drawFormatBits(modules, isFunction, size, mask);
			const penalty = computePenalty(modules, size);
			if (penalty < bestPenalty) {
				bestPenalty = penalty;
				bestMask = mask;
			}
			applyMask(modules, isFunction, size, mask);
		}
	}
	applyMask(modules, isFunction, size, bestMask);
	drawFormatBits(modules, isFunction, size, bestMask);
	return {
		size,
		modules
	};
}
/**
* 把矩阵渲染成内联 SVG 字符串。
*
* 用 SVG 而非 canvas：登录页直接把它插进 DOM 即可，无需任何 JS 绘图调用，
* 且在任意缩放下都清晰（`shape-rendering: crispEdges` 保证模块边缘锐利）。
*/
function renderQrSvg(text, options = {}) {
	const px = options.size ?? 158;
	const margin = options.margin ?? 4;
	const dark = options.dark ?? "#000000";
	const light = options.light ?? "#ffffff";
	const { size, modules } = buildQrMatrix(text);
	const dim = size + margin * 2;
	const segments = [];
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y]?.[x] === true) segments.push(`M${x + margin},${y + margin}h1v1h-1z`);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${segments.join("")}" fill="${dark}"/></svg>`;
}
// src/raccoon-login.ts
/**
* Raccoon QR sign-in.
*
* The official desktop client receives its authorization through the
* `office-raccoon://auth/callback` protocol, which a host-side Node process
* cannot receive, and the web page's callback address is fixed. The current
* website instead asks the server for a QR session, renders the returned
* `scan_path`, and polls the same session until the phone confirms it.
*
* The QR code is single-use and server-issued: a locally invented code looks
* fine while polling but the scan landing page rejects it as expired or
* already used. Nothing here may fabricate the code.
*
* @module dsh-llm-adapters/raccoon-login
*/
const RACCOON_WEB_API = "https://xiaohuanxiong.com/api/web";
/** IAM endpoints that create and poll the QR session. */
const RACCOON_IAM_BASE = "https://xiaohuanxiong.com/api/iam/v1";
/** Origin the server-issued `scan_path` is resolved against. */
const RACCOON_QR_ORIGIN = "https://xiaohuanxiong.com";
/** Name shown by the scan landing page; the website sends exactly this value. */
const RACCOON_QR_APP_NAME = "商汤小浣熊";
const IAM_TIMEOUT_MS = 2e4;
/** A failed IAM call; `code` is the server's error code when there is one. */
var RaccoonIamError = class extends Error {
	code;
	status;
	constructor(code, message, status = 0) {
		super(message);
		this.code = code;
		this.status = status;
		this.name = "RaccoonIamError";
	}
};
function stringField(value) {
	return typeof value === "string" && value.length > 0 ? value : void 0;
}
function numberField(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** POST one IAM endpoint and unwrap its `{ code, data }` envelope. */
async function postIam(path, body, fetchImpl) {
	let response;
	try {
		response = await fetchImpl(`${RACCOON_IAM_BASE}${path}`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json"
			},
			body: JSON.stringify(body),
			redirect: "error",
			signal: AbortSignal.timeout(IAM_TIMEOUT_MS)
		});
	} catch (error) {
		throw new RaccoonIamError(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "TIMEOUT" : "NETWORK_ERROR", `小浣熊登录请求失败：${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed;
	try {
		parsed = await response.json();
	} catch {
		throw new RaccoonIamError("INVALID_RESPONSE", `小浣熊登录响应不是 JSON（HTTP ${response.status}）`, response.status);
	}
	const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	const code = stringField(root.code) ?? "";
	if (!response.ok || code !== "OK") {
		const message = stringField(root.message) ?? `小浣熊登录服务返回错误 ${code || `HTTP ${response.status}`}`;
		throw new RaccoonIamError(code || `HTTP_${response.status}`, message, response.status);
	}
	return root.data !== null && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : void 0;
}
/** The server must hand out a same-origin path; never treat it as a URL to visit blindly. */
function assertScanPath(scanPath) {
	if (!scanPath.startsWith("/") || scanPath.startsWith("//") || /[\\\s#]/.test(scanPath)) throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录服务返回了无效的扫码地址。");
	const url = new URL(scanPath, RACCOON_QR_ORIGIN);
	if (url.protocol !== "https:" || url.origin !== "https://xiaohuanxiong.com" || url.hash !== "") throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录服务返回了无效的扫码地址。");
}
/** Ask the server for a new single-use QR session. */
async function createRaccoonQr(fetchImpl = fetch) {
	const data = await postIam("/auth/mp/qrcode", {}, fetchImpl);
	const code = stringField(data?.qrcode_code);
	const scanPath = stringField(data?.scan_path);
	const expiresIn = numberField(data?.expires_in);
	const pollInterval = numberField(data?.poll_interval);
	if (code === void 0 || scanPath === void 0 || expiresIn === void 0 || pollInterval === void 0 || expiresIn <= 0 || expiresIn > 3600 || pollInterval <= 0) throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录服务返回的二维码信息不完整。");
	assertScanPath(scanPath);
	return {
		code,
		scanPath,
		expiresIn,
		pollInterval
	};
}
/** The exact URL the website encodes into its own QR. */
function raccoonQrContent(session) {
	const url = new URL(session.scanPath, RACCOON_QR_ORIGIN);
	url.search = "";
	url.searchParams.set("code", session.code);
	url.searchParams.set("appname", RACCOON_QR_APP_NAME);
	url.searchParams.set("source", "platform");
	return url.href;
}
/**
* One poll. Expiry is reported as its own state; ordinary network hiccups stay
* pending so a transient failure cannot kill a login the user is completing.
*/
async function pollRaccoonQr(code, fetchImpl = fetch) {
	try {
		const data = await postIam("/auth/mp/qrcode/login", { qrcode_code: code }, fetchImpl);
		if (data === void 0) throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录服务没有返回二维码状态。");
		const status = stringField(data.status) ?? "";
		const expiresIn = numberField(data.expires_in);
		const pollInterval = numberField(data.poll_interval);
		const timing = {
			...expiresIn === void 0 ? {} : { expiresIn },
			...pollInterval === void 0 ? {} : { pollInterval }
		};
		if (status === "canceled") return {
			status: "canceled",
			...timing
		};
		if (status === "logging") return {
			status: "logging",
			...timing
		};
		if (status !== "success") return {
			status: "pending",
			...timing
		};
		const accessToken = stringField(data.access_token);
		if (accessToken === void 0) throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录响应缺少访问令牌。");
		const tokenType = stringField(data.token_type);
		if (tokenType !== void 0 && tokenType.toLowerCase() !== "bearer") throw new RaccoonIamError("INVALID_RESPONSE", "小浣熊登录响应包含不支持的令牌类型。");
		return {
			status: "success",
			accessToken,
			...timing
		};
	} catch (error) {
		if (error instanceof RaccoonIamError) {
			if (error.code === "AUTH_QRCODE_EXPIRED" || error.code === "AUTH_QRCODE_NOT_FOUND") return {
				status: "expired",
				message: "二维码已过期，请重新发起登录。"
			};
			if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") return { status: "pending" };
			return {
				status: "error",
				message: error.message
			};
		}
		return { status: "pending" };
	}
}
/** A cookie value from one `Set-Cookie` header, if the response carried it. */
function cookieValue(setCookies, matches) {
	for (const line of setCookies) {
		const pair = line.split(";", 1)[0] ?? "";
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		if (!matches(pair.slice(0, index).trim())) continue;
		const raw = pair.slice(index + 1).trim().replace(/^"|"$/g, "");
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
}
/**
* Establish the business session for a freshly issued IAM token.
*
* The website calls this before its own `/api/web` requests, and the response
* is what gives it the `xhx_token` business cookie. A host-side fetch keeps no
* cookie jar, so the token is taken out of `Set-Cookie` explicitly. Failure is
* not fatal: the catalog probe in `finish()` is the authoritative check.
*/
async function confirmIamSession(token, fetchImpl) {
	try {
		const response = await fetchImpl(`${RACCOON_WEB_API}/auth/v1/iam/confirm`, {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				"x-raccoon-language": "zh-CN"
			},
			body: "{}",
			redirect: "error",
			signal: AbortSignal.timeout(IAM_TIMEOUT_MS)
		});
		const headers = response.headers;
		const setCookies = headers.getSetCookie?.() ?? (headers.get("set-cookie") === null ? [] : [headers.get("set-cookie")]);
		await response.text();
		if (!response.ok) return {};
		const businessToken = cookieValue(setCookies, (name) => name === "xhx_token" || name.endsWith("xhx_token"));
		return { ...businessToken === void 0 ? {} : { token: businessToken } };
	} catch {}
	return {};
}
/**
* One running Raccoon QR login. `start()` resolves once the local page is
* listening; the user completes the scan in that page.
*/
var RaccoonQrLogin = class {
	options;
	handle;
	failure;
	constructor(options) {
		this.options = options;
	}
	status() {
		if (this.handle !== void 0) return this.handle.status();
		return this.failure ?? {
			running: false,
			phase: "idle"
		};
	}
	async start() {
		const current = this.handle?.status();
		if (current?.running === true) return current;
		if (this.handle !== void 0) {
			await this.handle.close();
			this.handle = void 0;
		}
		this.failure = void 0;
		const fetchImpl = this.options.fetchImpl ?? fetch;
		let session;
		let deadline = 0;
		let accessToken = "";
		try {
			const handle = await startLoginPage({
				title: "Raccoon 登录",
				heading: "使用微信扫码登录 Raccoon",
				subtitle: "打开微信扫一扫，扫描下方二维码",
				prepare: async () => {
					session = await createRaccoonQr(fetchImpl);
					deadline = Date.now() + session.expiresIn * 1e3;
					return { qr: renderQrSvg(raccoonQrContent(session), { size: 220 }) };
				},
				poll: async () => {
					if (session === void 0) return {
						phase: "error",
						message: "二维码尚未准备好，请重新发起登录。"
					};
					if (Date.now() >= deadline) return {
						phase: "expired",
						message: "二维码已过期，请重新发起登录。"
					};
					const polled = await pollRaccoonQr(session.code, fetchImpl);
					if (polled.expiresIn !== void 0) deadline = Date.now() + polled.expiresIn * 1e3;
					if (polled.status === "success" && polled.accessToken !== void 0) {
						accessToken = polled.accessToken;
						return {
							phase: "done",
							message: "登录成功，可以关闭此窗口。"
						};
					}
					if (polled.status === "logging") return {
						phase: "scanned",
						message: "已扫码，请在手机上确认"
					};
					if (polled.status === "canceled") return {
						phase: "cancelled",
						message: "你已取消授权，请重新登录。"
					};
					if (polled.status === "expired") return {
						phase: "expired",
						message: polled.message ?? "二维码已过期，请重新发起登录。"
					};
					if (polled.status === "error") return {
						phase: "error",
						message: polled.message ?? "小浣熊登录失败，请重试。"
					};
					return {
						phase: "waiting",
						message: "等待扫码…"
					};
				},
				finish: async () => {
					if (accessToken.length === 0) throw new Error("小浣熊登录响应缺少访问令牌。");
					const token = (await confirmIamSession(accessToken, fetchImpl)).token ?? accessToken;
					if (!await this.options.validate(token)) throw new Error("小浣熊账号已授权，但模型网关拒绝了这次登录令牌。请重新扫码；若持续出现，请稍后再试。");
					const info = await raccoonAccountInfo({
						accessToken: token,
						fetchImpl
					});
					await this.options.save({
						token,
						...info
					});
				},
				...this.options.timeoutMs === void 0 ? {} : { timeoutMs: this.options.timeoutMs }
			});
			this.handle = handle;
			handle.result.catch(() => void 0);
			return handle.status();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.failure = {
				running: false,
				phase: "error",
				error: message
			};
			throw error;
		}
	}
	async cancel() {
		const handle = this.handle;
		if (handle === void 0) return;
		await handle.close();
	}
};
// src/raccoon.ts
const RACCOON_BASE = "https://xiaohuanxiong.com/api/web";
const RACCOON_CLIENT_VERSION = "v1.0.35";
/** The page whose first authenticated load carries the daily-points grant. */
const RACCOON_CHECKIN_URL = "https://xiaohuanxiong.com/work/home";
/** Desktop identity the official client sends; the gateway varies by platform. */
function raccoonClientPlatform() {
	if (process.platform === "darwin") return "desktop-macos";
	if (process.platform === "linux") return "desktop-linux";
	return "desktop-windows";
}
function numeric(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
}
function record$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function messageOf(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const record = payload;
	return typeof record.message === "string" && record.message.length > 0 ? record.message : void 0;
}
function epochOf(value) {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 0xe8d4a51000 ? value * 1e3 : value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : void 0;
	}
}
/** The date label Raccoon uses for the daily grant (Beijing time). */
function raccoonDay(value) {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).format(typeof value === "string" || typeof value === "number" ? new Date(value) : value);
}
function raccoonHeaders(token) {
	return {
		authorization: `Bearer ${token}`,
		"x-org-code": "",
		"x-raccoon-language": "zh",
		"x-client-platform": raccoonClientPlatform(),
		"x-client-version": RACCOON_CLIENT_VERSION
	};
}
/** Whether the gateway accepts a token harvested from the browser. */
async function raccoonAccessTokenValid(token, fetchImpl = fetch) {
	try {
		const response = await fetchImpl(`${RACCOON_BASE}/llm/v2/model_catalog`, {
			headers: {
				...raccoonHeaders(token),
				accept: "application/json"
			},
			signal: AbortSignal.timeout(15e3)
		});
		if (!response.ok) return false;
		const payload = JSON.parse(await response.text());
		if (payload === null || typeof payload !== "object") return false;
		const record = payload;
		if (typeof record.code === "number" && record.code !== 0) return false;
		const data = record.data !== null && typeof record.data === "object" ? record.data : void 0;
		return Array.isArray(data?.categories);
	} catch {
		return false;
	}
}
function jwtExpiry$1(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
		const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
		if (payload === null || typeof payload !== "object") return void 0;
		const exp = payload.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? exp : void 0;
	} catch {
		return;
	}
}
/**
* Among the tokens a browser login leaves behind, the refresh token is the
* other JWT with the furthest expiry; the access token itself is excluded.
*/
function raccoonRefreshCandidate(tokens, accessToken) {
	let best;
	for (const token of tokens) {
		if (token === accessToken) continue;
		const expiry = jwtExpiry$1(token);
		if (expiry === void 0) continue;
		if (best === void 0 || expiry > best.expiry) best = {
			token,
			expiry
		};
	}
	return best?.token;
}
var RaccoonProvider = class {
	options;
	catalog;
	quotaCache;
	quotaInflight;
	checkinInflight;
	loginFlow;
	openRouter;
	constructor(options) {
		this.options = options;
		this.openRouter = options.openRouter ?? new OpenRouterCatalog(options.fetchImpl ?? fetch);
		this.catalog = new ModelCatalog(() => this.fetchModels(), options.ttlMs);
	}
	async status() {
		return this.options.auth.status();
	}
	async signedIn() {
		return (await this.options.auth.status()).signedIn;
	}
	/** Start the local WeChat QR page; the settings page opens the returned URL. */
	async startBrowserLogin() {
		return this.login().start();
	}
	browserLoginStatus() {
		return this.loginFlow?.status() ?? {
			running: false,
			phase: "idle"
		};
	}
	async cancelBrowserLogin() {
		await this.loginFlow?.cancel();
	}
	/** Stop a login page that outlived the plugin. */
	close() {
		this.loginFlow?.cancel();
	}
	login() {
		if (this.loginFlow !== void 0) return this.loginFlow;
		const fetchImpl = this.options.fetchImpl ?? fetch;
		this.loginFlow = new RaccoonQrLogin({
			fetchImpl,
			validate: (token) => raccoonAccessTokenValid(token, fetchImpl),
			save: async (account) => {
				await this.options.store.saveRaccoon({
					accessToken: account.token,
					loginAt: Date.now(),
					...account.phone === void 0 ? {} : { phone: account.phone },
					...account.name === void 0 ? {} : { name: account.name },
					...account.ownerType === void 0 ? {} : { ownerType: account.ownerType }
				});
				this.invalidateModels();
				this.invalidateQuota();
			}
		});
		return this.loginFlow;
	}
	async logoutAccount() {
		await this.options.auth.logout();
		this.invalidateModels();
		this.invalidateQuota();
	}
	headers(token) {
		return raccoonHeaders(token);
	}
	/** Run one JSON call; a rejected token means this login needs a new scan. */
	async authorizedJson(path, init = {}, extraHeaders = {}) {
		const token = await this.options.auth.accessToken();
		try {
			return await fetchJson(`${RACCOON_BASE}${path}`, {
				...init,
				headers: {
					...this.headers(token),
					...extraHeaders
				},
				timeoutMs: this.options.timeoutMs(),
				fetchImpl: this.options.fetchImpl
			});
		} catch (error) {
			if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
				this.invalidateModels();
				this.invalidateQuota();
				throw new Error("小浣熊登录已失效，请在设置页点「打开扫码登录」。");
			}
			throw error;
		}
	}
	async fetchModels() {
		const [openRouter, payload] = await Promise.all([this.openRouter.models(), this.authorizedJson("/llm/v2/model_catalog")]);
		if (payload !== null && typeof payload === "object") {
			const code = payload.code;
			if (typeof code === "number" && code !== 0) throw new Error(messageOf(payload) ?? `小浣熊模型目录返回 code=${code}`);
		}
		const models = parseRaccoonCatalog(payload, {
			textOnly: this.options.textOnly(),
			forceVision: this.options.forceVision(),
			openRouter
		});
		if (models.length === 0) throw new Error("小浣熊返回的模型目录为空。");
		return models;
	}
	async models(fresh = false) {
		return this.catalog.models(fresh);
	}
	catalogError() {
		return this.catalog.error();
	}
	invalidateModels() {
		this.catalog.invalidate();
	}
	async quota(fresh = false) {
		if (!fresh && this.quotaCache !== void 0 && Date.now() - this.quotaCache.at < 6e4) return this.quotaCache.value;
		if (this.quotaInflight !== void 0) return this.quotaInflight;
		this.quotaInflight = (async () => {
			try {
				const payload = await this.authorizedJson("/points/v1/balance");
				const root = payload !== null && typeof payload === "object" ? payload : {};
				if (typeof root.code === "number" && root.code !== 0) throw new Error(messageOf(payload) ?? `小浣熊额度接口返回 code=${root.code}`);
				const data = root.data !== null && typeof root.data === "object" ? root.data : root;
				const available = numeric(data.available_points) ?? numeric(data.total_chargeable_points) ?? numeric(data.total) ?? numeric(data.balance) ?? numeric(data.points);
				if (available === void 0) throw new Error("小浣熊额度响应格式无法识别。");
				const snapshot = {
					at: Date.now(),
					total: available,
					available,
					...numeric(data.reward_points) === void 0 ? {} : { permanent: numeric(data.reward_points) },
					...numeric(data.daily_points) === void 0 ? {} : { daily: numeric(data.daily_points) }
				};
				this.quotaCache = {
					at: snapshot.at,
					value: snapshot
				};
				return snapshot;
			} finally {
				this.quotaInflight = void 0;
			}
		})();
		return this.quotaInflight;
	}
	invalidateQuota() {
		this.quotaCache = void 0;
	}
	/**
	* Today's daily-points bill, when the website has already granted it.
	*
	* Raccoon has no standalone check-in endpoint. The daily points are issued
	* by the server on the first authenticated web visit and announced through
	* `point_grant_popups` on `setting_info`; the bills list is the durable proof.
	*/
	async dailyGrant() {
		const payload = await this.authorizedJson("/points/v2/bills?paging.limit=50&type=all");
		const root = record$2(payload) ?? {};
		if (typeof root.code === "number" && root.code !== 0) throw new Error(messageOf(payload) ?? `小浣熊积分流水返回 code=${root.code}`);
		const data = record$2(root.data) ?? root;
		const items = Array.isArray(data.items) ? data.items : [];
		const today = raccoonDay(Date.now());
		for (const raw of items) {
			const item = record$2(raw);
			if (item?.biz_type !== "daily_grant") continue;
			const day = item.grant_at ?? item.created_at;
			if (typeof day !== "string" && typeof day !== "number") continue;
			let label;
			try {
				label = raccoonDay(day);
			} catch {
				continue;
			}
			if (label !== today) continue;
			const issued = epochOf(item.created_at) ?? epochOf(item.grant_at);
			const points = numeric(item.points);
			return {
				...points === void 0 ? {} : { points },
				...issued === void 0 ? {} : { grantedAt: issued }
			};
		}
	}
	async checkinStatus() {
		const grant = await this.dailyGrant();
		if (grant !== void 0) return {
			available: true,
			claimed: true,
			deviceClaimed: false,
			...grant.points === void 0 ? {} : { reward: grant.points },
			...grant.grantedAt === void 0 ? {} : { grantedAt: grant.grantedAt },
			message: "今日每日积分已到账",
			url: RACCOON_CHECKIN_URL
		};
		return {
			available: true,
			claimed: false,
			deviceClaimed: false,
			message: "每日积分在当天首次打开网页时发放",
			url: RACCOON_CHECKIN_URL
		};
	}
	async claimCheckin() {
		await this.authorizedJson("/office/v3/setting_info", {}, {
			"x-client-platform": "web",
			"x-client-version": "131.0.0.0"
		});
		const grant = await this.dailyGrant();
		if (grant === void 0) return {
			available: true,
			claimed: false,
			deviceClaimed: false,
			message: "每日积分尚未到账；请打开网页签到",
			url: RACCOON_CHECKIN_URL
		};
		this.invalidateQuota();
		return {
			available: true,
			claimed: true,
			deviceClaimed: false,
			...grant.points === void 0 ? {} : { reward: grant.points },
			...grant.grantedAt === void 0 ? {} : { grantedAt: grant.grantedAt },
			message: "每日积分已到账",
			url: RACCOON_CHECKIN_URL
		};
	}
	/**
	* One automatic check-in pass: report today's grant, or ask the website path
	* to issue it. Shared so overlapping timers cannot spend two call slots.
	*/
	async ensureDailyCheckin() {
		if (this.checkinInflight !== void 0) return this.checkinInflight;
		this.checkinInflight = (async () => {
			const status = await this.checkinStatus();
			return status.claimed ? status : this.claimCheckin();
		})();
		try {
			return await this.checkinInflight;
		} finally {
			this.checkinInflight = void 0;
		}
	}
	async *stream(options, model, readImage, onUnauthorized) {
		const token = await this.options.auth.accessToken();
		const body = buildBody(options, model, await buildMessages(options, readImage), buildTools(options));
		const effort = options.reasoningEffort;
		if (effort !== void 0) {
			if (effort === "off" || effort === "none") {
				body.extra_body = { thinking: { type: "disabled" } };
				if (effort === "none") body.reasoning_effort = "none";
			} else {
				body.extra_body = { thinking: { type: "enabled" } };
				if (effort !== "on") body.reasoning_effort = effort;
			}
		}
		try {
			yield* openAiStream({
				url: `${RACCOON_BASE}/llm/v2/chat/completions`,
				headers: this.headers(token),
				body,
				signal: options.signal,
				fetchImpl: this.options.fetchImpl,
				onUnauthorized: () => {
					this.invalidateModels();
					this.invalidateQuota();
					onUnauthorized?.();
				}
			});
		} catch (error) {
			if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) throw new Error("小浣熊登录已失效，请在设置页点「打开扫码登录」。");
			throw error;
		}
	}
};
// src/trae-login.ts
/**
* Trae sign-in through the provider's own website.
*
* The plugin does not read a desktop install: it opens a dedicated browser
* profile, lets the user sign in on trae.cn / trae.ai, and then takes the
* session the website itself created. Two things come out of that session:
*
*  - the `Cloud-IDE-JWT` token, fetched with the page's own cookies through
*    `/cloudide/api/v3/common/GetUserToken` — the same call the site makes;
*  - the device fingerprint (`__msuuid__` from the page, or one generated in
*    the page), which Trae's check-in route requires and which therefore must
*    belong to this web session rather than to a machine install.
*
* Cookies are captured over the DevTools protocol and kept in the plugin's own
* account store so the short-lived JWT can be renewed later; the dedicated
* browser profile stays on disk and is reused for subsequent sign-ins.
*
* @module dsh-llm-adapters/trae-login
*/
const DEFAULT_TIMEOUT_MS = 3e5;
const POLL_INTERVAL_MS = 2e3;
const DEVICE_EXPRESSION = `(() => {
  try { const value = localStorage.getItem('__msuuid__'); if (value) return value } catch (error) {}
  try { const value = localStorage.getItem('msid'); if (value) return value } catch (error) {}
  try { return crypto.randomUUID() } catch (error) { return '' }
})()`;
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
function record$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text$1(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
/** Upstream epochs are seconds on some fields and milliseconds on others. */
function epochMs$1(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return void 0;
	return value < 0xe8d4a51000 ? Math.round(value * 1e3) : Math.round(value);
}
function jwtExpiry(token) {
	const parts = token.split(".");
	if (parts.length < 2) return void 0;
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
		const exp = record$1(JSON.parse(Buffer.from(padded, "base64").toString("utf8")))?.exp;
		return typeof exp === "number" ? epochMs$1(exp) : void 0;
	} catch {
		return;
	}
}
function machineIdOf(deviceId) {
	return createHash("sha256").update(`trae-web-machine\0${deviceId}`).digest("hex");
}
/** Browser binaries this plugin can drive, most specific first. */
function browserCandidates() {
	const env = process.env;
	if (process.platform === "win32") {
		const roots = [
			env["PROGRAMFILES"],
			env["PROGRAMFILES(X86)"],
			env["LOCALAPPDATA"]
		].filter((root) => typeof root === "string" && root !== "");
		return [
			...roots.map((root) => join(root, "Google", "Chrome", "Application", "chrome.exe")),
			...roots.map((root) => join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
			...roots.map((root) => join(root, "Chromium", "Application", "chrome.exe"))
		];
	}
	if (process.platform === "darwin") return [
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
	];
	const names = [
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"microsoft-edge",
		"brave-browser"
	];
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/usr/bin/microsoft-edge",
		"/snap/bin/chromium",
		...(env.PATH ?? "").split(":").filter((directory) => directory !== "").flatMap((directory) => names.map((name) => join(directory, name)))
	];
}
function findBrowser() {
	return browserCandidates().find((candidate) => existsSync(candidate));
}
/** A minimal DevTools protocol client over the page target's WebSocket. */
var CdpClient = class CdpClient {
	socket;
	nextId = 0;
	pending = /* @__PURE__ */ new Map();
	constructor(socket) {
		this.socket = socket;
		socket.onmessage = (event) => {
			if (typeof event.data !== "string") return;
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			const frame = record$1(message);
			const id = typeof frame?.id === "number" ? frame.id : void 0;
			if (id === void 0) return;
			const waiter = this.pending.get(id);
			if (waiter === void 0) return;
			this.pending.delete(id);
			if (frame?.error !== void 0) {
				const error = record$1(frame.error);
				waiter.reject(new Error(text$1(error?.message) ?? "浏览器调试命令失败"));
			} else waiter.resolve(frame?.result);
		};
	}
	static async connect(url) {
		const Constructor = globalThis.WebSocket;
		if (Constructor === void 0) throw new Error("当前 Node 版本没有 WebSocket，无法连接浏览器调试端口");
		const socket = new Constructor(url);
		await new Promise((resolve, reject) => {
			socket.onopen = () => resolve();
			socket.onerror = () => reject(/* @__PURE__ */ new Error("无法连接浏览器调试端口"));
		});
		return new CdpClient(socket);
	}
	send(method, params = {}) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value),
				reject
			});
			try {
				this.socket.send(JSON.stringify({
					id,
					method,
					params
				}));
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	async evaluate(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true
		});
		if (result?.exceptionDetails !== void 0) throw new Error(result.exceptionDetails.text ?? "页面脚本执行失败");
		return result?.result?.value;
	}
	close() {
		try {
			this.socket.close();
		} catch {}
	}
};
async function waitForDevToolsPort(profile, timeoutMs) {
	const file = join(profile, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const lines = readFileSync(file, "utf8").trim().split(/\r?\n/);
			const port = Number(lines[0]);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {}
		await sleep(150);
	}
	throw new Error("浏览器没有在预期时间内打开调试端口，登录无法继续");
}
async function waitForPage(port, origin, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (response.ok) {
				const targets = await response.json();
				const page = targets.find((target) => target.type === "page" && target.url.startsWith(origin)) ?? targets.find((target) => target.type === "page" && target.url.includes("trae"));
				if (page?.webSocketDebuggerUrl !== void 0) return page;
			}
		} catch {}
		await sleep(250);
	}
	throw new Error("浏览器打开了，但没有找到 Trae 登录页");
}
function cookieHeader(cookies, host) {
	const jar = /* @__PURE__ */ new Map();
	for (const cookie of cookies) {
		const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
		if (host !== domain && !host.endsWith(`.${domain}`)) continue;
		if (cookie.expires > 0 && cookie.expires * 1e3 <= Date.now()) continue;
		if (!jar.has(cookie.name)) jar.set(cookie.name, cookie.value);
	}
	return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}
async function authPost(profile, cookie, path, body) {
	const response = await fetch(`${profile.apiBase}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			cookie,
			origin: profile.webOrigin,
			referer: `${profile.webOrigin}/`,
			"user-agent": TRAE_WEB_USER_AGENT
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15e3)
	});
	const raw = await response.text();
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		throw new Error(`${path} 返回的不是 JSON（HTTP ${response.status}）`);
	}
	if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status}`);
	const root = record$1(payload);
	const error = record$1(record$1(root?.ResponseMetadata)?.Error);
	if (error !== void 0 && text$1(error.Message) !== void 0) throw new Error(text$1(error.Message));
	return root ?? {};
}
/**
* One browser-backed Trae login.
*
* A flow is single-use: after it settles, start a new one for another login.
*/
var TraeWebLogin = class {
	options;
	phase = "idle";
	message = "";
	startedAt;
	finishedAt;
	error;
	signedIn = false;
	browser;
	profile;
	persistentProfile = false;
	cdp;
	timer;
	deadline;
	closed = false;
	polling = false;
	failures = 0;
	constructor(options) {
		this.options = options;
	}
	get timeoutMs() {
		return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}
	status() {
		return {
			running: this.phase === "preparing" || this.phase === "waiting",
			phase: this.phase,
			...this.message === "" ? {} : { message: this.message },
			...this.startedAt === void 0 ? {} : { startedAt: this.startedAt },
			...this.finishedAt === void 0 ? {} : { finishedAt: this.finishedAt },
			...this.signedIn ? { signedIn: true } : {},
			...this.error === void 0 ? {} : { error: this.error }
		};
	}
	async start() {
		if (this.phase === "preparing" || this.phase === "waiting") return this.status();
		this.reset();
		this.phase = "preparing";
		this.startedAt = Date.now();
		this.message = "正在打开浏览器…";
		try {
			await this.launch();
			if (this.closed) return this.status();
			this.phase = "waiting";
			this.message = "请在浏览器中完成登录，成功后窗口会自动关闭。";
			this.timer = setInterval(() => {
				this.tick();
			}, POLL_INTERVAL_MS);
			this.timer.unref?.();
			this.deadline = setTimeout(() => {
				this.fail("登录等待超时，请重新发起登录。");
			}, this.timeoutMs);
			this.deadline.unref?.();
			this.tick();
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
		return this.status();
	}
	async cancel() {
		if (this.phase !== "preparing" && this.phase !== "waiting") return;
		this.settle("cancelled", "登录已取消。");
	}
	async close() {
		await this.cancel();
		await this.cleanup();
	}
	reset() {
		this.phase = "idle";
		this.message = "";
		this.startedAt = void 0;
		this.finishedAt = void 0;
		this.error = void 0;
		this.signedIn = false;
		this.closed = false;
		this.polling = false;
		this.failures = 0;
		this.persistentProfile = false;
	}
	async launch() {
		const profile = TRAE_REGION_PROFILES[this.options.region];
		const executable = findBrowser();
		if (executable === void 0) throw new Error("没有找到 Chrome 或 Edge。请先安装其中一个浏览器后再登录。");
		const directory = this.options.profileDir ?? mkdtempSync(join(tmpdir(), "dsh-trae-login-"));
		this.persistentProfile = this.options.profileDir !== void 0;
		if (this.persistentProfile) mkdirSync(directory, { recursive: true });
		this.profile = directory;
		const child = spawn(executable, [
			"--remote-debugging-port=0",
			`--user-data-dir=${directory}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-sync",
			"--disable-background-networking",
			"--disable-blink-features=AutomationControlled",
			"--disable-features=Translate,MediaRouter",
			`${profile.webOrigin}/login?redirect_url=${encodeURIComponent(`${profile.webOrigin}/`)}`
		], { stdio: "ignore" });
		this.browser = child;
		child.once("error", (error) => {
			this.fail(`无法启动浏览器：${error.message}`);
		});
		child.once("exit", () => {
			if (!this.closed && (this.phase === "preparing" || this.phase === "waiting")) this.fail("浏览器已关闭，登录未完成。");
		});
		const page = await waitForPage(await waitForDevToolsPort(directory, 25e3), profile.webOrigin, 25e3);
		this.cdp = await CdpClient.connect(page.webSocketDebuggerUrl);
	}
	async cookies(host) {
		const cdp = this.cdp;
		if (cdp === void 0) return "";
		let result;
		try {
			result = await cdp.send("Network.getAllCookies");
		} catch {
			result = await cdp.send("Storage.getCookies", {}).catch(() => void 0);
		}
		return cookieHeader(result?.cookies ?? [], host);
	}
	async tick() {
		if (this.phase !== "waiting" || this.cdp === void 0 || this.polling) return;
		this.polling = true;
		try {
			const profile = TRAE_REGION_PROFILES[this.options.region];
			const host = new URL(profile.apiBase).hostname;
			const cookie = await this.cookies(host);
			if (cookie === "") return;
			const result = record$1((await authPost(profile, cookie, "/cloudide/api/v3/trae/CheckLogin", {
				GetNickNameEditStatus: true,
				ReqSource: "OfficialSite"
			})).Result);
			if (result?.IsLogin !== true) {
				this.failures = 0;
				return;
			}
			const token = text$1(record$1((await authPost(profile, cookie, "/cloudide/api/v3/common/GetUserToken", {})).Result)?.Token);
			if (token === void 0) throw new Error("登录成功，但没有读到网页令牌；请重试。");
			const deviceId = text$1(await this.cdp.evaluate(DEVICE_EXPRESSION).catch(() => "")) ?? randomUUID();
			const name = await this.readName(profile, cookie);
			const sessionExpiresAt = epochMs$1(result.ExpiredAt);
			const expiresAt = jwtExpiry(token) ?? sessionExpiresAt;
			await this.options.save({
				accessToken: token,
				deviceId,
				machineId: machineIdOf(deviceId),
				...text$1(result.UserID) === void 0 ? {} : { userId: text$1(result.UserID) },
				...name === void 0 ? {} : { name },
				...expiresAt === void 0 ? {} : { expiresAt },
				cookies: cookie,
				...sessionExpiresAt === void 0 ? {} : { sessionExpiresAt }
			});
			this.signedIn = true;
			this.settle("done", "登录成功，浏览器窗口会自动关闭。");
		} catch (error) {
			this.failures += 1;
			if (this.failures >= 3) this.fail(error instanceof Error ? error.message : String(error));
		} finally {
			this.polling = false;
		}
	}
	async readName(profile, cookie) {
		try {
			const result = record$1((await authPost(profile, cookie, "/cloudide/api/v3/trae/GetUserInfo", { IfWebPage: true })).Result);
			return text$1(result?.ScreenName) ?? text$1(result?.NickName) ?? text$1(result?.UserName);
		} catch {
			return;
		}
	}
	settle(phase, message) {
		if (this.phase === "done" || this.phase === "error" || this.phase === "cancelled") return;
		this.phase = phase;
		this.message = message;
		this.finishedAt = Date.now();
		this.cleanup();
	}
	fail(message) {
		if (this.phase === "done" || this.phase === "error" || this.phase === "cancelled") return;
		this.phase = "error";
		this.error = message;
		this.message = message;
		this.finishedAt = Date.now();
		this.options.logger?.(`dsh-llm-adapters: Trae 登录失败：${message}`);
		this.cleanup();
	}
	async cleanup() {
		this.closed = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		if (this.deadline !== void 0) clearTimeout(this.deadline);
		this.timer = void 0;
		this.deadline = void 0;
		this.cdp?.close();
		this.cdp = void 0;
		const child = this.browser;
		this.browser = void 0;
		if (child !== void 0 && child.exitCode === null) {
			child.kill();
			if (process.platform === "win32" && child.pid !== void 0) try {
				spawn("taskkill", [
					"/pid",
					String(child.pid),
					"/T",
					"/F"
				], { stdio: "ignore" });
			} catch {}
		}
		const directory = this.profile;
		const persistent = this.persistentProfile;
		this.profile = void 0;
		this.persistentProfile = false;
		if (directory !== void 0 && !persistent) setTimeout(() => {
			try {
				rmSync(directory, {
					recursive: true,
					force: true,
					maxRetries: 10,
					retryDelay: 200
				});
			} catch {}
		}, 1500).unref?.();
	}
};
// src/trae.ts
/**
* Trae provider: model directory, SOLO chat, quota and daily check-in.
*
* Trae's website login yields the same `Cloud-IDE-JWT` its own clients use, so
* the plugin talks to the same gateways they do. Two catalog sources are merged:
*
*  - the Remote directory (`/api/remote/v1/models`) is the model skeleton —
*    display name, context window, multiplier, reasoning options, multimodal;
*  - `get_detail_param` supplies the `config_name` the chat endpoint accepts and
*    the output cap. A directory row with no callable config is NOT offered:
*    Trae lists some client-only models (Qwen3.8-Flash, Kimi-K2.8-Preview) that
*    the SOLO chat endpoint rejects with `4001`, and an entry that can only
*    fail is worse than an absent one.
*
* Levels and modalities go through the same `resolveCapabilities` rule as
* Loomy and Raccoon: OpenRouter's live metadata first, Trae's own declaration
* second, every level/modality when neither source says anything. The SOLO
* endpoint does not validate `reasoning_effort`, so the router's table cannot
* make a call fail; the shared index is cached on disk and refreshed on a
* schedule, which keeps the menu stable while offline.
*
* @module dsh-llm-adapters/trae
*/
/** Chat functions, in the order Trae itself prefers them. */
const TRAE_CHAT_FUNCTIONS = [
	"solo_work_remote",
	"solo_work_lite",
	"solo_agent_remote",
	"chat_v3",
	"solo_coder"
];
/**
* Directory functions. The first five are the chat routes above; the rest are
* IDE-only rosters that still list real models, so they are read for the union
* and their attribution is dropped when the chat route cannot use it.
*/
const TRAE_DIRECTORY_FUNCTIONS = [
	...TRAE_CHAT_FUNCTIONS,
	"solo_agent",
	"builder_v3",
	"chat",
	"inline_chat",
	"solo_agent_lite",
	"solo_design_lite",
	"solo_design_remote"
];
/**
* The channels Trae's own chat picker draws from.
*
* `solo_coder`, `chat_v3`, `inline_chat` and `solo_agent*` still answer with
* configs, but they also carry retired models (GLM 4.6/4.7, MiniMax M2,
* Kimi K2.0905, Qwen3 Coder, the plain DeepSeek-V4-Flash/Pro). Those rows are
* not in the client's list, so a wire config alone does not make a model
* current. Restricting the catalog to the two work functions reproduces the
* client's picker (21 models on a live CN account).
*/
const TRAE_PRIMARY_FUNCTIONS = ["solo_work_remote", "solo_work_lite"];
const EFFORT_ALIASES = {
	none: "none",
	minimal: "minimal",
	light: "low",
	low: "low",
	medium: "medium",
	high: "high",
	extra_high: "xhigh",
	xhigh: "xhigh",
	max: "max"
};
/** Our effort id → the spelling `llm_utils_chat` accepts. */
const WIRE_EFFORTS = {
	none: "none",
	minimal: "minimal",
	low: "light",
	medium: "medium",
	high: "high",
	xhigh: "extra_high",
	max: "max"
};
const TRAE_ERROR_HINTS = {
	1005: "当前套餐不包含这个模型",
	2001: "Trae 尚未下发这条通道的模型配置（上游问题，稍后重试）",
	4001: "这条通道不提供该模型（config_name 被拒绝）",
	4008: "账号的 SOLO 额度已用完",
	4011: "Trae 对该账号的这条通道做了限流，请稍后再试",
	4023: "Trae 不认识这个模型名",
	4222: "企业租户额度已用完"
};
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function text(value) {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function num(value) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
}
function epochMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return void 0;
	return value < 0xe8d4a51000 ? Math.round(value * 1e3) : Math.round(value);
}
/**
* The device id Trae's check-in API expects.
*
* The endpoint only accepts a 16-digit decimal device id; a UUID (what the web
* session's `__msuuid__` looks like) is rejected with `9074` even though every
* other Trae call accepts it. Live matrix (same account, same minute):
* UUID -> `9074`, 16-digit number -> `code: 0`. The number is derived from the
* web session's device id, so it still comes from this login and not from a
* desktop install, and it stays stable for that session.
*/
function checkinDeviceId(deviceId) {
	const hex = createHash("sha256").update(`trae-checkin\0${deviceId}`).digest("hex");
	return (BigInt(`0x${hex.slice(0, 16)}`) % 9000000000000000n + 1000000000000000n).toString();
}
/**
* The persistent browser profile used for one region.
*
* Reusing it keeps Trae's device fingerprint stable across sign-ins, so a
* re-login does not look like a brand-new device to its risk checks.
*/
function traeBrowserProfileDir(store, region) {
	return join(store.directory(), "trae-browser", region);
}
/** Map one upstream effort name to our id, dropping names we do not know. */
function normalizeEffort(value) {
	return typeof value === "string" ? EFFORT_ALIASES[value.trim()] : void 0;
}
function effortsOf(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value) {
		const id = normalizeEffort(entry);
		if (id !== void 0 && !out.includes(id)) out.push(id);
	}
	return out;
}
/** The `consumption_rate.data.rate` figure, when the row enables it. */
function creditRate(value) {
	const consumption = record(value);
	if (consumption?.enable !== true) return void 0;
	return num(record(consumption.data)?.rate);
}
function contactConfig(value) {
	if (typeof value !== "string" || value === "") return void 0;
	try {
		return record(JSON.parse(value));
	} catch {
		return;
	}
}
/** A field that may arrive as a nested object or as a JSON string. */
function jsonRecord(value) {
	if (typeof value === "string") try {
		return record(JSON.parse(value));
	} catch {
		return;
	}
	return record(value);
}
/**
* Parse the Remote directory.
*
* Groups are walked in {@link TRAE_CHAT_FUNCTIONS} order first so the chat
* attribution prefers the same function the bridge calls, then the IDE-only
* groups fill the union. Duplicate ids keep the stronger capacity row.
*/
function parseTraeRemoteModels(payload) {
	const data = record(record(payload)?.data);
	const groups = Array.isArray(data?.list) ? data.list : [];
	const byId = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Set();
	const add = (groupFunction, models) => {
		if (!Array.isArray(models)) return;
		const chatFunction = groupFunction !== void 0 && TRAE_CHAT_FUNCTIONS.includes(groupFunction) ? groupFunction : void 0;
		const primary = groupFunction !== void 0 && TRAE_PRIMARY_FUNCTIONS.includes(groupFunction);
		for (const raw of models) {
			const model = record(raw);
			const id = text(model?.name);
			if (id === void 0) continue;
			const display = text(model?.display_name);
			const context = record(model?.context_window_tokens);
			const dev = num(context?.dev);
			const max = model?.max_mode === true ? num(context?.max) : void 0;
			const features = jsonRecord(model?.features);
			const efforts = effortsOf(record(model?.reasoning_effort_config)?.options);
			const candidate = {
				id,
				name: display !== void 0 && display !== "-" ? display : id,
				multimodal: model?.multimodal === true,
				primary,
				efforts,
				...dev === void 0 ? {} : { contextWindow: dev },
				...max === void 0 ? {} : { maxContextWindow: max },
				...creditRate(features?.consumption_rate) === void 0 ? {} : { creditMultiplier: creditRate(features?.consumption_rate) },
				...chatFunction === void 0 ? {} : { function: chatFunction }
			};
			const key = id.toLowerCase();
			const existing = byId.get(key);
			if (existing === void 0) {
				byId.set(key, candidate);
				continue;
			}
			const merged = {
				...candidate,
				function: candidate.function ?? existing.function,
				primary: candidate.primary || existing.primary,
				multimodal: candidate.multimodal || existing.multimodal,
				efforts: [.../* @__PURE__ */ new Set([...candidate.efforts, ...existing.efforts])],
				...candidate.creditMultiplier === void 0 && existing.creditMultiplier !== void 0 ? { creditMultiplier: existing.creditMultiplier } : {}
			};
			if ((candidate.maxContextWindow ?? 0) > (existing.maxContextWindow ?? 0) || (candidate.maxContextWindow ?? 0) === (existing.maxContextWindow ?? 0) && (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) byId.set(key, merged);
			else byId.set(key, {
				...existing,
				function: existing.function ?? candidate.function,
				primary: existing.primary || candidate.primary,
				multimodal: existing.multimodal || candidate.multimodal,
				efforts: merged.efforts,
				...existing.creditMultiplier === void 0 && candidate.creditMultiplier !== void 0 ? { creditMultiplier: candidate.creditMultiplier } : {}
			});
		}
	};
	for (const groupFunction of TRAE_DIRECTORY_FUNCTIONS) for (const group of groups) {
		const item = record(group);
		if (item?.function !== groupFunction) continue;
		add(groupFunction, item.models);
		seen.add(groupFunction);
	}
	for (const group of groups) {
		const item = record(group);
		const name = text(item?.function);
		if (name !== void 0 && seen.has(name)) continue;
		add(name, item?.models);
	}
	return [...byId.values()];
}
/** Parse one `get_detail_param` answer into wire rows. */
function parseTraeWireModels(payload, functionName) {
	const root = record(payload);
	const list = Array.isArray(root?.config_info_list) ? root.config_info_list : [];
	const out = [];
	for (const raw of list) {
		const config = record(raw);
		const configName = text(config?.config_name);
		if (configName === void 0) continue;
		const display = record(config?.display_config);
		const detail = record((Array.isArray(config?.model_detail_list) ? config.model_detail_list : [])[0]);
		const context = record(config?.context_window_tokens);
		const rate = creditRate(contactConfig(config?.display_contact_config)?.consumption_rate);
		out.push({
			configName,
			name: text(display?.display_name) ?? configName,
			function: functionName,
			multimodal: display?.multimodal === true,
			usage: text(config?.usage),
			configSource: num(config?.config_source),
			efforts: effortsOf(detail?.reasoning_effort_options ?? config?.reasoning_effort_options),
			...num(detail?.max_tokens) === void 0 ? {} : { maxTokens: num(detail?.max_tokens) },
			...num(detail?.prompt_max_tokens) === void 0 && num(context?.dev) === void 0 ? {} : { contextWindow: num(detail?.prompt_max_tokens) ?? num(context?.dev) },
			...rate === void 0 ? {} : { creditMultiplier: rate }
		});
	}
	return out;
}
/**
* Merge the two sources into the rows DSH sees plus the call metadata.
*
* Only directory rows that the Trae client itself lists in its normal chat
* picker (`solo_work_*`) are candidates, and each must resolve to a wire
* `config_name` because that is the only id the chat endpoint accepts. Rows
* that share a display name collapse to the wider one instead of being
* decorated with their id: the shared naming rule keeps bracket contents as
* labels, so synthesizing `(id)` in the name is not allowed.
*/
function mergeTraeModels(remote, wire, openRouter) {
	const wireById = /* @__PURE__ */ new Map();
	const wireByName = /* @__PURE__ */ new Map();
	for (const model of wire) {
		if (!wireById.has(model.configName.toLowerCase())) wireById.set(model.configName.toLowerCase(), model);
		if (!wireByName.has(model.name.toLowerCase())) wireByName.set(model.name.toLowerCase(), model);
	}
	const candidates = [];
	const usedIds = /* @__PURE__ */ new Set();
	for (const model of remote) {
		if (model.primary !== true) continue;
		if (usedIds.has(model.id.toLowerCase())) continue;
		const wireModel = wireById.get(model.id.toLowerCase()) ?? wireByName.get(model.name.toLowerCase());
		if (wireModel === void 0) continue;
		usedIds.add(model.id.toLowerCase());
		candidates.push({
			id: model.id,
			name: model.name,
			...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
			...model.maxContextWindow === void 0 ? {} : { maxContextWindow: model.maxContextWindow },
			...wireModel.maxTokens === void 0 ? {} : { maxTokens: wireModel.maxTokens },
			...wireModel.creditMultiplier === void 0 && model.creditMultiplier === void 0 ? {} : { creditMultiplier: wireModel.creditMultiplier ?? model.creditMultiplier },
			multimodal: model.multimodal || wireModel.multimodal === true,
			efforts: [.../* @__PURE__ */ new Set([...wireModel.efforts, ...model.efforts])],
			configName: wireModel.configName,
			function: wireModel.function
		});
	}
	const stronger = (left, right) => {
		const leftMax = left.maxContextWindow ?? 0;
		const rightMax = right.maxContextWindow ?? 0;
		if (leftMax !== rightMax) return leftMax > rightMax;
		return (left.contextWindow ?? 0) > (right.contextWindow ?? 0);
	};
	const chosen = /* @__PURE__ */ new Map();
	for (const candidate of candidates) {
		const key = parseModelName(candidate.name).name.toLowerCase() || candidate.id.toLowerCase();
		const existing = chosen.get(key);
		if (existing === void 0 || stronger(candidate, existing)) chosen.set(key, candidate);
	}
	const models = [];
	const meta = /* @__PURE__ */ new Map();
	for (const input of chosen.values()) {
		const parsed = parseModelName(input.name);
		const name = parsed.name.length > 0 ? parsed.name : input.id;
		const live = openRouter?.match(name, input.id);
		const resolved = resolveCapabilities({
			live,
			upstreamEfforts: input.efforts,
			upstreamModalities: input.multimodal ? ALL_INPUT_MODALITIES : ["text"]
		});
		const efforts = resolved.efforts.filter((effort) => WIRE_EFFORTS[effort] !== void 0);
		const labels = [...new Set(parsed.labels)];
		models.push({
			id: input.id,
			name,
			...labels.length === 0 ? {} : { labels },
			contextWindow: input.contextWindow ?? 2e5,
			...input.maxContextWindow === void 0 || input.maxContextWindow <= (input.contextWindow ?? 0) ? {} : { maxContextWindow: input.maxContextWindow },
			...input.maxTokens === void 0 ? {} : { maxTokens: input.maxTokens },
			vision: resolved.modalities.some((mode) => mode.toLowerCase() === "image"),
			reasoning: efforts.length > 0,
			...efforts.length === 0 ? {} : { reasoningEfforts: efforts },
			...resolved.defaultEffort === void 0 ? {} : { defaultReasoningEffort: resolved.defaultEffort },
			...input.creditMultiplier === void 0 ? {} : { priceFactor: input.creditMultiplier }
		});
		meta.set(input.id, {
			configName: input.configName,
			function: input.function ?? "solo_work_lite",
			wireEfforts: Object.fromEntries(efforts.flatMap((effort) => {
				const mapped = WIRE_EFFORTS[effort];
				return mapped === void 0 ? [] : [[effort, mapped]];
			}))
		});
	}
	return {
		models,
		meta
	};
}
/** Trae tool schemas want `parameters` as a JSON string, without boolean `required`. */
function normalizeTraeToolSchema(value) {
	if (Array.isArray(value)) return value.map((entry) => normalizeTraeToolSchema(entry));
	if (value === null || typeof value !== "object") return value;
	const source = value;
	const result = {};
	for (const [key, entry] of Object.entries(source)) {
		if (key === "required" && typeof entry === "boolean") continue;
		result[key] = normalizeTraeToolSchema(entry);
	}
	const properties = record(source.properties);
	if (properties !== void 0) {
		const promoted = /* @__PURE__ */ new Set();
		if (Array.isArray(source.required)) {
			for (const name of source.required) if (typeof name === "string") promoted.add(name);
		}
		for (const [name, property] of Object.entries(properties)) if (record(property)?.required === true) promoted.add(name);
		if (promoted.size > 0) result.required = [...promoted];
	}
	return result;
}
/** Project the harness request onto Trae's message shape. */
function traeMessages(messages) {
	return messages.map((message) => {
		const content = typeof message.content === "string" ? [{
			type: "text",
			text: message.content
		}] : message.content;
		const out = {
			role: message.role,
			content: message.role === "tool" && content.length === 0 ? [{
				type: "text",
				text: ""
			}] : content
		};
		if (message.role === "assistant" && message.tool_calls !== void 0 && message.tool_calls.length > 0) out.tool_calls = message.tool_calls.map((call) => ({
			id: call.id,
			type: "function",
			function_call: {
				name: call.function.name,
				arguments: call.function.arguments
			}
		}));
		if (message.role === "tool" && message.tool_call_id !== void 0) out.tool_call_id = message.tool_call_id;
		return out;
	});
}
function traeTools(tools) {
	if (tools === void 0 || tools.length === 0) return void 0;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: JSON.stringify(normalizeTraeToolSchema(tool.parameters))
		}
	}));
}
/** Trae's named SSE frames, tolerating CRLF and split chunks. */
async function* traeEvents(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parse = (block) => {
		let event;
		const data = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith(":")) continue;
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		if (data.length === 0) return void 0;
		return {
			...event === void 0 ? {} : { event },
			data: data.join("\n")
		};
	};
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let match = /\r?\n\r?\n/.exec(buffer);
			while (match !== null) {
				const block = buffer.slice(0, match.index);
				buffer = buffer.slice(match.index + match[0].length);
				const event = parse(block);
				if (event !== void 0) yield event;
				match = /\r?\n\r?\n/.exec(buffer);
			}
		}
		buffer += decoder.decode();
		const event = parse(buffer);
		if (event !== void 0) yield event;
	} finally {
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
function traeFailure(event) {
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return;
	}
	const root = record(payload);
	const code = typeof root?.code === "number" ? root.code : void 0;
	if (event.event !== "error" && !(code !== void 0 && code >= 4e3)) return void 0;
	return {
		...code === void 0 ? {} : { code },
		message: text(root?.message) ?? ""
	};
}
function failureStatus(code) {
	if (code === 1005 || code === 4222) return 402;
	if (code === 4011 || code === 4008) return 429;
	if (code === 4001 || code === 4023) return 400;
	return 502;
}
function describeFailure(failure) {
	const parts = [failure.code === void 0 ? "Trae 拒绝了这次请求" : TRAE_ERROR_HINTS[failure.code] ?? "Trae 拒绝了这次请求", ...failure.code === void 0 ? [] : [`Trae code ${failure.code}`]];
	if (failure.message !== "") parts.push(`上游：${failure.message}`);
	return parts.join(" · ");
}
/** Convert Trae's stream into harness chunks. */
async function* openTraeStream(body, model) {
	let nextIndex = 0;
	let current;
	const tools = /* @__PURE__ */ new Map();
	let usage;
	let finish;
	let sawContent = false;
	let sawDone = false;
	const start = (kind) => {
		current = {
			kind,
			index: nextIndex++,
			text: ""
		};
		return {
			type: "block-start",
			index: current.index,
			blockType: kind
		};
	};
	const close = () => {
		if (current === void 0) return void 0;
		const block = current.kind === "text" ? {
			type: "text",
			text: current.text
		} : {
			type: "reasoning",
			text: current.text
		};
		const chunk = {
			type: "block-end",
			index: current.index,
			block
		};
		current = void 0;
		return chunk;
	};
	for await (const event of traeEvents(body)) {
		if (event.data.trim() === "[DONE]") {
			sawDone = true;
			break;
		}
		const failure = traeFailure(event);
		if (failure !== void 0) throw new ProviderHttpError(describeFailure(failure), failureStatus(failure.code));
		let payload;
		try {
			payload = JSON.parse(event.data);
		} catch {
			continue;
		}
		const root = record(payload);
		if (root === void 0) continue;
		if (event.event === "token_usage") {
			const prompt = num(root.prompt_tokens);
			const completion = num(root.completion_tokens);
			const cacheRead = num(root.cache_read_input_tokens) ?? 0;
			const reasoning = num(root.reasoning_tokens) ?? 0;
			if (prompt !== void 0 || completion !== void 0) {
				const input = Math.max(0, (prompt ?? 0) - cacheRead);
				const output = completion ?? 0;
				usage = {
					type: "usage",
					usage: {
						inputTokens: input,
						outputTokens: output,
						totalTokens: num(root.total_tokens) ?? input + cacheRead + output,
						...cacheRead === 0 ? {} : { cacheReadTokens: cacheRead },
						...reasoning === 0 ? {} : { reasoningTokens: reasoning }
					}
				};
			}
			continue;
		}
		if (event.event === "done" || root.finish_reason !== void 0 && root.response === void 0) {
			sawDone = true;
			if (typeof root.finish_reason === "string") finish = root.finish_reason;
			continue;
		}
		const reasoning = text(root.reasoning_content);
		if (reasoning !== void 0) {
			if (current?.kind !== "reasoning") {
				const ended = close();
				if (ended !== void 0) yield ended;
				yield start("reasoning");
			}
			current.text += reasoning;
			sawContent = true;
			yield {
				type: "reasoning-delta",
				index: current.index,
				text: reasoning
			};
		}
		const response = text(root.response);
		if (response !== void 0) {
			if (current?.kind !== "text") {
				const ended = close();
				if (ended !== void 0) yield ended;
				yield start("text");
			}
			current.text += response;
			sawContent = true;
			yield {
				type: "text-delta",
				index: current.index,
				text: response
			};
		}
		if (Array.isArray(root.tool_calls)) for (const [position, raw] of root.tool_calls.entries()) {
			const call = record(raw);
			if (call === void 0) continue;
			const index = typeof call.index === "number" ? call.index : position;
			const held = tools.get(index) ?? { arguments: "" };
			const fn = record(call.function_call) ?? record(call.function);
			const id = typeof call.id === "string" ? call.id.trim() : "";
			if (id !== "") held.id = id;
			const name = typeof fn?.name === "string" ? fn.name : "";
			if (name !== "") held.name = (held.name ?? "") + name;
			const args = fn?.arguments;
			if (typeof args === "string") held.arguments += args;
			else if (args !== void 0) held.arguments += JSON.stringify(args);
			tools.set(index, held);
			sawContent = true;
		}
	}
	const ended = close();
	if (ended !== void 0) yield ended;
	let toolCalls = 0;
	const usedIds = /* @__PURE__ */ new Set();
	for (const [, tool] of [...tools.entries()].sort((left, right) => left[0] - right[0])) {
		const fallback = () => `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
		const preferred = tool.id?.trim() ?? "";
		let callId = preferred !== "" ? preferred : fallback();
		while (usedIds.has(callId)) callId = fallback();
		usedIds.add(callId);
		const branded = callId;
		const name = tool.name ?? "unknown_tool";
		const args = tool.arguments === "" ? "{}" : tool.arguments;
		const blockIndex = nextIndex++;
		yield {
			type: "block-start",
			index: blockIndex,
			blockType: "tool-call"
		};
		yield {
			type: "tool-call-delta",
			index: blockIndex,
			id: branded,
			name,
			argumentsDelta: args
		};
		yield {
			type: "block-end",
			index: blockIndex,
			block: {
				type: "tool-call",
				id: branded,
				name,
				arguments: args
			}
		};
		toolCalls++;
	}
	if (usage !== void 0) yield usage;
	yield {
		type: "finish",
		reason: { kind: sawContent || sawDone ? finish === "length" || finish === "max_tokens" ? "max-tokens" : finish === "tool_calls" || finish === "function_call" ? "tool-calls" : toolCalls > 0 ? "tool-calls" : "stop" : "max-tokens" }
	};
}
/** CN entitlement document → the card's quota shape. */
function parseTraeUsage(payload) {
	const root = record(payload) ?? {};
	const data = record(root.data) ?? root;
	const summary = record(data.usage_summary) ?? {};
	const total = num(summary.total_amount);
	const used = num(summary.consumed_amount);
	const rawRatio = num(summary.consumption_ratio);
	const ratio = rawRatio === void 0 ? void 0 : rawRatio <= 1 ? rawRatio * 100 : rawRatio;
	const packs = [];
	const list = Array.isArray(data.user_entitlement_pack_list) ? data.user_entitlement_pack_list : [];
	for (const raw of list) {
		const pack = record(raw);
		if (pack === void 0) continue;
		const base = record(pack.entitlement_base_info) ?? {};
		const quota = record(base.quota);
		const limit = num(record(record(record(base.product_extra)?.package_extra)?.quota)?.credits_limit) ?? num(quota?.credits_limit);
		const consumed = num(record(pack.usage)?.credits_amount);
		const end = epochMs(num(base.end_time));
		packs.push({
			label: text(pack.display_desc) ?? "额度包",
			...limit === void 0 ? {} : { total: limit },
			...consumed === void 0 ? {} : { used: consumed },
			...end === void 0 ? {} : { expiresAt: end }
		});
	}
	packs.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER));
	return {
		...total === void 0 ? {} : { total },
		...used === void 0 ? {} : { used },
		...ratio === void 0 ? {} : { ratio },
		...packs.length === 0 ? {} : { packs },
		at: Date.now()
	};
}
/**
* International entitlement document → the card's quota shape.
*
* The website's "Dollar Usage" panel reads `web_user_ent_usage`, not
* `ide_user_pay_status`: the latter carries the plan name but no amounts. On a
* dollar-billing account `basic_usage_limit` is the monthly allowance (1.00 on
* the free plan) and `basic_usage_amount` is the spend, so those numbers are
* dollars and must not be printed as credits.
*/
function parseTraeGlobalUsage(payload) {
	const root = record(payload) ?? {};
	const trial = record(root.trial_status);
	const inTrial = trial?.is_in_trial === true;
	const entries = (Array.isArray(root.user_entitlement_pack_list) ? root.user_entitlement_pack_list : []).map(record).filter((entry) => entry !== void 0 && entry.is_hide !== true);
	const primary = entries.find((entry) => {
		return record(record(record(entry.entitlement_base_info)?.product_extra)?.subscription_extra) !== void 0;
	}) ?? entries[0];
	const base = record(primary?.entitlement_base_info) ?? {};
	const quota = record(record(record(base.product_extra)?.subscription_extra)?.quota) ?? record(base.quota) ?? {};
	const usage = record(primary?.usage) ?? {};
	const dollar = root.is_dollar_usage_billing === true;
	const total = dollar ? num(quota.basic_usage_limit) : num(quota.credits_limit);
	const used = dollar ? num(usage.basic_usage_amount) : num(usage.credits_amount);
	const resetAtRaw = epochMs(num(base.end_time));
	const resetAt = resetAtRaw === void 0 ? void 0 : resetAtRaw + 1e3;
	const trialEnd = epochMs(num(trial?.trial_end_time) ?? num(root.trial_end_time));
	return {
		plan: text(primary?.display_desc) ?? (inTrial ? "试用" : "免费"),
		...dollar ? { unit: "usd" } : {},
		...total === void 0 ? {} : { total },
		...used === void 0 ? {} : { used },
		...resetAt === void 0 ? {} : { resetAt },
		...trialEnd === void 0 ? {} : { trialEndsAt: trialEnd },
		at: Date.now()
	};
}
function parseTraeCheckin(payload) {
	const root = record(payload) ?? {};
	const reward = num(root.credits) ?? 0;
	return {
		available: root.enable !== false,
		claimed: root.checked_in === true,
		deviceClaimed: root.did_checked_in === true,
		...reward === 0 ? {} : { reward },
		...text(root.message) === void 0 ? {} : { message: text(root.message) }
	};
}
var TraeProvider = class {
	options;
	catalogInstance;
	catalogRegion;
	meta = /* @__PURE__ */ new Map();
	quotaCache;
	quotaInflight;
	quotaInflightRegion;
	loginFlow;
	fetchImpl;
	openRouter;
	constructor(options) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.openRouter = options.openRouter ?? new OpenRouterCatalog(this.fetchImpl);
		this.catalogRegion = options.region();
		this.catalogInstance = new ModelCatalog(() => this.fetchCatalog(), options.ttlMs);
	}
	/** The catalog the currently selected region sees. */
	get catalog() {
		return this.catalogInstance;
	}
	/**
	* Keep every cache on the selected region.
	*
	* The two deployments share no model ids, config names or quota, so a switch
	* swaps the catalog instance (which also orphans any fetch still in flight for
	* the previous region) and drops the quota reading.
	*/
	ensureRegion() {
		const region = this.options.region();
		if (this.catalogRegion === region) return region;
		this.catalogRegion = region;
		this.catalogInstance = new ModelCatalog(() => this.fetchCatalog(), this.options.ttlMs);
		this.meta = /* @__PURE__ */ new Map();
		this.quotaCache = void 0;
		this.quotaInflight = void 0;
		this.quotaInflightRegion = void 0;
		return region;
	}
	profile() {
		return TRAE_REGION_PROFILES[this.options.region()];
	}
	async status() {
		return {
			...await this.options.auth.status(),
			region: this.options.region()
		};
	}
	async signedIn() {
		return (await this.options.auth.status()).signedIn;
	}
	async models(fresh = false) {
		this.ensureRegion();
		return this.catalogInstance.models(fresh);
	}
	catalogError() {
		return this.catalogInstance.error();
	}
	invalidateModels() {
		this.catalogInstance.invalidate();
	}
	invalidateQuota() {
		this.quotaCache = void 0;
		this.quotaInflight = void 0;
		this.quotaInflightRegion = void 0;
	}
	headers(token, profile) {
		return {
			authorization: `Cloud-IDE-JWT ${token}`,
			"content-type": "application/json",
			accept: "application/json",
			"x-trae-client-type": "web",
			"x-app-id": TRAE_APP_ID,
			"x-app-version-code": TRAE_VERSION_CODE,
			"x-ide-version-code": TRAE_VERSION_CODE,
			"x-ide-version-type": "stable",
			"x-trae-user-timezone": profile.timezone,
			"x-preferenced-language": profile.language,
			referer: `${profile.webOrigin}/`,
			"user-agent": TRAE_WEB_USER_AGENT
		};
	}
	chatHeaders(token, identity, profile) {
		const trace = randomUUID().replaceAll("-", "");
		return {
			...this.headers(token, profile),
			accept: "text/event-stream",
			"x-ide-token": token,
			"x-cloudide-token": token,
			"x-device-id": identity.deviceId,
			"x-machine-id": identity.machineId,
			...identity.userId === void 0 ? {} : { "x-uid": identity.userId },
			"x-custom-trace-id": trace,
			"x-flow-traceparent": `04-${trace}-${trace.slice(0, 16)}-01`,
			"request-traffic-type": "prod"
		};
	}
	async fetchRemote(profile, token) {
		const bases = [profile.remoteBase, `${profile.chatBase}/api/remote/v1`].filter((base, index, all) => all.indexOf(base) === index);
		let lastError;
		for (const base of bases) try {
			const response = await this.fetchImpl(`${base}/models?functions=${TRAE_DIRECTORY_FUNCTIONS.join(",")}`, {
				headers: this.headers(token, profile),
				signal: AbortSignal.timeout(this.options.timeoutMs())
			});
			if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status);
			const models = parseTraeRemoteModels(await response.json());
			if (models.length > 0) return models;
			lastError = /* @__PURE__ */ new Error("Trae 模型目录没有返回任何模型");
		} catch (error) {
			lastError = error;
		}
		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
	async fetchWire(profile, token, identity) {
		const out = [];
		for (const functionName of TRAE_CHAT_FUNCTIONS) try {
			const response = await this.fetchImpl(`${profile.chatBase}${TRAE_SOLO_MODELS_PATH}`, {
				method: "POST",
				headers: {
					...this.chatHeaders(token, identity, profile),
					accept: "application/json"
				},
				body: JSON.stringify({
					function: functionName,
					config_names: null,
					need_prompt: false,
					current_config_info: null,
					poly_prompt: true,
					mode_type: null,
					agent_type: null
				}),
				signal: AbortSignal.timeout(this.options.timeoutMs())
			});
			if (!response.ok) continue;
			out.push(...parseTraeWireModels(await response.json(), functionName));
		} catch {}
		return out;
	}
	async fetchCatalog() {
		const region = this.options.region();
		const token = await this.options.auth.accessToken();
		const identity = await this.options.auth.identity();
		const profile = this.profile();
		const openRouter = this.openRouter.models().catch(() => void 0);
		let remote = [];
		let remoteError;
		try {
			remote = await this.fetchRemote(profile, token);
		} catch (error) {
			remoteError = error;
		}
		const wire = await this.fetchWire(profile, token, identity);
		if (remote.length === 0 && wire.length === 0) throw remoteError instanceof Error ? remoteError : /* @__PURE__ */ new Error("Trae 没有返回任何模型");
		const catalog = mergeTraeModels(remote, wire, await openRouter);
		if (catalog.models.length === 0) throw new Error("Trae 目录里没有可调用的模型；请稍后刷新，或重新登录后再试。");
		if (this.options.region() === region) this.meta = catalog.meta;
		const textOnly = this.options.textOnly();
		const forceVision = this.options.forceVision();
		return catalog.models.map((model) => ({
			...model,
			vision: textOnly.has(model.id) ? false : forceVision.has(model.id) ? true : model.vision
		}));
	}
	async quota(fresh = false) {
		const region = this.ensureRegion();
		if (!fresh && this.quotaCache !== void 0 && this.quotaCache.region === region && Date.now() - this.quotaCache.at < 6e4) return this.quotaCache.value;
		if (this.quotaInflight !== void 0 && this.quotaInflightRegion === region) return this.quotaInflight;
		this.quotaInflight = (async () => {
			try {
				const profile = this.profile();
				const token = await this.options.auth.accessToken();
				const identity = await this.options.auth.identity();
				const path = profile.checkin ? "/trae/api/v2/pay/web_user_ent_usage" : "/trae/api/v1/pay/web_user_ent_usage";
				const response = await this.fetchImpl(`${profile.payBase}${path}`, {
					method: "POST",
					headers: {
						...this.headers(token, profile),
						"x-device-id": identity.deviceId,
						"x-machine-id": identity.machineId
					},
					body: JSON.stringify({ require_usage: true }),
					signal: AbortSignal.timeout(this.options.timeoutMs())
				});
				if (!response.ok) {
					if (response.status === 401 || response.status === 403) await this.options.auth.accessToken(true);
					throw new ProviderHttpError(await responseError(response), response.status);
				}
				const payload = await response.json();
				const value = profile.checkin ? parseTraeUsage(payload) : parseTraeGlobalUsage(payload);
				this.quotaCache = {
					at: Date.now(),
					region,
					value
				};
				return value;
			} finally {
				this.quotaInflight = void 0;
				this.quotaInflightRegion = void 0;
			}
		})();
		this.quotaInflightRegion = region;
		return this.quotaInflight;
	}
	async checkinStatus() {
		this.ensureRegion();
		const profile = this.profile();
		if (!profile.checkin) return {
			available: false,
			claimed: false,
			deviceClaimed: false
		};
		const token = await this.options.auth.accessToken();
		const identity = await this.options.auth.identity();
		const response = await this.fetchImpl(`${profile.apiBase}/trae/api/v2/ug/checkin_credits/status`, {
			method: "POST",
			headers: {
				...this.headers(token, profile),
				"x-device-id": checkinDeviceId(identity.deviceId),
				"x-machine-id": identity.machineId
			},
			body: "{}",
			signal: AbortSignal.timeout(this.options.timeoutMs())
		});
		if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status);
		return parseTraeCheckin(await response.json());
	}
	/** Claim today's reward. The only state-changing call in this provider. */
	async claimCheckin() {
		this.ensureRegion();
		const profile = this.profile();
		if (!profile.checkin) throw new Error("Trae 国际版没有签到活动");
		const token = await this.options.auth.accessToken();
		const identity = await this.options.auth.identity();
		const response = await this.fetchImpl(`${profile.apiBase}/trae/api/v2/ug/checkin_credits/claim`, {
			method: "POST",
			headers: {
				...this.headers(token, profile),
				"x-device-id": checkinDeviceId(identity.deviceId),
				"x-machine-id": identity.machineId
			},
			body: "{}",
			signal: AbortSignal.timeout(this.options.timeoutMs())
		});
		if (!response.ok) throw new ProviderHttpError(await responseError(response), response.status);
		const payload = record(await response.json()) ?? {};
		const code = typeof payload.code === "number" ? payload.code : 0;
		if (code === 0) {
			this.invalidateQuota();
			return {
				available: true,
				claimed: true,
				deviceClaimed: false
			};
		}
		if (code === 9095) return {
			available: true,
			claimed: false,
			deviceClaimed: true,
			message: "本机今日已签到"
		};
		throw new Error(text(payload.message) ?? `签到失败（code ${code}）`);
	}
	async *stream(options, model, readImage, onInvalidate) {
		this.ensureRegion();
		const profile = this.profile();
		const token = await this.options.auth.accessToken();
		const identity = await this.options.auth.identity();
		await this.models();
		const meta = this.meta.get(model);
		if (meta === void 0) throw new ProviderHttpError(`Trae 未在当前账号的可调用模型里找到「${model}」。它可能只存在于 Trae 客户端通道；请在模型菜单里换一个模型。`, 400);
		const messages = await buildMessages(options, readImage);
		const effort = options.reasoningEffort === void 0 ? void 0 : meta.wireEfforts[options.reasoningEffort];
		const tools = traeTools(options.tools);
		const body = {
			messages: traeMessages(messages),
			model: meta.configName,
			config_name: meta.configName,
			function: meta.function,
			stream: true,
			...options.maxTokens === void 0 ? {} : { max_tokens: Math.max(1, Math.floor(options.maxTokens)) },
			...tools === void 0 ? {} : { tools },
			...effort === void 0 ? {} : { reasoning_effort: effort }
		};
		try {
			const response = await this.fetchImpl(`${profile.chatBase}${TRAE_SOLO_CHAT_PATH}`, {
				method: "POST",
				headers: this.chatHeaders(token, identity, profile),
				body: JSON.stringify(body),
				signal: options.signal ?? AbortSignal.timeout(12e4)
			});
			if (!response.ok) {
				if (response.status === 401 || response.status === 403) await this.options.auth.accessToken(true);
				throw new ProviderHttpError(await responseError(response), response.status);
			}
			if (response.body === null) throw new ProviderHttpError("Trae 没有返回响应体", 502);
			yield* openTraeStream(response.body, model);
		} finally {
			onInvalidate();
		}
	}
	async startBrowserLogin(region) {
		const running = this.loginFlow?.status();
		if (running?.running === true) return running;
		const target = region ?? this.options.region();
		const flow = new TraeWebLogin({
			region: target,
			profileDir: traeBrowserProfileDir(this.options.store, target),
			...this.options.loginTimeoutMs === void 0 ? {} : { timeoutMs: this.options.loginTimeoutMs },
			...this.options.logger === void 0 ? {} : { logger: this.options.logger },
			save: async (account) => {
				await this.options.store.saveTrae({
					accessToken: account.accessToken,
					region: target,
					deviceId: account.deviceId,
					machineId: account.machineId,
					loginAt: Date.now(),
					...account.userId === void 0 ? {} : { userId: account.userId },
					...account.name === void 0 ? {} : { name: account.name },
					...account.expiresAt === void 0 ? {} : { expiresAt: account.expiresAt },
					...account.cookies === void 0 ? {} : { cookies: account.cookies },
					...account.sessionExpiresAt === void 0 ? {} : { sessionExpiresAt: account.sessionExpiresAt }
				});
				this.invalidateModels();
				this.invalidateQuota();
			}
		});
		this.loginFlow = flow;
		return flow.start();
	}
	browserLoginStatus() {
		return this.loginFlow?.status() ?? {
			running: false,
			phase: "idle"
		};
	}
	async cancelBrowserLogin() {
		await this.loginFlow?.cancel();
	}
	async logoutAccount() {
		const region = this.options.region();
		await this.loginFlow?.cancel();
		await this.options.auth.logout();
		this.invalidateModels();
		this.invalidateQuota();
		try {
			rmSync(traeBrowserProfileDir(this.options.store, region), {
				recursive: true,
				force: true,
				maxRetries: 3,
				retryDelay: 100
			});
		} catch {}
	}
	close() {
		this.loginFlow?.close();
	}
};
// src/index.ts
const name = "llm-adapters";
const inject = ["llm"];
const NS = "llm-adapters";
const REQUEST_IMAGE_MAX_BYTES = 1048576;
const STRUCTURAL_FIELDS = /* @__PURE__ */ new Set([
	"loomyEnabled",
	"raccoonEnabled",
	"traeEnabled",
	"codeartsEnabled",
	"loomyDisplayName",
	"raccoonDisplayName",
	"traeDisplayName",
	"codeartsDisplayName"
]);
const Config = Config$1;
function apply(ctx, config) {
	const live = liveConfig(config);
	let attachments;
	let filesystem;
	/**
	* Where the model can find the image on disk.
	*
	* Pixels let it describe the picture; this path lets a "modify and save it"
	* turn act on the file instead of searching the workspace for something that
	* was never there. The mounted tools may see a different path than the host
	* (a sandbox), so the filesystem provider gets the last word.
	*/
	const imagePath = (ref) => {
		const store = attachments;
		if (store === void 0) return void 0;
		const hostPath = store.imageHostPath(ref);
		if (hostPath === void 0) return void 0;
		return filesystem?.processPathFromHostPath?.(hostPath) ?? hostPath;
	};
	const readImage = async (ref, signal) => {
		const store = attachments;
		if (store === void 0) return void 0;
		const image = await store.readImageRequest(ref, {
			width: ref.width,
			height: ref.height,
			maxBytes: REQUEST_IMAGE_MAX_BYTES
		}, signal);
		const path = imagePath(ref);
		return {
			data: image.data,
			mediaType: image.mediaType,
			...path === void 0 ? {} : { path }
		};
	};
	const accounts = new AccountStore();
	const openRouter = new OpenRouterCatalog(fetch, { cacheFile: join(accounts.directory(), "openrouter-models.json") });
	const loomyAuth = new LoomyAuth(accounts);
	const raccoonAuth = new RaccoonAuth(accounts);
	const traeAuth = new TraeAuth(accounts, () => live.traeRegion());
	const codeartsAuth = new CodeArtsAuth(accounts);
	const loomyProvider = new LoomyProvider({
		auth: loomyAuth,
		store: accounts,
		ttlMs: live.modelCacheTtlMs,
		timeoutMs: live.catalogFetchTimeoutMs,
		textOnly: () => new Set(live.loomyTextOnlyModelIds()),
		forceVision: () => new Set(live.loomyVisionModelIds()),
		openRouter
	});
	const raccoonProvider = new RaccoonProvider({
		auth: raccoonAuth,
		store: accounts,
		ttlMs: live.modelCacheTtlMs,
		timeoutMs: live.catalogFetchTimeoutMs,
		textOnly: () => new Set(live.raccoonTextOnlyModelIds()),
		forceVision: () => new Set(live.raccoonVisionModelIds()),
		openRouter
	});
	const traeProvider = new TraeProvider({
		auth: traeAuth,
		store: accounts,
		region: () => live.traeRegion(),
		ttlMs: live.modelCacheTtlMs,
		timeoutMs: live.catalogFetchTimeoutMs,
		textOnly: () => new Set(live.traeTextOnlyModelIds()),
		forceVision: () => new Set(live.traeVisionModelIds()),
		openRouter,
		logger: (message) => ctx.logger?.warn(message)
	});
	const codeartsProvider = new CodeArtsProvider({
		auth: codeartsAuth,
		store: accounts,
		ttlMs: live.modelCacheTtlMs,
		timeoutMs: live.catalogFetchTimeoutMs,
		textOnly: () => new Set(live.codeartsTextOnlyModelIds()),
		forceVision: () => new Set(live.codeartsVisionModelIds()),
		openRouter,
		logger: (message) => ctx.logger?.warn(message)
	});
	const brandChoices = {
		loomy: {
			displayName: live.loomyDisplayName,
			disabledModels: live.loomyDisabledModels,
			modelContextWindows: live.loomyModelContextWindows,
			modelAliases: live.loomyModelAliases
		},
		raccoon: {
			displayName: live.raccoonDisplayName,
			disabledModels: live.raccoonDisabledModels,
			modelContextWindows: live.raccoonModelContextWindows,
			modelAliases: live.raccoonModelAliases
		},
		trae: {
			displayName: live.traeDisplayName,
			disabledModels: live.traeDisabledModels,
			modelContextWindows: live.traeModelContextWindows,
			modelAliases: live.traeModelAliases
		},
		codearts: {
			displayName: live.codeartsDisplayName,
			disabledModels: live.codeartsDisabledModels,
			modelContextWindows: live.codeartsModelContextWindows,
			modelAliases: live.codeartsModelAliases
		}
	};
	const makeOptions = (brand, provider) => ({
		brand,
		provider,
		...brandChoices[brand],
		defaultMaxTokens: live.defaultMaxTokens,
		readImage
	});
	const adapters = {
		loomy: new LoomyAdapter(makeOptions("loomy", LOOMY_PROVIDER), loomyProvider),
		raccoon: new RaccoonAdapter(makeOptions("raccoon", RACCOON_PROVIDER), raccoonProvider),
		trae: new TraeAdapter(makeOptions("trae", TRAE_PROVIDER), traeProvider),
		codearts: new CodeArtsAdapter(makeOptions("codearts", CODEARTS_PROVIDER), codeartsProvider)
	};
	const syncOpenRouter = () => {
		const minutes = live.openRouterSyncMinutes();
		if (minutes <= 0) return;
		const status = openRouter.status();
		if (status.syncing) return;
		if (status.at !== void 0 && Date.now() - status.at < minutes * 6e4) return;
		openRouter.sync().then((result) => {
			if (!result.ok) ctx.logger?.warn(`llm-adapters: OpenRouter 同步失败：${result.error ?? "未知错误"}`);
		});
	};
	const syncTimer = setInterval(syncOpenRouter, 3e4);
	syncTimer.unref?.();
	ctx.effect(() => () => clearInterval(syncTimer), "llm-adapters: openrouter sync");
	let lastRaccoonCheckin = Date.now();
	const checkinMonitor = () => {
		if (!live.raccoonEnabled()) return;
		const minutes = live.raccoonCheckinMinutes();
		if (minutes <= 0) return;
		if (Date.now() - lastRaccoonCheckin < minutes * 6e4) return;
		lastRaccoonCheckin = Date.now();
		(async () => {
			if (!await raccoonProvider.signedIn()) return;
			await raccoonProvider.ensureDailyCheckin();
		})().catch((error) => {
			ctx.logger?.warn(`llm-adapters: 小浣熊签到监测失败：${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const checkinTimer = setInterval(checkinMonitor, 6e4);
	checkinTimer.unref?.();
	ctx.effect(() => () => clearInterval(checkinTimer), "llm-adapters: raccoon check-in monitor");
	ctx.inject(["attachments"], (scope) => {
		attachments = scope.attachments;
		scope.effect(() => () => {
			attachments = void 0;
		}, "llm-adapters.attachments");
	});
	ctx.inject(["fs"], (scope) => {
		filesystem = scope.fs;
		scope.effect(() => () => {
			filesystem = void 0;
		}, "llm-adapters.fs");
	});
	const routes = {};
	let directory;
	const enabled = (id) => id === "loomy" ? live.loomyEnabled() : id === "raccoon" ? live.raccoonEnabled() : id === "trae" ? live.traeEnabled() : live.codeartsEnabled();
	const directoryFor = () => BRANDS.filter((brand) => enabled(brand.id)).map((brand) => ({
		provider: brand.provider,
		displayName: brandChoices[brand.id].displayName(),
		settingsNs: NS,
		settingsPath: []
	}));
	const syncRegistration = () => {
		for (const brand of BRANDS) {
			const current = routes[brand.id];
			if (enabled(brand.id) && current === void 0) routes[brand.id] = ctx.llm.registerAdapter([brand.provider], adapters[brand.id]);
			else if (!enabled(brand.id) && current !== void 0) {
				current();
				delete routes[brand.id];
			}
		}
		const entries = directoryFor();
		if (entries.length === 0) {
			directory?.();
			directory = void 0;
		} else if (directory === void 0) directory = ctx.llm.registerConfigurableProviders(entries);
		else directory.replace(entries);
	};
	syncRegistration();
	ctx.on("loader/volatile-update", (paths) => {
		if (!paths.some((path) => STRUCTURAL_FIELDS.has(String(path[0])))) return;
		try {
			syncRegistration();
		} catch (error) {
			ctx.logger?.warn(`llm-adapters: 重新发布模型分组失败：${String(error)}`);
		}
	});
	ctx.effect(() => () => {
		adapters.loomy.close();
		adapters.raccoon.close();
		adapters.trae.close();
		adapters.codearts.close();
	}, "llm-adapters.dispose");
	ctx.inject(["webServer"], (scope) => {
		const server = scope.webServer;
		if (server === void 0) return;
		scope.effect(() => server.register({
			kind: "prefix",
			path: API_PREFIX,
			handler: (req, res) => {
				handleApi(req, res, adapters, openRouter);
			}
		}), "llm-adapters: settings api");
		ctx.logger?.info(`llm-adapters: 设置接口已挂载于 ${API_PREFIX}`);
	});
}
export { API_PREFIX, AccountStore, BRANDS, CODEARTS_BENEFIT_FALLBACK, CODEARTS_BRAND, CODEARTS_CHAT_URL, CODEARTS_CONTEXT_WINDOWS, CODEARTS_DEFAULT_EFFORT, CODEARTS_EFFORTS, CODEARTS_EFFORT_LEVELS, CODEARTS_FALLBACK_CONTEXT_WINDOW, CODEARTS_MAX_OUTPUT_TOKENS, CODEARTS_PROVIDER, CODEARTS_SESSION_LIMIT, CODEARTS_SESSION_WINDOW_MS, CODEARTS_SNAP_BASE, CODEARTS_VISION_MODELS, CodeArtsAdapter, CodeArtsAuth, CodeArtsLogin, CodeArtsProvider, CodeArtsSessionWindow, Config, EMPTY_OPENROUTER_INDEX, LOOMY_ACCOUNT_BASE, LOOMY_BASE, LOOMY_BRAND, LOOMY_PROVIDER, LOOMY_VERSION, LOOMY_WECHAT_APP_ID, LOOMY_WECHAT_REDIRECT_URI, LocalAdapter, LoomyAdapter, LoomyAuth, LoomyProvider, LoomyQrLogin, ModelCatalog, OpenRouterCatalog, ProviderHttpError, RACCOON_BASE, RACCOON_BRAND, RACCOON_CLIENT_VERSION, RACCOON_IAM_BASE, RACCOON_PROVIDER, RACCOON_QR_APP_NAME, RACCOON_QR_ORIGIN, RaccoonAdapter, RaccoonAuth, RaccoonIamError, RaccoonProvider, RaccoonQrLogin, RefreshTokenExpiredError, TRAE_APP_ID, TRAE_BRAND, TRAE_CHAT_FUNCTIONS, TRAE_DIRECTORY_FUNCTIONS, TRAE_PROVIDER, TRAE_REGION_PROFILES, TRAE_SOLO_CHAT_PATH, TRAE_WEB_USER_AGENT, TraeAdapter, TraeAuth, TraeProvider, TraeWebLogin, apply, buildAuthorizeUrl, buildLoomyWechatAuthUrl, buildMessages, buildOpenRouterIndex, buildQrMatrix, buildRows, buildTools, checkinDeviceId, clampMaxTokens, codeartsContextWindow, codeartsEfforts, consumeOpenAiStream, createRaccoonQr, decodeJwtFacts, defaultEffortOf, effortLabel, exchangeAuthorizationCode, exchangeRefreshToken, extractWechatUuid, fetchLoomyWechatUuid, generateDpopKeyPair, generatePkcePair, headersForFetch, inject, isBrandId, liveConfig, loomyGatewaySessionValid, machineIdOf, mergeTraeModels, modelKey, name, normalizeCodeArtsModelId, normalizeEffort, normalizeTraeRegion, openAiStream, openTraeStream, parseCodeArtsPackage, parseCodeArtsRoster, parseLoomyCatalog, parseModelName, parseOpenRouterModels, parseRaccoonCatalog, parseTraeCheckin, parseTraeGlobalUsage, parseTraeRemoteModels, parseTraeUsage, parseTraeWireModels, pickActiveCredit, pollRaccoonQr, priceFactorOf, priceFactorOfLabel, raccoonAccessTokenValid, raccoonQrContent, raccoonRefreshCandidate, readJwtExpiry, renderQrSvg, resolveCapabilities, resolveConfig, resolveModelId, sharedSessionWindow, signDpopJws, signRequestHuawei, sseEvents, startLoginPage, traeMessages, traeTools };
