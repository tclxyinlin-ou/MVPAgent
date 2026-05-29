import { getModelName, getOpenAIClient, readMarkdownChunks } from "@/lib/openai";
import {
  ensureStructuredKnowledgeDocument,
  loadStructuredKnowledgeDocument,
  type DomainEnvironmentMap,
  type StructuredKnowledgeDocument,
} from "@/lib/knowledge-index";
import { readState, type IndexedDocument } from "@/lib/store";

type SearchResult = {
  filename: string;
  score: number;
  excerpt: string;
};

type RankedSearchResult = SearchResult & {
  matchCount: number;
  coverage: number;
  headingPath: string[];
};

type QuestionIntent = {
  kind: "overview" | "exact_value" | "rule";
  answerMode: "summary" | "exact_value" | "rule";
  entity: string | null;
  environment: string | null;
  targetField: string | null;
  wantsConcreteUrl: boolean;
};

type StructuredLookupResult = {
  answer: string;
  sources: SearchResult[];
  debugLabel: string;
};

type StructuredEnvironmentKey = keyof DomainEnvironmentMap;

type ExtractedAnswer = {
  value: string | null;
  valueType: "full_url" | "domain_rule" | "domain_group" | "text";
  confidence: number;
  rationale: string;
  groupName?: string | null;
  domains?: Partial<Record<"qa" | "uat" | "pre" | "pre2" | "prod", string>>;
};

function extractUrls(text: string) {
  return Array.from(text.matchAll(/https?:\/\/[^\s)\]]+/g)).map((match) => match[0]);
}

function urlMatchesTargetField(url: string, targetField: string | null) {
  if (targetField === "homepage") {
    return /#\/index(?:$|\?)/.test(url);
  }
  if (targetField === "order_detail") {
    return /#\/orderDetail(?:$|\?)/i.test(url);
  }
  if (targetField === "grab_order") {
    return /#\/grabOrderDetail(?:$|\?)/i.test(url);
  }

  return true;
}

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
    intentKind: QuestionIntent["kind"];
    answerMode: QuestionIntent["answerMode"];
    queryRewrite: string | null;
    lookupMode: "structured" | "text";
    structuredHitKind: string | null;
    environment: string | null;
    targetField: string | null;
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

const QUERY_ALIAS_GROUPS: Array<{
  triggers: RegExp[];
  aliases: string[];
}> = [
  {
    triggers: [/国际站/, /international/i],
    aliases: [
      "hopegoo",
      "travelgo",
      "微信国际站",
      "国际m站",
      "travelgom站",
      "hopegoo-app",
      "hopegoo-pc",
      "hopegoo-m",
    ],
  },
  {
    triggers: [/港版支付宝/, /香港支付宝/, /alipayhk/i],
    aliases: ["10219", "alipay", "travelgo", "港币", "香港钱包"],
  },
  {
    triggers: [/微信国际站/, /wechat\s*hk/i, /\b982\b/],
    aliases: ["wechatHK", "微信多语言", "982", "17u", "国际站"],
  },
  {
    triggers: [/hopegoo\s*m/i, /hopegoo[-\s]?m/i],
    aliases: ["hopegooTouch", "20003", "国际站", "hopegoo"],
  },
  {
    triggers: [/travelgo\s*m站/i, /travelgom站/i, /国际m站/],
    aliases: ["985", "touch", "travelgo", "国际站"],
  },
];

const DOMAIN_GROUP_ALIASES: Array<{
  groupName: string;
  aliases: string[];
}> = [
  {
    groupName: "Hopegoo",
    aliases: [
      "intlapp",
      "hopegooapp",
      "ja app",
      "hopegootouch",
      "hopegoo m",
      "ja m",
      "wechathk",
      "微信多语言",
      "octopus",
      "八达通",
      "alipaycn",
      "hopegoojapanesetouch",
      "hopegoojapaneseapp",
      "hopegoounionpay",
      "20000",
      "20003",
      "20004",
      "20014",
      "20017",
      "20022",
      "20023",
      "20030",
    ],
  },
  {
    groupName: "Travelgo",
    aliases: ["touch", "travelgom站", "travelgom", "国际m站", "alipay", "香港支付宝", "10219", "985"],
  },
  {
    groupName: "17u",
    aliases: ["weixin", "微信国际站", "982"],
  },
];

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

  for (const group of QUERY_ALIAS_GROUPS) {
    if (group.triggers.some((pattern) => pattern.test(question))) {
      for (const alias of group.aliases) {
        expanded.add(alias.toLowerCase());
      }
    }
  }

  return Array.from(expanded);
}

