import { getModelName, getOpenAIClient, readMarkdownChunks } from "@/lib/openai";
import { readState, type IndexedDocument } from "@/lib/store";

type SearchResult = {
  filename: string;
  score: number;
  excerpt: string;
};

type RankedSearchResult = SearchResult & {
  matchCount: number;
  coverage: number;
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
  shouldAnswer: boolean;
  debug: {
    questionType: "overview" | "direct";
    hitCount: number;
    strongHitCount: number;
    topScore: number | null;
    topSourceFilename: string | null;
    refusalReason: string | null;
  };
};

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dedupeTokens(tokens: string[]) {
  return Array.from(new Set(tokens));
}

function hasCjk(text: string) {
  return /[\u4e00-\u9fa5]/.test(text);
}

function expandQueryTerms(question: string) {
  const baseTokens = dedupeTokens(tokenize(question)).filter((token) => token.length > 1 || hasCjk(token));
  const expanded = new Set(baseTokens);

  for (const token of baseTokens) {
    if (/uat/i.test(token)) {
      expanded.add("test");
      expanded.add("测试");
    }
    if (/prod|production/i.test(token)) {
      expanded.add("正式");
      expanded.add("生产");
    }
    if (/app/i.test(token)) {
      expanded.add("应用");
    }
    if (/pc/i.test(token)) {
      expanded.add("web");
      expanded.add("官网");
    }
    if (/h5|m站/i.test(token)) {
      expanded.add("移动");
      expanded.add("手机");
    }
  }

  return Array.from(expanded);
}

function scoreChunk(question: string, chunk: string): RankedSearchResult["score"] | null {
  const queryTokens = expandQueryTerms(question);
  if (queryTokens.length === 0) {
    return null;
  }

  const excerpt = chunk.trim();
  const excerptLower = excerpt.toLowerCase();
  const chunkTokens = tokenize(excerpt);
  const chunkTokenSet = new Set(chunkTokens);

  let matchCount = 0;
  let weightedMatches = 0;

  for (const token of queryTokens) {
    const exactWordMatch = chunkTokenSet.has(token);
    const substringMatch = !exactWordMatch && token.length >= 2 && excerptLower.includes(token);

    if (!exactWordMatch && !substringMatch) {
      continue;
    }

    matchCount += 1;

    if (exactWordMatch) {
      weightedMatches += token.length >= 4 || hasCjk(token) ? 2.2 : 1.4;
    } else {
      weightedMatches += hasCjk(token) ? 1.2 : 0.8;
    }
  }

  if (matchCount === 0) {
    return null;
  }

  const coverage = matchCount / queryTokens.length;
  const phraseBonus = excerptLower.includes(question.toLowerCase()) ? 4 : 0;
  const headingBonus = /^(#{1,6}\s|\d+[.)、]|\-\s)/m.test(excerpt) ? 0.6 : 0;
  const densityBonus = coverage >= 0.6 ? 1.8 : coverage >= 0.4 ? 0.8 : 0;
  const lengthPenalty = excerpt.length > 720 ? 1.2 : excerpt.length > 540 ? 0.6 : 0;

  return Number((weightedMatches + phraseBonus + headingBonus + densityBonus - lengthPenalty).toFixed(3));
}

function rankChunk(question: string, filename: string, chunk: string): RankedSearchResult | null {
  const queryTokens = expandQueryTerms(question);
  if (queryTokens.length === 0) {
    return null;
  }

  const excerptLower = chunk.toLowerCase();
  let matchCount = 0;

  for (const token of queryTokens) {
    if (excerptLower.includes(token.toLowerCase())) {
      matchCount += 1;
    }
  }

  const score = scoreChunk(question, chunk);
  if (score === null) {
    return null;
  }

  return {
    filename,
    score,
    excerpt: chunk,
    matchCount,
    coverage: matchCount / queryTokens.length,
  };
}

export function isStrongEvidence(result: RankedSearchResult | SearchResult | undefined) {
  if (!result) {
    return false;
  }

  const coverage = "coverage" in result ? result.coverage : 0;
  const matchCount = "matchCount" in result ? result.matchCount : 0;
  return result.score >= 2.2 && (coverage >= 0.25 || matchCount >= 1);
}

function filterStrongEvidence(results: RankedSearchResult[], limit: number) {
  const strong = results.filter((result) => isStrongEvidence(result));
  return (strong.length ? strong : results).slice(0, limit);
}

function toSearchResult(result: RankedSearchResult): SearchResult {
  return {
    filename: result.filename,
    score: result.score,
    excerpt: result.excerpt,
  };
}

function isOverviewQuestion(question: string) {
  return /多少|几个|有哪些|列出|总结|概括|统计|数量|全部|所有|分类|渠道/.test(question);
}

async function buildDocumentOverviewSources(documents: IndexedDocument[], limit = 8) {
  const results: SearchResult[] = [];

  for (const document of documents) {
    const chunks =
      Array.isArray(document.chunks) && document.chunks.length
        ? document.chunks
        : await readMarkdownChunks(document.markdownPath);

    const priorityChunks = chunks.filter((chunk) =>
      /渠道|环境|支付|站|app|pc|m站|微信|支付宝|hopegoo/i.test(chunk),
    );
    const selectedChunks = [...priorityChunks, ...chunks].filter(
      (chunk, index, list) => list.indexOf(chunk) === index,
    );

    for (const [index, chunk] of selectedChunks.entries()) {
      results.push({
        filename: document.filename,
        score: 1,
        excerpt: chunk,
      });

      if (index + 1 >= limit) {
        break;
      }
    }
  }

  return results.slice(0, limit);
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
  const results: RankedSearchResult[] = [];

  for (const document of documents) {
    const chunks =
      Array.isArray(document.chunks) && document.chunks.length
        ? document.chunks
        : await readMarkdownChunks(document.markdownPath);
    for (const chunk of chunks) {
      const ranked = rankChunk(query, document.filename, chunk);
      if (ranked) {
        results.push(ranked);
      }
    }
  }

  return filterStrongEvidence(
    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      if (b.coverage !== a.coverage) {
        return b.coverage - a.coverage;
      }
      return a.excerpt.length - b.excerpt.length;
    }),
    limit,
  ).map(toSearchResult);
}

