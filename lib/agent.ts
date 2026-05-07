import { getModelName, getOpenAIClient, readMarkdownChunks } from "@/lib/openai";
import { readState, type IndexedDocument } from "@/lib/store";

type SearchResult = {
  filename: string;
  score: number;
  excerpt: string;
};

type AgentToolName = "search_documents" | "lookup_channel" | "list_documents";

type AgentAction =
  | {
      type: "tool_call";
      tool: AgentToolName;
      args?: Record<string, unknown>;
    }
  | {
      type: "final";
      answer: string;
    };

type AgentExecutionResult = {
  answer: string;
  sources: SearchResult[];
  steps: Array<{
    tool: AgentToolName;
    summary: string;
  }>;
};

export type AgentPlanResult = {
  sources: SearchResult[];
  steps: Array<{
    tool: AgentToolName;
    summary: string;
  }>;
};

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreChunk(question: string, chunk: string) {
  const queryTokens = tokenize(question);
  const chunkTokens = new Set(tokenize(chunk));

  let matches = 0;
  for (const token of queryTokens) {
    if (chunkTokens.has(token)) {
      matches += 1;
    }
  }

  const phraseBonus = chunk.toLowerCase().includes(question.toLowerCase()) ? 3 : 0;
  return matches + phraseBonus;
}

async function searchDocuments(query: string, limit = 4) {
  const state = await readState();
  return searchDocumentsInScope(state.documents, query, limit);
}