function scoreChunk(question: string, chunk: { text: string; searchText: string; headingPath: string[] }): RankedSearchResult["score"] | null {
  const queryTokens = expandQueryTerms(question);
  if (queryTokens.length === 0) {
    return null;
  }

  const excerpt = chunk.text.trim();
  const excerptLower = excerpt.toLowerCase();
  const searchTextLower = chunk.searchText.toLowerCase();
  const chunkTokens = tokenize(chunk.searchText);
  const chunkTokenSet = new Set(chunkTokens);

  let matchCount = 0;
  let weightedMatches = 0;

  for (const token of queryTokens) {
    const exactWordMatch = chunkTokenSet.has(token);
    const substringMatch = !exactWordMatch && token.length >= 2 && searchTextLower.includes(token);

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
  const phraseBonus = searchTextLower.includes(question.toLowerCase()) ? 4 : 0;
  const headingBonus =
    chunk.headingPath.some((heading) => question.toLowerCase().includes(heading.toLowerCase())) ||
    chunk.headingPath.some((heading) => heading.toLowerCase().includes(question.toLowerCase()))
      ? 2
      : /^(#{1,6}\s|\d+[.)、]|\-\s)/m.test(excerpt)
        ? 0.6
        : 0;
  const densityBonus = coverage >= 0.6 ? 1.8 : coverage >= 0.4 ? 0.8 : 0;
  const lengthPenalty = excerpt.length > 720 ? 1.2 : excerpt.length > 540 ? 0.6 : 0;

  return Number((weightedMatches + phraseBonus + headingBonus + densityBonus - lengthPenalty).toFixed(3));
}

function rankChunk(
  question: string,
  filename: string,
  chunk: { text: string; searchText: string; headingPath: string[] },
): RankedSearchResult | null {
  const queryTokens = expandQueryTerms(question);
  if (queryTokens.length === 0) {
    return null;
  }

  const excerptLower = chunk.searchText.toLowerCase();
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
    excerpt: chunk.text,
    matchCount,
    coverage: matchCount / queryTokens.length,
    headingPath: chunk.headingPath,
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

function isConcreteUrlQuestion(question: string) {
  return /首页地址|具体地址|完整地址|完整链接|具体链接|url|URL|href|链接/.test(question);
}

function extractEnvironment(question: string) {
  const normalized = question.toLowerCase();
  if (/uat/.test(normalized)) {
    return "uat";
  }
  if (/qa/.test(normalized)) {
    return "qa";
  }
  if (/预发2|pre2|stage2/.test(question)) {
    return "pre2";
  }
  if (/预发|预发1|stage/.test(question)) {
    return "pre";
  }
  if (/正式|生产|线上|prod|production/.test(question)) {
    return "prod";
  }

  return null;
}

function extractTargetField(question: string) {
  if (/首页地址|首页链接|首页url|首页URL|首页/.test(question)) {
    return "homepage";
  }
  if (/订单详情|orderdetail/i.test(question)) {
    return "order_detail";
  }
  if (/抢票/.test(question)) {
    return "grab_order";
  }
  if (/规则|域名|环境/.test(question)) {
    return "rule";
  }

  return null;
}

function extractEntity(question: string) {
  const idMatch = question.match(/\b\d{4,6}\b/);
  if (idMatch) {
    return idMatch[0];
  }

  const entityMatch = question.match(
    /(港版支付宝|支付宝hk|alipayhk|hopegooAPP|hopegooPC|hopegooM站|hopegoo M站|微信国际站|octopus|wechatHK|aliPayCN)/i,
  );

  return entityMatch?.[0] ?? null;
}

function parseQuestionIntent(question: string): QuestionIntent {
  const overview = isOverviewQuestion(question);
  const wantsConcreteUrl = isConcreteUrlQuestion(question);
  const targetField = extractTargetField(question);
  const environment = extractEnvironment(question);
  const entity = extractEntity(question);
  const ruleQuestion = /规则|域名|环境/.test(question) && !wantsConcreteUrl;

  if (overview) {
    return {
      kind: "overview",
      answerMode: "summary",
      entity,
      environment,
      targetField,
      wantsConcreteUrl: false,
    };
  }

  if (ruleQuestion) {
    return {
      kind: "rule",
      answerMode: "rule",
      entity,
      environment,
      targetField: targetField || "rule",
      wantsConcreteUrl: false,
    };
  }

  return {
    kind: "exact_value",
    answerMode: wantsConcreteUrl ? "exact_value" : targetField === "rule" ? "rule" : "exact_value",
    entity,
    environment,
    targetField,
    wantsConcreteUrl,
  };
}

function rewriteQuestion(question: string) {
  const compact = question.trim();
  const normalized = compact
    .replace(/港版支付宝/gi, "香港支付宝")
    .replace(/微信多语言/gi, "wechatHK")
    .replace(/hopegoo\s*m站/gi, "hopegooTouch")
    .replace(/travelgo\s*m站/gi, "touch");

  return {
    original: compact,
    normalized,
    aliases: expandQueryTerms(normalized),
  };
}

function normalizeEntityToken(value: string) {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function getEntityAliases(entity: string | null, question: string) {
  const seeds = [entity, question]
    .filter(Boolean)
    .map((item) => normalizeEntityToken(item as string));
  const aliases = new Set<string>(seeds);

  for (const group of DOMAIN_GROUP_ALIASES) {
    if (group.aliases.some((alias) => seeds.some((seed) => seed.includes(normalizeEntityToken(alias))))) {
      for (const alias of group.aliases) {
        aliases.add(normalizeEntityToken(alias));
      }
      aliases.add(normalizeEntityToken(group.groupName));
    }
  }

  return Array.from(aliases).filter(Boolean);
}

function parseDomainValue(raw: string) {
  const linkMatch = raw.match(/\((https?:\/\/[^)\s]+)\)/i);
  if (linkMatch?.[1]) {
    return linkMatch[1];
  }

  const nakedUrlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  if (nakedUrlMatch?.[0]) {
    return nakedUrlMatch[0];
  }

  const bareDomainMatch = raw.match(/www\d?\.[a-z0-9.-]+\.[a-z]{2,}/i);
  if (bareDomainMatch?.[0]) {
    return bareDomainMatch[0];
  }

  return null;
}

function parseDomainMappings(excerpt: string) {
  const domains: Partial<Record<"qa" | "uat" | "pre" | "pre2" | "prod", string>> = {};
  const lines = excerpt.split("\n").map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    const qaMatch = line.match(/^qa[：:]\s*(.+)$/i);
    if (qaMatch) {
      const value = parseDomainValue(qaMatch[1]);
      if (value) {
        domains.qa = value;
      }
      continue;
    }

    const uatMatch = line.match(/^uat[：:]\s*(.+)$/i);
    if (uatMatch) {
      const value = parseDomainValue(uatMatch[1]);
      if (value) {
        domains.uat = value;
      }
      continue;
    }

    const pre2Match = line.match(/^(预发2|pre2)[：:]\s*(.+)$/i);
    if (pre2Match) {
      const value = parseDomainValue(pre2Match[2]);
      if (value) {
        domains.pre2 = value;
      }
      continue;
    }

    const preMatch = line.match(/^(预发|stage)[：:]\s*(.+)$/i);
    if (preMatch) {
      const value = parseDomainValue(preMatch[2]);
      if (value) {
        domains.pre = value;
      }
      continue;
    }

    const prodMatch = line.match(/^(生产|正式|prod|production)[：:]\s*(.+)$/i);
    if (prodMatch) {
      const value = parseDomainValue(prodMatch[2]);
      if (value) {
        domains.prod = value;
      }
    }
  }

  return domains;
}

function extractDomainGroupAnswer(intent: QuestionIntent, sources: SearchResult[], question: string): ExtractedAnswer | null {
  const aliases = getEntityAliases(intent.entity, question);
  if (!aliases.length) {
    return null;
  }

  for (const source of sources) {
    const excerpt = source.excerpt;
    const normalizedExcerpt = normalizeEntityToken(excerpt);

    for (const group of DOMAIN_GROUP_ALIASES) {
      const normalizedGroupAliases = group.aliases.map((alias) => normalizeEntityToken(alias));
      const matchesAlias = normalizedGroupAliases.some(
        (alias) =>
          aliases.includes(alias) ||
          normalizedExcerpt.includes(`渠道：${alias}`) ||
          normalizedExcerpt.includes(alias),
      );

      if (!matchesAlias) {
        continue;
      }

      const domains = parseDomainMappings(excerpt);
      if (!Object.keys(domains).length) {
        continue;
      }

      const preferredValue =
        (intent.environment && domains[intent.environment as keyof typeof domains]) ||
        domains.uat ||
        domains.qa ||
        domains.prod ||
        Object.values(domains)[0] ||
        null;

      return {
        value: preferredValue,
        valueType: "domain_group",
        confidence: 0.86,
        rationale: "命中片段展示了渠道所属的域名组，以及该组的环境域名映射。",
        groupName: group.groupName,
        domains,
      };
    }
  }

  return null;
}

async function buildDocumentOverviewSources(documents: IndexedDocument[], limit = 8) {
  const results: SearchResult[] = [];

  for (const document of documents) {
    const chunks =
      Array.isArray(document.chunks) && document.chunks.length
        ? document.chunks
        : await readMarkdownChunks(document.markdownPath);

    const priorityChunks = chunks.filter((chunk) =>
      /渠道|环境|支付|站|app|pc|m站|微信|支付宝|hopegoo/i.test(chunk.searchText),
    );
    const selectedChunks = [...priorityChunks, ...chunks].filter(
      (chunk, index, list) =>
        list.findIndex(
          (candidate) =>
            candidate.text === chunk.text &&
            candidate.headingPath.join(" > ") === chunk.headingPath.join(" > "),
        ) === index,
    );

    for (const [index, chunk] of selectedChunks.entries()) {
      results.push({
        filename: document.filename,
        score: 1,
        excerpt: chunk.text,
      });

      if (index + 1 >= limit) {
        break;
      }
    }
  }

  return results.slice(0, limit);
}

function rerankResultsForQuestion(intent: QuestionIntent, results: RankedSearchResult[]) {

  return [...results].sort((a, b) => {
    const scoreA = scoreResultForIntent(intent, a);
    const scoreB = scoreResultForIntent(intent, b);

    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }

    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return a.excerpt.length - b.excerpt.length;
  });
}

function scoreResultForIntent(intent: QuestionIntent, result: RankedSearchResult) {
  let total = result.score;
  const excerpt = result.excerpt.toLowerCase();
  const headingText = result.headingPath.join(" > ").toLowerCase();

  if (intent.entity && excerpt.includes(intent.entity.toLowerCase())) {
    total += 1.4;
  }

  if (intent.environment) {
    if (excerpt.includes(intent.environment)) {
      total += 1.2;
    } else if (/uat|qa|预发|生产|正式/.test(excerpt)) {
      total -= 0.6;
    }
  }

  if (intent.wantsConcreteUrl) {
    if (/https?:\/\/|#\/index|href/.test(excerpt)) {
      total += 3;
    }

    if (intent.targetField === "homepage" && /#\/index/.test(excerpt)) {
      total += 2.5;
    }

    if (/正式环境|uat:|预发|生产/.test(excerpt) && !/https?:\/\/.+#\/index/.test(excerpt)) {
      total -= 1.5;
    }
  } else if (intent.answerMode === "rule") {
    if (/正式环境|uat:|预发|生产/.test(excerpt)) {
      total += 2;
    }

    if (/https?:\/\/.+#\/index/.test(excerpt)) {
      total -= 0.8;
    }
  }

  if (headingText.includes("国际站")) {
    total += 1.8;
  }

  if (headingText.includes("渠道")) {
    total += 0.8;
  }

  if (headingText.includes("环境域名")) {
    total += intent.wantsConcreteUrl || intent.answerMode === "rule" ? 1.1 : 0.4;
  }

  if (intent.entity && headingText.includes(intent.entity.toLowerCase())) {
    total += 1;
  }

  return total;
}

function extractAnswerFromSources(intent: QuestionIntent, sources: SearchResult[]): ExtractedAnswer | null {
  if (!sources.length) {
    return null;
  }

  if (intent.wantsConcreteUrl) {
    const normalizedEnvironment = intent.environment?.toLowerCase() || "";
    const exactUrlSource = sources.find((source) => {
      const excerpt = source.excerpt.toLowerCase();
      return (
        /https?:\/\/[^\s)\]]+/.test(excerpt) &&
        (!normalizedEnvironment || excerpt.includes(normalizedEnvironment)) &&
        extractUrls(source.excerpt).some((url) =>
          urlMatchesTargetField(url, intent.targetField),
        )
      );
    });

    if (exactUrlSource) {
      const matchedUrl = extractUrls(exactUrlSource.excerpt).find((url) =>
        urlMatchesTargetField(url, intent.targetField),
      );
      if (matchedUrl) {
        return {
          value: matchedUrl,
          valueType: "full_url",
          confidence: 0.96,
          rationale: "从命中片段中抽取到了与环境和字段匹配的完整 URL。",
        };
      }
    }

    const domainSource = sources.find((source) => {
      const excerpt = source.excerpt.toLowerCase();
      return Boolean(
        normalizedEnvironment &&
          excerpt.includes(normalizedEnvironment) &&
          /www\.[a-z0-9.-]+\.[a-z]{2,}/.test(excerpt),
      );
    });

    if (domainSource) {
      const domainMatch = domainSource.excerpt.match(/www\.[a-z0-9.-]+\.[a-z]{2,}/i);
      if (domainMatch) {
        return {
          value: domainMatch[0],
          valueType: "domain_rule",
          confidence: 0.58,
          rationale: "只抽取到了环境域名规则，没有抽取到完整路径。",
        };
      }
    }
  }

  if (intent.entity && (intent.answerMode === "rule" || intent.targetField === "rule")) {
    const groupAnswer = extractDomainGroupAnswer(intent, sources, intent.entity);
    if (groupAnswer) {
      return groupAnswer;
    }
  }

  return null;
}

