import { access, mkdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";

export type DomainEnvironmentMap = Partial<
  Record<"qa" | "uat" | "pre" | "pre2" | "prod", string>
>;

export type StructuredChannel = {
  key: string;
  id?: string;
  aliases: string[];
};

export type StructuredDomainGroup = {
  name: string;
  aliases: string[];
  channels: StructuredChannel[];
  environments: DomainEnvironmentMap;
};

export type StructuredUrlExample = {
  channelKey: string;
  environment: "qa" | "uat" | "pre" | "pre2" | "prod" | null;
  pageType: "homepage" | "order_detail" | "grab_order" | "other";
  url: string;
};

export type StructuredKnowledgeDocument = {
  documentId: string;
  updatedAt: string;
  domainGroups: StructuredDomainGroup[];
  urlExamples: StructuredUrlExample[];
};

const DATA_DIR = path.join(process.cwd(), ".mvp-docs");
const ENTITY_DIR = path.join(DATA_DIR, "entities");

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9._-\u4e00-\u9fa5]/g, "_");
}

function normalizeToken(value: string) {
  return value
    .toLowerCase()
    .replace(/[（(]/g, "(")
    .replace(/[）)]/g, ")")
    .replace(/[\s_\-:/\\，。、；;：'"`~!@#$%^&*+=?<>[\]{}|]+/g, "");
}

function splitChannelEntries(raw: string) {
  return raw
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDomainValue(raw: string) {
  const linkMatch = raw.match(/\((https?:\/\/[^)\s]+)\)/i);
  if (linkMatch?.[1]) {
    return linkMatch[1];
  }

  const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  if (urlMatch?.[0]) {
    return urlMatch[0];
  }

  const bareDomainMatch = raw.match(/www\d?\.[a-z0-9.-]+\.[a-z]{2,}/i);
  if (bareDomainMatch?.[0]) {
    return bareDomainMatch[0];
  }

  const cnDomainMatch = raw.match(/[a-z0-9.-]+\.(?:cn|com)/i);
  if (cnDomainMatch?.[0]) {
    return cnDomainMatch[0];
  }

  return null;
}

function inferEnvironmentFromUrl(url: string): StructuredUrlExample["environment"] {
  const normalized = url.toLowerCase();
  if (/www\.qa\.|train\.qa\./.test(normalized)) {
    return "qa";
  }
  if (/www\.uat\.|train\.uat\./.test(normalized)) {
    return "uat";
  }
  if (/www2\.t\.|train2\.t\./.test(normalized)) {
    return "pre2";
  }
  if (/www\.t\.|train\.t\./.test(normalized)) {
    return "pre";
  }
  if (/www\.hopegoo\.com|www\.travelgo\.com|train\.17u\.cn/.test(normalized)) {
    return "prod";
  }

  return null;
}

function inferPageTypeFromUrl(url: string): StructuredUrlExample["pageType"] {
  if (/#\/index(?:$|\?)/i.test(url)) {
    return "homepage";
  }
  if (/#\/orderdetail(?:$|\?)/i.test(url)) {
    return "order_detail";
  }
  if (/#\/graborderdetail(?:$|\?)/i.test(url)) {
    return "grab_order";
  }

  return "other";
}

function inferChannelKeyFromUrl(url: string) {
  const directMatch = url.match(/\/trainintlfe\/([^/?#]+)\/#/i);
  if (directMatch?.[1]) {
    return directMatch[1];
  }

  const altMatch = url.match(/\/([^/?#]+)\/wx\/#/i);
  if (altMatch?.[1]) {
    return altMatch[1];
  }

  return null;
}

function dedupeStrings(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function addAlias(
  aliasMap: Map<string, Set<string>>,
  key: string,
  aliases: string[],
) {
  const bucket = aliasMap.get(key) || new Set<string>();
  for (const alias of aliases) {
    if (alias?.trim()) {
      bucket.add(alias.trim());
    }
  }
  aliasMap.set(key, bucket);
}

function buildChannelAliasMap(markdown: string) {
  const aliasMap = new Map<string, Set<string>>();
  const lines = markdown.split("\n").map((line) => line.trim());

  for (const line of lines) {
    const match = line.match(/^([^#\s][^：:]{1,40})[：:]\s*([A-Za-z][A-Za-z0-9]+)\s*$/);
    if (!match) {
      continue;
    }

    const displayName = match[1].trim();
    const key = match[2].trim();
    addAlias(aliasMap, key, [displayName, key]);
  }

  for (const line of lines) {
    const idPrefixMatch = line.match(/^(\d{3,6})\s+(.+)$/);
    if (idPrefixMatch) {
      const [, id, displayName] = idPrefixMatch;
      addAlias(aliasMap, id, [id, displayName.trim()]);
    }

    const idSuffixMatch = line.match(/^(.+?)[（(](\d{3,6})[)）]$/);
    if (idSuffixMatch) {
      const [, displayName, id] = idSuffixMatch;
      addAlias(aliasMap, id, [id, displayName.trim()]);
    }
  }

  // Generic business aliases for known path keys or common naming variants.
  addAlias(aliasMap, "982", ["weixin", "wx", "微信多语言", "微信国际站", "国际站微信渠道"]);
  addAlias(aliasMap, "985", ["touch", "国际站M站", "TravelGoM站", "国际M站"]);
  addAlias(aliasMap, "10219", ["alipay", "香港支付宝", "港版支付宝"]);
  addAlias(aliasMap, "20000", ["intlApp", "hopegooAPP"]);
  addAlias(aliasMap, "20003", ["hopegooTouch", "hopegooM站", "海外版M站"]);
  addAlias(aliasMap, "20004", ["wechatHK", "HG HopeGoo - 微信"]);
  addAlias(aliasMap, "20014", ["octopus", "八达通"]);
  addAlias(aliasMap, "20017", ["aliPayCN", "Alipay CN", "alipayCN"]);

  return aliasMap;
}

export function buildStructuredKnowledgeDocument(documentId: string, markdown: string) {
  const channelAliasMap = buildChannelAliasMap(markdown);
  const channelIdToKey = new Map<string, string>();
  const lines = markdown.split("\n");
  const groups: StructuredDomainGroup[] = [];
  const urls = Array.from(new Set(markdown.match(/https?:\/\/[^\s)\]]+/gi) || []));
  let currentGroup: StructuredDomainGroup | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1].trim();
      const groupHeadingMatch = heading.match(/^(Hopegoo|Travelgo|17u)\s*域名[：:]?$/i);
      if (groupHeadingMatch) {
        currentGroup = {
          name: groupHeadingMatch[1],
          aliases: [groupHeadingMatch[1], `${groupHeadingMatch[1]}域名`],
          channels: [],
          environments: {},
        };
        groups.push(currentGroup);
      } else if (/域名/.test(heading)) {
        currentGroup = null;
      }
      continue;
    }

    if (!currentGroup) {
      continue;
    }

    const channelsMatch = line.match(/^渠道[：:]\s*(.+)$/i);
    if (channelsMatch) {
      const channels = splitChannelEntries(channelsMatch[1]).map((entry) => {
        const normalizedEntry = entry.replace(/\s+/g, "");
        const detailMatch = normalizedEntry.match(/^([A-Za-z][A-Za-z0-9]+)(?:\((\d+)\))?$/);
        const key = detailMatch?.[1] || normalizedEntry;
        const aliases = dedupeStrings([
          key,
          ...(channelAliasMap.get(key) ? Array.from(channelAliasMap.get(key) || []) : []),
          ...(detailMatch?.[2] && channelAliasMap.get(detailMatch[2])
            ? Array.from(channelAliasMap.get(detailMatch[2]) || [])
            : []),
          detailMatch?.[2] || "",
        ]);

        if (detailMatch?.[2]) {
          channelIdToKey.set(detailMatch[2], key);
        }

        return {
          key,
          id: detailMatch?.[2],
          aliases,
        } satisfies StructuredChannel;
      });
      currentGroup.channels = channels;
      continue;
    }

    const qaMatch = line.match(/^QA[：:]\s*(.+)$/i);
    if (qaMatch) {
      const value = parseDomainValue(qaMatch[1]);
      if (value) {
        currentGroup.environments.qa = value;
      }
      continue;
    }

    const uatMatch = line.match(/^UAT[：:]\s*(.+)$/i);
    if (uatMatch) {
      const value = parseDomainValue(uatMatch[1]);
      if (value) {
        currentGroup.environments.uat = value;
      }
      continue;
    }

    const pre2Match = line.match(/^(预发2|PRE2)[：:]\s*(.+)$/i);
    if (pre2Match) {
      const value = parseDomainValue(pre2Match[2]);
      if (value) {
        currentGroup.environments.pre2 = value;
      }
      continue;
    }

    const preMatch = line.match(/^(预发|PRE)[：:]\s*(.+)$/i);
    if (preMatch) {
      const value = parseDomainValue(preMatch[2]);
      if (value) {
        currentGroup.environments.pre = value;
      }
      continue;
    }

    const prodMatch = line.match(/^(生产|正式|PROD)[：:]\s*(.+)$/i);
    if (prodMatch) {
      const value = parseDomainValue(prodMatch[2]);
      if (value) {
        currentGroup.environments.prod = value;
      }
    }
  }

  const urlExamples: StructuredUrlExample[] = urls
    .map((url) => {
      const rawChannelKey = inferChannelKeyFromUrl(url);
      if (!rawChannelKey) {
        return null;
      }

      const normalizedRawKey = normalizeToken(rawChannelKey);
      const canonicalChannelKey =
        Array.from(channelIdToKey.entries()).find(([, key]) => normalizeToken(key) === normalizedRawKey)?.[1] ||
        Array.from(groups.flatMap((group) => group.channels)).find((channel) =>
          channel.aliases.some((alias) => normalizeToken(alias) === normalizedRawKey),
        )?.key ||
        rawChannelKey;

      return {
        channelKey: canonicalChannelKey,
        environment: inferEnvironmentFromUrl(url),
        pageType: inferPageTypeFromUrl(url),
        url,
      } satisfies StructuredUrlExample;
    })
    .filter(Boolean) as StructuredUrlExample[];

  return {
    documentId,
    updatedAt: new Date().toISOString(),
    domainGroups: groups.map((group) => ({
      ...group,
      aliases: dedupeStrings([
        group.name,
        ...group.aliases,
        ...group.channels.flatMap((channel) => channel.aliases),
      ]),
      channels: group.channels.map((channel) => ({
        ...channel,
        aliases: dedupeStrings(channel.aliases),
      })),
    })),
    urlExamples,
  } satisfies StructuredKnowledgeDocument;
}

async function ensureEntityDir() {
  await mkdir(ENTITY_DIR, { recursive: true });
}

function getKnowledgePath(documentId: string) {
  return path.join(ENTITY_DIR, `${sanitizeId(documentId)}.json`);
}

export async function saveStructuredKnowledgeDocument(documentId: string, markdown: string) {
  await ensureEntityDir();
  const knowledge = buildStructuredKnowledgeDocument(documentId, markdown);
  await writeFile(getKnowledgePath(documentId), JSON.stringify(knowledge, null, 2), "utf8");
  return knowledge;
}

export async function loadStructuredKnowledgeDocument(documentId: string) {
  try {
    const raw = await readFile(getKnowledgePath(documentId), "utf8");
    return JSON.parse(raw) as StructuredKnowledgeDocument;
  } catch {
    return null;
  }
}

export async function ensureStructuredKnowledgeDocument(
  documentId: string,
  markdownPath: string,
) {
  const existing = await loadStructuredKnowledgeDocument(documentId);
  if (existing) {
    return existing;
  }

  const markdown = await readFile(markdownPath, "utf8");
  return saveStructuredKnowledgeDocument(documentId, markdown);
}

export async function deleteStructuredKnowledgeDocument(documentId: string) {
  try {
    await access(getKnowledgePath(documentId));
    await unlink(getKnowledgePath(documentId));
  } catch {
    return;
  }
}