async function searchDocumentsInScope(
  documents: IndexedDocument[],
  query: string,
  limit = 4,
) {
  const results: SearchResult[] = [];

  for (const document of documents) {
    const chunks = await readMarkdownChunks(document.markdownPath);
    for (const chunk of chunks) {
      const score = scoreChunk(query, chunk);
      if (score > 0) {
        results.push({
          filename: document.filename,
          score,
          excerpt: chunk,
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function lookupChannel(query: string) {
  const state = await readState();
  return lookupChannelInScope(state.documents, query);
}

async function lookupChannelInScope(documents: IndexedDocument[], query: string) {
  const baseResults = await searchDocumentsInScope(documents, query, 8);
  const queryTokens = tokenize(query);

  return baseResults
    .map((result) => {
      const excerptLower = result.excerpt.toLowerCase();
      const exactMatches = queryTokens.reduce(
        (sum, token) => sum + (excerptLower.includes(token.toLowerCase()) ? 1 : 0),
        0,
      );

      return {
        ...result,
        score: result.score + exactMatches * 2,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function listDocumentsInScope(documents: IndexedDocument[]) {
  return documents.map((document) => ({
    filename: document.filename,
    id: document.id,
    uploadedAt: document.uploadedAt,
    chunkCount: document.chunkCount,
    source: document.source,
    markdownPath: document.markdownPath,
  }));
}

function safeJsonParse(text: string): AgentAction | null {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1] ?? trimmed;

  try {
    const parsed = JSON.parse(candidate) as AgentAction;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }

    if (parsed.type === "final" && typeof parsed.answer === "string") {
      return parsed;
    }

    if (
      parsed.type === "tool_call" &&
      typeof parsed.tool === "string" &&
      ["search_documents", "lookup_channel", "list_documents"].includes(parsed.tool)
    ) {
      return parsed as AgentAction;
    }
  } catch {
    return null;
  }

  return null;
}

function stringifyToolResult(tool: AgentToolName, result: unknown) {
  return JSON.stringify(
    {
      tool,
      result,
    },
    null,
    2,
  );
}

function toolSummary(tool: AgentToolName, result: unknown) {
  if (tool === "list_documents") {
    const items = Array.isArray(result) ? result.length : 0;
    return `读取了 ${items} 份文档元数据`;
  }

  const items = Array.isArray(result) ? result.length : 0;
  return `执行 ${tool}，命中 ${items} 条结果`;
}

function extractContentText(content: string | Array<{ text?: string }> | null | undefined) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || "")
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function callModel(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  const client = getOpenAIClient();
  const response = await client.chat.completions.create({
    model: getModelName(),
    temperature: 0.2,
    messages,
  });

  const content = extractContentText(response.choices?.[0]?.message?.content);
  return content.trim();
}

function buildFinalAnswerMessages(question: string, sources: SearchResult[]) {
  return [
    {
      role: "system" as const,
      content:
        "你是一个文档问答助手。基于给定工具结果回答，先给结论，再给简短依据。如果证据不足，要明确说不知道。",
    },
    {
      role: "user" as const,
      content: `原问题：${question}\n\n工具结果：\n${JSON.stringify(
        sources.slice(0, 4),
        null,
        2,
      )}`,
    },
  ];
}

export async function executeAgentPlan(
  question: string,
  documentId?: string,
): Promise<AgentPlanResult> {
  const state = await readState();
  if (state.documents.length === 0) {
    throw new Error("知识库还是空的，请先导入至少一份文档。");
  }

  const scopedDocuments = documentId
    ? state.documents.filter((document) => document.id === documentId)
    : state.documents;

  if (scopedDocuments.length === 0) {
    throw new Error("当前选中的文档不存在，请重新选择。");
  }

  const systemPrompt = [
    "你是一个文档问答 Agent。",
    "你可以分步决定要不要调用工具，再输出最终答案。",
    "可用工具只有：",
    "1. search_documents: 按问题检索最相关的文档片段。参数：query(string), limit(number, optional)",
    "2. lookup_channel: 按渠道名、渠道ID、环境、订单类型做更聚焦检索。参数：query(string)",
    "3. list_documents: 查看当前已导入文档。无参数",
    "你的回复必须是 JSON，且只能是以下两种结构之一：",
    '{"type":"tool_call","tool":"search_documents","args":{"query":"10219 港版支付宝 uat 首页"}}',
    '{"type":"final","answer":"最终答案"}',
    "规则：",
    "- 如果没有足够证据，先调用工具，不要直接编造。",
    "- 通常先用 search_documents 或 lookup_channel。",
    "- 最多调用 3 次工具。",
    `- 当前只允许使用这些文档作为上下文：${scopedDocuments
      .map((document) => `${document.filename}(${document.id})`)
      .join("，")}`,
    "- 最终答案必须基于工具结果，先给结论，再给简短依据。",
    "- 不要输出 JSON 以外的解释。",
  ].join("\n");

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `用户问题：${question}` },
  ];

  const collectedSources = new Map<string, SearchResult>();
  const steps: Array<{ tool: AgentToolName; summary: string }> = [];

  for (let step = 0; step < 4; step += 1) {
    const rawReply = await callModel(messages);
    const action = safeJsonParse(rawReply);

    if (!action) {
      break;
    }

    if (action.type === "final") {
      return {
        sources: Array.from(collectedSources.values()).slice(0, 4),
        steps,
      };
    }

    const tool = action.tool;
    let toolResult: unknown;

    if (tool === "search_documents") {
      const query =
        typeof action.args?.query === "string" && action.args.query.trim()
          ? action.args.query.trim()
          : question;
      const limit =
        typeof action.args?.limit === "number" && action.args.limit > 0
          ? Math.min(action.args.limit, 6)
          : 4;
      toolResult = await searchDocumentsInScope(scopedDocuments, query, limit);
    } else if (tool === "lookup_channel") {
      const query =
        typeof action.args?.query === "string" && action.args.query.trim()
          ? action.args.query.trim()
          : question;
      toolResult = await lookupChannelInScope(scopedDocuments, query);
    } else {
      toolResult = await listDocumentsInScope(scopedDocuments);
    }

    if (Array.isArray(toolResult)) {
      for (const item of toolResult) {
        if (
          item &&
          typeof item === "object" &&
          "filename" in item &&
          "excerpt" in item &&
          typeof item.filename === "string" &&
          typeof item.excerpt === "string"
        ) {
          const key = `${item.filename}:${item.excerpt.slice(0, 80)}`;
          collectedSources.set(key, item as SearchResult);
        }
      }
    }

    steps.push({
      tool,
      summary: toolSummary(tool, toolResult),
    });

    messages.push({ role: "assistant", content: rawReply });
    messages.push({
      role: "user",
      content: `工具执行结果：\n${stringifyToolResult(tool, toolResult)}\n\n请继续，只能输出 JSON。`,
    });
  }

  if (collectedSources.size === 0) {
    return {
      sources: [],
      steps,
    };
  }

  return {
    sources: Array.from(collectedSources.values()).slice(0, 4),
    steps,
  };
}

export async function streamFinalAnswer(
  question: string,
  sources: SearchResult[],
  onDelta: (chunk: string) => void,
) {
  const client = getOpenAIClient();
  const stream = await client.chat.completions.create({
    model: getModelName(),
    temperature: 0.2,
    stream: true,
    messages: buildFinalAnswerMessages(question, sources),
  });

  let finalText = "";

  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    const text = extractContentText(delta as string | Array<{ text?: string }> | undefined);
    if (!text) {
      continue;
    }

    finalText += text;
    onDelta(text);
  }

  return finalText.trim();
}

export async function generateFinalAnswer(question: string, sources: SearchResult[]) {
  const finalAnswer = await callModel([
    ...buildFinalAnswerMessages(question, sources),
  ]);

  return finalAnswer;
}

export async function runDocumentAgent(question: string): Promise<AgentExecutionResult> {
  const plan = await executeAgentPlan(question);
  if (plan.sources.length === 0) {
    return {
      answer: "没有在已导入文档里检索到足够相关的内容。请换个问法，或者先补充对应文档。",
      sources: [],
      steps: plan.steps,
    };
  }

  const answer = await generateFinalAnswer(question, plan.sources);

  return {
    answer,
    sources: plan.sources,
    steps: plan.steps,
  };
}
