"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useTransition } from "react";

const RichDocumentEditor = dynamic(() => import("./components/RichDocumentEditor"), {
  ssr: false,
});

type IndexedDocument = {
  id: string;
  filename: string;
  uploadedAt: string;
  source: "upload" | "workspace";
  markdownPath?: string;
};

type StatusResponse = {
  ok: boolean;
  documents: (IndexedDocument & { chunkCount?: number })[];
};

type AskResponse = {
  ok: boolean;
  answer?: string;
  error?: string;
  steps?: Array<{
    tool: string;
    summary: string;
  }>;
  sources?: Array<{
    filename: string;
    score: number | null;
    excerpt: string;
  }>;
};

type StreamEvent =
  | {
      type: "steps";
      steps?: AskResponse["steps"];
    }
  | {
      type: "sources";
      sources?: AskResponse["sources"];
    }
  | {
      type: "answer";
      delta?: string;
    }
  | {
      type: "error";
      error?: string;
    }
  | {
      type: "done";
    };

const SAMPLE_DOC_PATH =
  "/Users/yinlin/Desktop/AI/MVPAI/国际站多渠道环境.docx";

const SAMPLE_QUESTIONS = [
  "10219 港版支付宝的 uat 首页地址是什么？",
  "hopegooAPP 普通订单详情链接需要哪些参数？",
  "985 国际站 M 站支持什么币种？",
  "20002 hopegooPC 有没有抢票订单详情？",
];

const ASK_TIMEOUT_MS = 45000;

