"use client";

import { useEffect, useRef, useState, useTransition } from "react";

type IndexedDocument = {
  id: string;
  filename: string;
  uploadedAt: string;
  source: "upload" | "workspace";
};

type StatusResponse = {
  ok: boolean;
  documents: (IndexedDocument & { chunkCount?: number })[];
};

type AskResponse = {
  ok: boolean;
  answer?: string;
  error?: string;
  sources?: Array<{
    filename: string;
    score: number | null;
    excerpt: string;
  }>;
};

const SAMPLE_DOC_PATH =
  "/Users/yinlin/Desktop/AI/MVPAI/国际站多渠道环境.docx";

const SAMPLE_QUESTIONS = [
  "10219 港版支付宝的 uat 首页地址是什么？",
  "hopegooAPP 普通订单详情链接需要哪些参数？",
  "985 国际站 M 站支持什么币种？",
  "20002 hopegooPC 有没有抢票订单详情？",
];

export default function HomePage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [question, setQuestion] = useState(SAMPLE_QUESTIONS[0]);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AskResponse["sources"]>([]);
  const [notice, setNotice] = useState("先导入文档，再开始问答。");
  const [toast, setToast] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }

  useEffect(() => {
    void loadStatus();
  }, []);

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

    const data = (await res.json()) as { ok: boolean; error?: string };

    if (!data.ok) {
      setNotice(data.error || "示例文档导入失败。");
      showToast("error", data.error || "示例文档导入失败。");
      return;
    }

    setNotice("示例文档已进入知识库，可以开始提问。");
    showToast("success", "示例文档导入成功。");
    await loadStatus();
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

    const data = (await res.json()) as { ok: boolean; error?: string };

    if (!data.ok) {
      setNotice(data.error || "文件上传失败。");
      showToast("error", data.error || "文件上传失败。");
      return;
    }

    setNotice(`${file.name} 已进入知识库。`);
    showToast("success", `${file.name} 上传成功。`);
    await loadStatus();
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

    startTransition(async () => {
      setNotice("正在检索文档并生成回答。");
      setAnswer("");
      setSources([]);
      setToast(null);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 25000);

      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            question: finalQuestion,
          }),
          signal: controller.signal,
        });

        const data = (await res.json()) as AskResponse;

        if (!data.ok) {
          const message = data.error || "提问失败。";
          setNotice(message);
          showToast("error", message);
          return;
        }

        setAnswer(data.answer || "没有生成答案。");
        setSources(data.sources || []);
        setNotice("回答已生成。");
      } catch (error) {
        const message =
          error instanceof DOMException && error.name === "AbortError"
            ? "请求超时了。可以稍后重试，或把问题问得更具体一些。"
            : error instanceof Error
              ? error.message
              : "提问失败。";

        setNotice(message);
        showToast("error", message);
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
            <p>优先给结论，再附命中文档依据。</p>
          </div>
        </div>
      </section>

      <section className="layout">
        <aside className="panel">
          <div className="panel-inner">
            <div>
              <h2>知识库状态</h2>
              <p className="muted tiny">
                当前是单知识库模式，适合先验证“能不能答准”。
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
              <span>当前工作区：单知识库模式</span>
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
              <h3>已导入文档</h3>
              <div className="doc-list">
                {status?.documents.length ? (
                  status.documents.map((document) => (
                    <div className="doc-item" key={document.id}>
                      <div className="doc-item-top">
                        <strong>{document.filename}</strong>
                        <span className="doc-badge">
                          {document.source === "workspace" ? "示例文档" : "上传文档"}
                        </span>
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
                你这份文档里包含测试账号、密码、验证码、代理 IP。第一版已经能回答这些内容，但正式上线前必须补权限和脱敏。
              </p>
            </div>
          </div>
        </aside>

        <section className="panel">
          <div className="panel-inner">
            <div>
              <h2>问答面板</h2>
              <p className="muted tiny">
                回答目标是“基于本地检索片段给出可追溯结论”，不是泛化闲聊。
              </p>
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
                disabled={isPending}
              >
                {isPending ? "回答中..." : "开始提问"}
              </button>
            </div>

            <div className="chat-output">
              <div className="answer-shell">
                <div className="answer-header">
                  <span className="answer-label">Answer</span>
                  <span className="muted tiny">
                    {isPending ? "模型正在生成..." : "基于检索证据生成"}
                  </span>
                </div>
                <div className="answer">
                  {isPending ? (
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
                    answer || "答案会显示在这里。第一版重点是答复准确和带出处。"
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
    </main>
  );
}