function formatDomainGroupAnswer(extracted: ExtractedAnswer) {
  const parts: string[] = [];
  if (extracted.domains?.qa) {
    parts.push(`QA：${extracted.domains.qa}`);
  }
  if (extracted.domains?.uat) {
    parts.push(`UAT：${extracted.domains.uat}`);
  }
  if (extracted.domains?.pre) {
    parts.push(`预发：${extracted.domains.pre}`);
  }
  if (extracted.domains?.pre2) {
    parts.push(`预发2：${extracted.domains.pre2}`);
  }
  if (extracted.domains?.prod) {
    parts.push(`生产：${extracted.domains.prod}`);
  }

  return `结论：该渠道归属 ${extracted.groupName || "对应"} 域名组，共用这组环境域名。\n${parts.join("\n")}\n依据：命中片段先列出渠道归属，再给出了该域名组的 QA/UAT/预发/生产映射。`;
}

function buildStructuredSources(
  document: StructuredKnowledgeDocument,
  groupName: string,
  environments: Record<string, string>,
) {
  const excerpt = [
    `域名组：${groupName}`,
    ...Object.entries(environments).map(([key, value]) => `${key.toUpperCase()}：${value}`),
  ].join("\n");

  return [
    {
      filename: `${document.documentId}.entities`,
      score: 5,
      excerpt,
    } satisfies SearchResult,
  ];
}