function normalizeRichTextForDirtyCheck(html: string) {
  return html
    .replace(/\sdata-outline-id="[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .trim();
}

export default function HomePage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [pendingDeleteDocumentId, setPendingDeleteDocumentId] = useState<string | null>(null);
  const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0]);
  const [answer, setAnswer] = useState("");
  const [steps, setSteps] = useState<AskResponse["steps"]>([]);
  const [sources, setSources] = useState<AskResponse["sources"]>([]);
  const [markdownContent, setMarkdownContent] = useState("");
  const [richTextContent, setRichTextContent] = useState("");
  const [savedRichTextContent, setSavedRichTextContent] = useState("");
  const [isEditorDirty, setIsEditorDirty] = useState(false);
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false);
  const [isEditorLoading, setIsEditorLoading] = useState(false);
  const [isSavingMarkdown, setIsSavingMarkdown] = useState(false);
  const [notice, setNotice] = useState("先导入文档，再开始问答。");
  const [isStreaming, setIsStreaming] = useState(false);
  const [toast, setToast] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoreEditorChangeRef = useRef(false);
  const acceptInitialEditorHtmlRef = useRef(false);
  const savedRichTextContentRef = useRef("");

  function showToast(kind: "error" | "success", message: string) {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }

    setToast({ kind, message });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 3200);
  }

  async function loadStatus() {
    const res = await fetch("/api/status");
    const data = (await res.json()) as StatusResponse;
    setStatus(data);
    setActiveDocumentId((current) => {
      if (current && data.documents.some((document) => document.id === current)) {
        return current;
      }
      return data.documents[0]?.id || null;
    });
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    if (!activeDocumentId) {
      setMarkdownContent("");
      setRichTextContent("");
      setSavedRichTextContent("");
      savedRichTextContentRef.current = "";
      acceptInitialEditorHtmlRef.current = false;
      setIsEditorDirty(false);
      return;
    }

    const documentId = activeDocumentId;

    let cancelled = false;

    async function loadDocumentMarkdown() {
      setIsEditorLoading(true);

      try {
        const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
        const data = (await res.json()) as {
          ok: boolean;
          error?: string;
          document?: {
            content: string;
            htmlContent: string;
          };
        };

        if (!res.ok || !data.ok || !data.document) {
          throw new Error(data.error || "读取 Markdown 失败。");
        }

        if (!cancelled) {
          ignoreEditorChangeRef.current = true;
          acceptInitialEditorHtmlRef.current = true;
          const nextHtml = data.document.htmlContent || "<p></p>";
          setMarkdownContent(data.document.content);
          setRichTextContent(nextHtml);
          setSavedRichTextContent(nextHtml);
          savedRichTextContentRef.current = nextHtml;
          setIsEditorDirty(false);
          window.setTimeout(() => {
            ignoreEditorChangeRef.current = false;
          }, 250);
          window.setTimeout(() => {
            acceptInitialEditorHtmlRef.current = false;
          }, 1200);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "读取 Markdown 失败。";
          showToast("error", message);
        }
      } finally {
        if (!cancelled) {
          setIsEditorLoading(false);
        }
      }
    }

    void loadDocumentMarkdown();

    return () => {
      cancelled = true;
    };
  }, [activeDocumentId]);

  async function importSampleDocument() {
    if (isPending) {
      return;
    }

    setNotice("正在导入当前目录里的示例文档并建立索引，这一步会稍慢。");

    const res = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        samplePath: SAMPLE_DOC_PATH,
      }),
    });

    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      documentId?: string;
    };

    if (!data.ok) {
      setNotice(data.error || "示例文档导入失败。");
      showToast("error", data.error || "示例文档导入失败。");
      return;
    }

    setNotice("示例文档已进入知识库，可以开始提问。");
    showToast("success", "示例文档导入成功。");
    await loadStatus();
    if (data.documentId) {
      setActiveDocumentId(data.documentId);
    }
  }

  async function handleFileChange(file: File | null) {
    if (!file) {
      return;
    }

    setNotice(`正在上传 ${file.name} 并建立索引。`);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = (await res.json()) as {
      ok: boolean;
      error?: string;
      documentId?: string;
    };

    if (!data.ok) {
      setNotice(data.error || "文件上传失败。");
      showToast("error", data.error || "文件上传失败。");
      return;
    }

    setNotice(`${file.name} 已进入知识库。`);
    showToast("success", `${file.name} 上传成功。`);
    await loadStatus();
    if (data.documentId) {
      setActiveDocumentId(data.documentId);
    }
  }

  async function saveMarkdown() {
    if (!activeDocumentId || isSavingMarkdown) {
      return;
    }

    const documentId = activeDocumentId;

    setIsSavingMarkdown(true);

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: markdownContent,
          htmlContent: richTextContent,
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        chunkCount?: number;
      };

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "保存 Markdown 失败。");
      }

      savedRichTextContentRef.current = richTextContent;
      setSavedRichTextContent(richTextContent);
      ignoreEditorChangeRef.current = true;
      setIsEditorDirty(false);
      window.setTimeout(() => {
        ignoreEditorChangeRef.current = false;
      }, 0);
      setStatus((current) =>
        current
          ? {
              ...current,
              documents: current.documents.map((document) =>
                document.id === documentId
                  ? {
                      ...document,
                      chunkCount: data.chunkCount ?? document.chunkCount,
                    }
                  : document,
              ),
            }
          : current,
      );
      setNotice("Markdown 已保存，后续问答会基于最新内容。");
      showToast("success", "Markdown 保存成功。");
      await loadStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存 Markdown 失败。";
      setNotice(message);
      showToast("error", message);
    } finally {
      setIsSavingMarkdown(false);
    }
  }

  async function deleteDocument(documentId: string) {
    if (isPending || isSavingMarkdown || isStreaming) {
      return;
    }

    const target = status?.documents.find((document) => document.id === documentId);
    if (!target) {
      showToast("error", "文档不存在。");
      return;
    }

    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
        method: "DELETE",
      });

      const data = (await res.json()) as { ok: boolean; error?: string; deletedId?: string };

      if (!res.ok || !data.ok) {
        throw new Error(data.error || "删除文档失败。");
      }

      const remainingDocuments =
        status?.documents.filter((document) => document.id !== documentId) || [];

      setPendingDeleteDocumentId(null);
      setStatus((current) =>
        current
          ? {
              ...current,
              documents: current.documents.filter((document) => document.id !== documentId),
            }
          : current,
      );
      setActiveDocumentId(remainingDocuments[0]?.id || null);
      setNotice(`文档「${target.filename}」已删除。`);
      showToast("success", "文档删除成功。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除文档失败。";
      setNotice(message);
      showToast("error", message);
    }
  }

  function askQuestion(nextQuestion?: string) {
    if (isPending) {
      return;
    }

    const finalQuestion = (nextQuestion ?? question).trim();
    if (!finalQuestion) {
      setNotice("先输入一个问题。");
      showToast("error", "问题不能为空。");
      return;
    }

    if (!activeDocumentId) {
      setNotice("先选择一份文档。");
      showToast("error", "当前没有选中文档。");
      return;
    }

    if (isEditorDirty) {
      setNotice("当前 Markdown 有未保存修改。先保存，再提问。");
      showToast("error", "先保存 Markdown，再开始提问。");
      return;
    }

    startTransition(async () => {
      setNotice("正在检索文档并生成回答。");
      setAnswer("");
      setSteps([]);
      setSources([]);
      setToast(null);
      setIsStreaming(true);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, ASK_TIMEOUT_MS);

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: finalQuestion,
            documentId: activeDocumentId,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          let message = `接口请求失败（${res.status}）。`;

          try {
            const errorPayload = (await res.json()) as AskResponse;
            if (errorPayload.error) {
              message = errorPayload.error;
            }
          } catch {
            // Ignore parsing failure and keep the generic message.
          }

          setNotice(message);
          showToast("error", message);
          setIsStreaming(false);
          return;
        }

        if (!res.body) {
          const message = "接口没有返回可读取的数据流。";
          setNotice(message);
          showToast("error", message);
          setIsStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedAnswer = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            const event = JSON.parse(trimmed) as StreamEvent;

            if (event.type === "steps") {
              setSteps(event.steps || []);
              continue;
            }

            if (event.type === "sources") {
              setSources(event.sources || []);
              continue;
            }

            if (event.type === "answer") {
              if (event.delta) {
                receivedAnswer = true;
                setAnswer((current) => current + event.delta);
              }
              continue;
            }

            if (event.type === "error") {
              const message = event.error || "提问失败。";
              setNotice(message);
              showToast("error", message);
              setIsStreaming(false);
              return;
            }

            if (event.type === "done") {
              setNotice("回答已生成。");
              setIsStreaming(false);
            }
          }
        }

        if (!receivedAnswer) {
          const message = "没有收到模型返回内容。";
          setNotice(message);
          showToast("error", message);
          setIsStreaming(false);
          return;
        }

        setNotice("回答已生成。");
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === "AbortError"
            ? "请求超时了，当前模型响应较慢。你可以稍后重试，或把问题问得更具体一些。"
            : error instanceof Error
              ? error.message
              : "提问失败。";

        setNotice(message);
        showToast("error", message);
        setIsStreaming(false);
      } finally {
        clearTimeout(timeoutId);
      }
    });
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">MVP AI Console</span>
        </div>
        <div className="topbar-meta">
          <span>文档问答</span>
          <span>Agent Mode</span>
          <span>MiMo Compatible</span>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Document QA MVP</span>
          <h1>把内部文档，变成能直接提问的知识工作台。</h1>
          <p>
            这版不是泛聊天，而是一个面向业务文档的问答中台。先检索证据，再生成回答，并把命中的片段一起带回来。
          </p>
        </div>

        <div className="hero-grid">
          <div className="hero-metric">
            <span>当前状态</span>
            <strong>{status?.documents.length ? "已可用" : "待导入"}</strong>
            <p>先导入文档，再开始问答验证。</p>
          </div>
          <div className="hero-metric">
            <span>知识片段</span>
            <strong>
              {status?.documents.reduce((sum, item) => sum + (item.chunkCount || 0), 0) ?? 0}
            </strong>
            <p>本地切片检索，不依赖托管向量库。</p>
          </div>
          <div className="hero-metric accent">
            <span>回答模式</span>
            <strong>Evidence First</strong>
            <p>先决定调用工具，再基于证据回答。</p>
          </div>
        </div>
      </section>

      <section className="layout">
        <aside className="panel">
          <div className="panel-inner">
            <div>
              <h2>知识库状态</h2>
              <p className="muted tiny">
                当前支持多文档切换。提问只会命中你选中的那一份文档。
              </p>
            </div>

            <div className="stat-grid">
              <div className="stat-card">
                <strong>{status?.documents.length ?? 0}</strong>
                <span className="muted tiny">已索引文档数</span>
              </div>
              <div className="stat-card">
                <strong>
                  {status?.documents.reduce((sum, item) => sum + (item.chunkCount || 0), 0) ?? 0}
                </strong>
                <span className="muted tiny">本地检索片段数</span>
              </div>
            </div>

            <div className="ops-strip">
              <div className="ops-dot" />
              <span>
                当前工作区：
                {activeDocumentId
                  ? ` 已选中文档`
                  : " 还没有选中文档"}
              </span>
            </div>

            <div className="actions">
              <button className="button" onClick={importSampleDocument}>
                导入示例文档
              </button>
              <label className="upload-label">
                上传新文档
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.md"
                  onChange={(event) =>
                    void handleFileChange(event.target.files?.[0] || null)
                  }
                />
              </label>
            </div>

            <div className="status">{notice}</div>

            <div>
              <div className="section-head">
                <h3>文档分类</h3>
                <span className="muted tiny">
                  {status?.documents.length ? `${status.documents.length} 个 tab` : "暂无文档"}
                </span>
              </div>
              <div className="tab-list">
                {status?.documents.length ? (
                  status.documents.map((document) => (
                    <button
                      key={document.id}
                      type="button"
                      className={`doc-tab ${
                        activeDocumentId === document.id ? "doc-tab-active" : ""
                      }`}
                      disabled={isPending || isStreaming}
                      onClick={() => setActiveDocumentId(document.id)}
                    >
                      <span>{document.filename}</span>
                    </button>
                  ))
                ) : (
                  <div className="doc-item">
                    <strong>还没有文档</strong>
                    <span className="muted tiny">先上传文档，系统会自动生成 tab。</span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h3>已导入文档</h3>
              <div className="doc-list">
                {status?.documents.length ? (
                  status.documents.map((document) => (
                    <div
                      className={`doc-item ${
                        activeDocumentId === document.id ? "doc-item-active" : ""
                      }`}
                      key={document.id}
                    >
                      <div className="doc-item-top">
                        <strong>{document.filename}</strong>
                        <div className="doc-item-actions">
                          <span className="doc-chip">
                            {document.source === "workspace" ? "示例文档" : "上传文档"}
                          </span>
                          <button
                            type="button"
                            className="doc-chip doc-chip-danger"
                            disabled={isPending || isSavingMarkdown || isStreaming}
                            onClick={() => setPendingDeleteDocumentId(document.id)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                      <div className="doc-meta">
                        <span className="muted tiny">{document.chunkCount || 0} 个片段</span>
                        <span className="muted tiny">
                          {new Date(document.uploadedAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="doc-item">
                    <strong>还没有文档</strong>
                    <span className="muted tiny">
                      先导入 `国际站多渠道环境.docx` 再提问。
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h3>敏感信息提醒</h3>
              <p className="muted tiny">
                导入后系统会在本地保存一份可编辑 Markdown。你修正文档内容后，问答会优先读取这份 `.md`。
              </p>
            </div>
          </div>
        </aside>

        <section className="panel">
          <div className="panel-inner">
            <div>
              <h2>问答面板</h2>
              <p className="muted tiny">
                回答目标是“先用工具查证，再给出可追溯结论”，并且只针对当前 tab 文档，不是泛化闲聊。
              </p>
            </div>

            <div className="active-doc-banner">
              <span className="muted tiny">当前提问文档</span>
              <strong>
                {status?.documents.find((document) => document.id === activeDocumentId)
                  ?.filename || "未选择文档"}
              </strong>
            </div>

            <div className="button-row">
              {SAMPLE_QUESTIONS.map((item) => (
                <button
                  className="ghost-button"
                  key={item}
                  onClick={() => {
                    setQuestion(item);
                    askQuestion(item);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>

            <textarea
              className="textarea"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="例如：10219 港版支付宝的 uat 首页地址是什么？"
            />

            <div className="actions">
              <button
                className="button"
                onClick={() => askQuestion()}
                disabled={
                  isPending || isSavingMarkdown || isEditorDirty
                }
              >
                {isPending ? "回答中..." : "开始提问"}
              </button>
            </div>

            {isEditorDirty ? (
              <div className="status">
                当前 Markdown 有未保存修改。先保存，再提问，避免问答仍基于旧内容。
              </div>
            ) : null}

            <div className="chat-output">
              <div className="answer-shell">
                <div className="answer-header">
                  <span className="answer-label">Answer</span>
                  <span className="muted tiny">
                    {isStreaming ? "流式生成中..." : "基于检索证据生成"}
                  </span>
                </div>
                <div className="answer">
                  {answer ? (
                    <>
                      {answer}
                      {isStreaming ? <span className="stream-caret" aria-hidden="true" /> : null}
                    </>
                  ) : isStreaming ? (
                    <div className="loading-state">
                      <div className="loading-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div>
                        <strong>正在整理答案</strong>
                        <p className="muted tiny">
                          先检索文档片段，再调用模型生成结论。
                        </p>
                      </div>
                    </div>
                  ) : (
                    "答案会显示在这里。第一版重点是答复准确和带出处。"
                  )}
                </div>
              </div>

              <div className="panel md-editor-panel">
                <div className="panel-inner">
                  <div className="section-head">
                    <div>
                      <h3>Markdown 编辑器</h3>
                      <p className="muted tiny">
                        直接修改当前 tab 文档的 `.md`，保存后问答立即基于新内容。
                      </p>
                    </div>
                    <div className="actions">
                      <button
                        className="ghost-button collapse-button"
                        type="button"
                        onClick={() => setIsEditorCollapsed((current) => !current)}
                        aria-expanded={!isEditorCollapsed}
                      >
                        {isEditorCollapsed ? "展开编辑器" : "折叠编辑器"}
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => {
                          ignoreEditorChangeRef.current = true;
                          setRichTextContent(savedRichTextContent);
                          setIsEditorDirty(false);
                          window.setTimeout(() => {
                            ignoreEditorChangeRef.current = false;
                          }, 0);
                        }}
                        disabled={
                          isEditorLoading ||
                          isSavingMarkdown ||
                          !isEditorDirty
                        }
                      >
                        撤销修改
                      </button>
                      <button
                        className="button"
                        type="button"
                        onClick={() => void saveMarkdown()}
                        disabled={
                          !activeDocumentId ||
                          isEditorLoading ||
                          isSavingMarkdown ||
                          !isEditorDirty
                        }
                      >
                        {isSavingMarkdown ? "保存中..." : "保存 Markdown"}
                      </button>
                    </div>
                  </div>

                  {isEditorCollapsed ? (
                    <div className="md-editor-collapsed">
                      <strong>{isEditorDirty ? "有未保存修改" : "编辑器已折叠"}</strong>
                      <span className="muted tiny">
                        {isEditorDirty
                          ? "展开后可继续编辑，或直接保存当前修改。"
                          : "点击展开编辑器继续查看和修改 Markdown。"}
                      </span>
                    </div>
                  ) : isEditorLoading ? (
                    <div className="loading-state">
                      <div className="loading-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div>
                        <strong>正在加载文档</strong>
                        <p className="muted tiny">读取当前文档对应的 Markdown 内容。</p>
                      </div>
                    </div>
                  ) : (
                    <div className="md-editor-wrap">
                      <RichDocumentEditor
                        value={richTextContent}
                        disabled={isSavingMarkdown || isPending || isStreaming}
                        onChange={({ html }) => {
                          setRichTextContent(html);
                          if (acceptInitialEditorHtmlRef.current) {
                            acceptInitialEditorHtmlRef.current = false;
                            savedRichTextContentRef.current = html;
                            setSavedRichTextContent(html);
                            setIsEditorDirty(false);
                            return;
                          }

                          if (ignoreEditorChangeRef.current) {
                            return;
                          }
                          setIsEditorDirty(
                            normalizeRichTextForDirtyCheck(html) !==
                              normalizeRichTextForDirtyCheck(savedRichTextContentRef.current),
                          );
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="section-head">
                  <h3>Agent 步骤</h3>
                  <span className="muted tiny">
                    {steps?.length ? `${steps.length} 步` : "等待执行"}
                  </span>
                </div>
                <div className="source-list">
                  {steps?.length ? (
                    steps.map((step, index) => (
                      <div className="source-card" key={`${step.tool}-${index}`}>
                        <div className="source-top">
                          <strong>{step.tool}</strong>
                          <span className="score-pill">step {index + 1}</span>
                        </div>
                        <p>{step.summary}</p>
                      </div>
                    ))
                  ) : (
                    <div className="source-card">
                      <strong>暂无步骤</strong>
                      <span className="muted tiny">
                        发起提问后，这里会显示 agent 的工具调用过程。
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <div className="section-head">
                  <h3>命中片段</h3>
                  <span className="muted tiny">
                    {sources?.length ? `${sources.length} 条证据` : "等待检索结果"}
                  </span>
                </div>
                <div className="source-list">
                  {sources?.length ? (
                    sources.map((source, index) => (
                      <div className="source-card" key={`${source.filename}-${index}`}>
                        <div className="source-top">
                          <strong>{source.filename}</strong>
                          <span className="score-pill">
                            {source.score !== null
                              ? `score ${source.score.toFixed(0)}`
                              : "score n/a"}
                          </span>
                        </div>
                        <p>{source.excerpt || "没有返回可展示的片段。"}</p>
                      </div>
                    ))
                  ) : (
                    <div className="source-card">
                      <strong>暂无命中片段</strong>
                      <span className="muted tiny">
                        问答完成后，这里会显示检索回来的原文证据。
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </section>

      {toast ? (
        <div className={`toast toast-${toast.kind}`} role="status" aria-live="polite">
          <span className="toast-mark">{toast.kind === "error" ? "!" : "✓"}</span>
          <span>{toast.message}</span>
        </div>
      ) : null}

      {pendingDeleteDocumentId ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-card">
            <h3>确认删除文档</h3>
            <p className="muted">
              将删除当前文档、本地 Markdown 和富文本内容。这个操作不能恢复。
            </p>
            <div className="confirm-target">
              {
                status?.documents.find((document) => document.id === pendingDeleteDocumentId)
                  ?.filename
              }
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setPendingDeleteDocumentId(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteDocument(pendingDeleteDocumentId)}
              >
                二次确认删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
