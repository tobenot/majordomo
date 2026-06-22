import { PersonaEngine, PersonaInput } from "./types";
import { createLogger } from "../core/logger";

const log = createLogger("persona:api");

type PersonaApiFormat = "openai" | "anthropic";

function parseApiFormat(value: string | undefined): PersonaApiFormat {
  const raw = value?.trim().toLowerCase();
  if (!raw || raw === "openai") return "openai";
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  log.warn(`未知 PERSONA_API_FORMAT=${raw}，按 openai 处理`);
  return "openai";
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export class ApiPersona implements PersonaEngine {
  readonly mode = "api";

  constructor(
    private personaName: string,
    private style: string,
    private apiKey: string,
    private apiBase: string,
    private model: string,
    readonly apiFormat: PersonaApiFormat,
    private projectInstructions?: string,
  ) {}

  static fromEnv(personaName: string, style: string, projectInstructions?: string): ApiPersona | null {
    const apiKey = process.env.PERSONA_API_KEY?.trim();
    const model = process.env.PERSONA_MODEL?.trim();
    const apiFormat = parseApiFormat(process.env.PERSONA_API_FORMAT);
    const apiBase = process.env.PERSONA_API_BASE?.trim() || (apiFormat === "anthropic" ? "https://api.anthropic.com" : "");
    if (!apiKey || !apiBase || !model) return null;
    return new ApiPersona(personaName, style, apiKey, apiBase, model, apiFormat, projectInstructions);
  }

  private systemPrompt(): string {
    const styleHint =
      this.style === "cat-girl-maid"
        ? "你是一只猫娘女仆人设的 AI 助手，称呼对方为「主人」，自称「本喵」或「咱」，适当用喵语和颜文字，语气甜软体贴。"
        : "你用自然、亲切的口吻汇报。";
    const parts = [
      `你是「${this.personaName}」，一个 Claude Code 多会话调度器的人设层。`,
      styleHint,
      "你的任务：读工作层（另一个 AI）刚刚干完活的原始输出，用一两句人话向主人汇报关键结果。",
      "要点：简短、说清楚做了什么和当前状态、有无需要主人注意的地方。不要复述全部细节。",
    ];
    if (this.projectInstructions) {
      parts.push(`\n## 项目专属指令\n${this.projectInstructions}`);
    }
    return parts.join("\n");
  }

  private userPrompt(input: PersonaInput): string {
    return `主人的指令：${input.userText}\n\n工作层的原始输出：\n${input.workerText}\n\n请用人设口吻汇报。`;
  }

  private baseUrl(): string {
    return this.apiBase.replace(/\/+$/, "");
  }

  private anthropicMessagesUrl(): string {
    const base = this.baseUrl();
    return base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  }

  private async reportOpenAi(input: PersonaInput, signal: AbortSignal): Promise<string> {
    const resp = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt() },
          { role: "user", content: this.userPrompt(input) },
        ],
        temperature: 0.7,
        max_tokens: 400,
      }),
      signal,
    });
    return this.parseResponse(resp, (data) => textFromContent(data?.choices?.[0]?.message?.content));
  }

  private async reportAnthropic(input: PersonaInput, signal: AbortSignal): Promise<string> {
    const resp = await fetch(this.anthropicMessagesUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        system: this.systemPrompt(),
        messages: [{ role: "user", content: this.userPrompt(input) }],
        temperature: 0.7,
        max_tokens: 400,
      }),
      signal,
    });
    return this.parseResponse(resp, (data) => textFromContent(data?.content));
  }

  private async parseResponse(resp: Response, pickText: (data: any) => string): Promise<string> {
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} ${t.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    const text = pickText(data);
    if (!text) throw new Error("API 返回空内容");
    return text;
  }

  async report(input: PersonaInput): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      return this.apiFormat === "anthropic"
        ? await this.reportAnthropic(input, controller.signal)
        : await this.reportOpenAi(input, controller.signal);
    } catch (e) {
      log.warn(`人设层 API 调用失败，本轮降级为原始转述: ${(e as Error).message}`);
      const brief = input.workerText.replace(/\s+/g, " ").trim().slice(0, 200);
      return `（人设层 API 暂不可用）工作层结果：${brief}`;
    } finally {
      clearTimeout(timer);
    }
  }
}