async function rankDocumentsInScope(documents: IndexedDocument[], query: string) {
  const results: RankedSearchResult[] = [];

  for (const document of documents) {
    const chunks =
      Array.isArray(document.chunks) && document.chunks.length
        ? document.chunks
        : await readMarkdownChunks(document.markdownPath);
    for (const chunk of chunks) {
      const ranked = rankChunk(query, document.filename, chunk);
      if (ranked) {
        results.push(ranked);
      }
    }
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.coverage !== a.coverage) {
      return b.coverage - a.coverage;
    }
    return a.excerpt.length - b.excerpt.length;
  });
}

export async function executeFastDocumentPlan(
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

  const rankedResults = await rankDocumentsInScope(scopedDocuments, question);
  const strongResults = rankedResults.filter((result) => isStrongEvidence(result));
  let sources = (strongResults.length ? strongResults : rankedResults)
    .slice(0, 5)
    .map(toSearchResult);
  const steps: AgentPlanResult["steps"] = [
    {
      tool: "search_documents",
      summary: `快速检索当前文档，筛出 ${sources.length} 条高相关结果`,
    },
  ];

  const hasStrongDirectEvidence = strongResults.length > 0;
  const shouldAnswer =
    sources.length > 0 && (hasStrongDirectEvidence || isOverviewQuestion(question));

  if (!shouldAnswer && !isOverviewQuestion(question)) {
    steps.push({
      tool: "search_documents",
      summary: "当前命中证据较弱，后续回答会更保守，必要时明确说明无法确认",
    });
  }

  if ((sources.length === 0 || !hasStrongDirectEvidence) && isOverviewQuestion(question)) {
    const overviewSources = await buildDocumentOverviewSources(scopedDocuments, 8);

    if (overviewSources.length) {
      sources = sources.length ? sources : overviewSources;
      steps.push({
        tool: "search_documents",
        summary: `补充文档概要上下文 ${overviewSources.length} 段，用于统计/概括类问题`,
      });
    }
  }

  const refusalReason =
    sources.length === 0
      ? "no_hits"
      : shouldAnswer
        ? null
        : "top_hit_below_threshold";

  return {
    sources,
    steps,
    shouldAnswer: sources.length > 0 && (shouldAnswer || isOverviewQuestion(question)),
    debug: {
      questionType: isOverviewQuestion(question) ? "overview" : "direct",
      hitCount: rankedResults.length,
      strongHitCount: strongResults.length,
      topScore: rankedResults[0]?.score ?? null,
      topSourceFilename: rankedResults[0]?.filename ?? null,
      refusalReason,
    },
  };
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
        "你是一个文档问答助手。基于给定工具结果回答，先给结论，再给简短依据。遇到统计、数量、列举、总结类问题，要从证据里归纳、去重并计数；如果证据不足，要明确说明口径和不确定性，不要编造。",
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
        shouldAnswer: collectedSources.size > 0,
        debug: {
          questionType: isOverviewQuestion(question) ? "overview" : "direct",
          hitCount: collectedSources.size,
          strongHitCount: collectedSources.size,
          topScore: null,
          topSourceFilename: Array.from(collectedSources.values())[0]?.filename ?? null,
          refusalReason: collectedSources.size > 0 ? null : "no_hits",
        },
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
      shouldAnswer: false,
      debug: {
        questionType: isOverviewQuestion(question) ? "overview" : "direct",
        hitCount: 0,
        strongHitCount: 0,
        topScore: null,
        topSourceFilename: null,
        refusalReason: "no_hits",
      },
    };
  }

  return {
    sources: Array.from(collectedSources.values()).slice(0, 4),
    steps,
    shouldAnswer: true,
    debug: {
      questionType: isOverviewQuestion(question) ? "overview" : "direct",
      hitCount: collectedSources.size,
      strongHitCount: collectedSources.size,
      topScore: null,
      topSourceFilename: Array.from(collectedSources.values())[0]?.filename ?? null,
      refusalReason: null,
    },
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
      answer:
        "没有在已导入文档里检索到足够强的相关证据，暂时无法可靠回答。请换个更具体的问法，或补充对应文档后再试。",
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