function buildStructuredAnswerSource(documentId: string, answer: string) {
  return {
    filename: `${documentId}.structured-answer`,
    score: 9,
    excerpt: answer,
  } satisfies SearchResult;
}

async function lookupStructuredKnowledge(
  question: string,
  documents: IndexedDocument[],
): Promise<StructuredLookupResult | null> {
  const rewritten = rewriteQuestion(question);
  const intent = parseQuestionIntent(rewritten.normalized);
  const tokens = rewritten.aliases.map((token) => normalizeEntityToken(token));

    for (const document of documents) {
    const knowledge =
      (await loadStructuredKnowledgeDocument(document.id)) ||
      (await ensureStructuredKnowledgeDocument(document.id, document.markdownPath));
    if (!knowledge) {
      continue;
    }

    for (const group of knowledge.domainGroups) {
      const matchedChannels = group.channels.filter((channel) =>
        channel.aliases.some((alias) => tokens.includes(normalizeEntityToken(alias))) ||
        (channel.id ? tokens.includes(normalizeEntityToken(channel.id)) : false),
      );

      if (!matchedChannels.length) {
        continue;
      }

      const selectedEnvironmentKey = intent.environment as StructuredEnvironmentKey | null;
      const selectedEnvironment =
        (selectedEnvironmentKey && group.environments[selectedEnvironmentKey]) || null;
      const sources = buildStructuredSources(knowledge, group.name, group.environments);

      if (intent.wantsConcreteUrl) {
        const matchedExamples = knowledge.urlExamples.filter(
          (example) =>
            matchedChannels.some((channel) => channel.key === example.channelKey) &&
            (!intent.environment || example.environment === intent.environment) &&
            (!intent.targetField ||
              (intent.targetField === "homepage" && example.pageType === "homepage") ||
              (intent.targetField === "order_detail" && example.pageType === "order_detail") ||
              (intent.targetField === "grab_order" && example.pageType === "grab_order")),
        );

        if (matchedExamples.length) {
          const best = matchedExamples[0];
          const answer = `结论：${best.url}\n依据：结构化索引里命中了渠道 ${matchedChannels[0].aliases[0]} 的 ${best.environment || "对应"} 环境 ${best.pageType} 示例链接。`;
          return {
            answer,
            sources: [
              buildStructuredAnswerSource(knowledge.documentId, answer),
              ...sources,
              {
                filename: `${knowledge.documentId}.entities`,
                score: 6,
                excerpt: `渠道：${best.channelKey}\n环境：${best.environment}\n页面：${best.pageType}\nURL：${best.url}`,
              },
            ],
            debugLabel: "structured_url_example",
          };
        }
      }

      if (intent.answerMode === "rule" || intent.targetField === "rule") {
        const lines = [
          `结论：该渠道归属 ${group.name} 域名组，共用这组环境域名。`,
          group.environments.qa ? `QA：${group.environments.qa}` : "",
          group.environments.uat ? `UAT：${group.environments.uat}` : "",
          group.environments.pre ? `预发：${group.environments.pre}` : "",
          group.environments.pre2 ? `预发2：${group.environments.pre2}` : "",
          group.environments.prod ? `生产：${group.environments.prod}` : "",
          selectedEnvironment
            ? `补充：你问题里指定的 ${intent.environment?.toUpperCase()} 环境域名是 ${selectedEnvironment}。`
            : "",
          "依据：结构化索引已建立渠道与域名组的映射关系。",
        ].filter(Boolean);
        const answer = lines.join("\n");

        return {
          answer,
          sources: [
            buildStructuredAnswerSource(knowledge.documentId, answer),
            ...sources,
          ],
          debugLabel: "structured_domain_group",
        };
      }
    }
  }

  return null;
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

  const rewritten = rewriteQuestion(question);
  const intent = parseQuestionIntent(rewritten.normalized);
  const structured = await lookupStructuredKnowledge(rewritten.normalized, scopedDocuments);

  if (structured) {
    return {
      sources: structured.sources,
      steps: [
        {
          tool: "lookup_channel",
          summary: `先走结构化查询，命中 ${structured.debugLabel}`,
        },
      ],
      shouldAnswer: true,
      debug: {
        questionType: intent.kind === "overview" ? "overview" : "direct",
        intentKind: intent.kind,
        answerMode: intent.answerMode,
        queryRewrite: rewritten.normalized !== question.trim() ? rewritten.normalized : null,
        lookupMode: "structured",
        structuredHitKind: structured.debugLabel,
        environment: intent.environment,
        targetField: intent.targetField,
        hitCount: structured.sources.length,
        strongHitCount: structured.sources.length,
        topScore: structured.sources[0]?.score ?? null,
        topSourceFilename: structured.sources[0]?.filename ?? null,
        refusalReason: null,
      },
    };
  }

  const rankedResults = rerankResultsForQuestion(
    intent,
    await rankDocumentsInScope(scopedDocuments, rewritten.normalized),
  );
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
    sources.length > 0 && (hasStrongDirectEvidence || intent.kind === "overview");

  if (!shouldAnswer && intent.kind !== "overview") {
    steps.push({
      tool: "search_documents",
      summary: "当前命中证据较弱，后续回答会更保守，必要时明确说明无法确认",
    });
  }

  if ((sources.length === 0 || !hasStrongDirectEvidence) && intent.kind === "overview") {
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
    shouldAnswer: sources.length > 0 && (shouldAnswer || intent.kind === "overview"),
    debug: {
      questionType: intent.kind === "overview" ? "overview" : "direct",
      intentKind: intent.kind,
      answerMode: intent.answerMode,
      queryRewrite: rewritten.normalized !== question.trim() ? rewritten.normalized : null,
      lookupMode: "text",
      structuredHitKind: null,
      environment: intent.environment,
      targetField: intent.targetField,
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
  const intent = parseQuestionIntent(question);
  const concreteUrlInstruction = intent.wantsConcreteUrl
    ? "如果问题在问首页地址、完整链接、href 或具体路径，优先返回文档里出现的完整 URL；只有文档没有完整 URL 时，才说明只有域名/规则，不能擅自补路径。"
    : intent.answerMode === "rule"
      ? "如果问题在问规则、域名或环境映射，优先总结规则本身，不要把域名规则误答成具体页面地址。"
      : "如果问题在问具体值，优先返回文档里最直接、最完整的那一条，不要用泛规则替代具体结果。";

  return [
    {
      role: "system" as const,
      content:
        `你是一个文档问答助手。基于给定工具结果回答，先给结论，再给简短依据。遇到统计、数量、列举、总结类问题，要从证据里归纳、去重并计数；如果证据不足，要明确说明口径和不确定性，不要编造。${concreteUrlInstruction}`,
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

function buildFallbackDebug(question: string, hitCount: number, topSourceFilename: string | null) {
  const intent = parseQuestionIntent(question);

  return {
    questionType: intent.kind === "overview" ? "overview" : "direct",
    intentKind: intent.kind,
    answerMode: intent.answerMode,
    queryRewrite: null,
    lookupMode: "text",
    structuredHitKind: null,
    environment: intent.environment,
    targetField: intent.targetField,
    hitCount,
    strongHitCount: hitCount,
    topScore: null,
    topSourceFilename,
    refusalReason: hitCount > 0 ? null : "no_hits",
  } satisfies AgentPlanResult["debug"];
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
        debug: buildFallbackDebug(
          question,
          collectedSources.size,
          Array.from(collectedSources.values())[0]?.filename ?? null,
        ),
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
      debug: buildFallbackDebug(question, 0, null),
    };
  }

  return {
    sources: Array.from(collectedSources.values()).slice(0, 4),
    steps,
    shouldAnswer: true,
    debug: buildFallbackDebug(
      question,
      collectedSources.size,
      Array.from(collectedSources.values())[0]?.filename ?? null,
    ),
  };
}

export async function streamFinalAnswer(
  question: string,
  sources: SearchResult[],
  onDelta: (chunk: string) => void,
) {
  const structuredAnswerSource = sources.find((source) =>
    source.filename.endsWith(".structured-answer"),
  );
  if (structuredAnswerSource?.excerpt) {
    onDelta(structuredAnswerSource.excerpt);
    return structuredAnswerSource.excerpt;
  }

  const intent = parseQuestionIntent(question);
  const extracted = extractAnswerFromSources(intent, sources);

  if (intent.wantsConcreteUrl && extracted?.valueType === "full_url" && extracted.value) {
    const answer = `结论：${extracted.value}\n依据：命中片段里给出了 ${intent.environment || ""} 环境的完整首页链接。`;
    onDelta(answer);
    return answer;
  }

  if (intent.wantsConcreteUrl && extracted?.valueType === "domain_rule" && extracted.value) {
    const answer = `结论：文档里当前只明确给出了域名规则 ${extracted.value}，没有足够证据确认完整首页路径。\n依据：命中片段展示的是环境域名映射，而不是完整 URL。`;
    onDelta(answer);
    return answer;
  }

  if (extracted?.valueType === "domain_group") {
    const answer = formatDomainGroupAnswer(extracted);
    onDelta(answer);
    return answer;
  }

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
  const structuredAnswerSource = sources.find((source) =>
    source.filename.endsWith(".structured-answer"),
  );
  if (structuredAnswerSource?.excerpt) {
    return structuredAnswerSource.excerpt;
  }

  const intent = parseQuestionIntent(question);
  const extracted = extractAnswerFromSources(intent, sources);

  if (intent.wantsConcreteUrl && extracted?.valueType === "full_url" && extracted.value) {
    return `结论：${extracted.value}\n依据：命中片段里给出了 ${intent.environment || ""} 环境的完整首页链接。`;
  }

  if (intent.wantsConcreteUrl && extracted?.valueType === "domain_rule" && extracted.value) {
    return `结论：文档里当前只明确给出了域名规则 ${extracted.value}，没有足够证据确认完整首页路径。\n依据：命中片段展示的是环境域名映射，而不是完整 URL。`;
  }

  if (extracted?.valueType === "domain_group") {
    return formatDomainGroupAnswer(extracted);
  }

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
