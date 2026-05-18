# MVPAgent

# 文档问答 MVP

这是一个最小可用的“根据文档回答问题”的网页项目。当前版本聚焦单知识库问答，目标是先验证这件事：

- 用户上传文档后，系统能不能基于文档内容答准
- 回答时能不能带回命中的原文片段
- 面对缺少证据的问题，能不能明确说不知道
- 模型能不能先决定调用工具，再基于工具结果回答

## 当前能力

- 上传 `pdf / doc / docx / txt / md`
- 本地解析文档正文并切片
- 自动导出本地可编辑 Markdown
- 本地检索相关片段
- 多文档 tab 切换，提问只针对当前文档
- 使用兼容 OpenAI `chat/completions` 的模型驱动轻量 Agent 循环
- 页面内可直接设置 `OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL`，并切换当前模型
- 在页面展示答案和命中的文档片段
- 展示 Agent 的工具调用步骤
- 内置导入当前目录示例文档按钮

## 本地启动

1. 安装依赖

```bash
npm install
```

2. 配置环境变量

```bash
cp .env.example .env
```

填入：

```bash
OPENAI_API_KEY=你的key
OPENAI_BASE_URL=你的兼容接口地址
OPENAI_MODEL=你的模型名
```

当前默认示例已经配置成：

```bash
OPENAI_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
OPENAI_MODEL=mimo-v2.5-pro
```

3. 启动开发环境

```bash
npm run dev
```

4. 打开浏览器

```text
http://localhost:3000
```

5. 在页面左侧的“模型设置”里维护：

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `可切换模型列表`

保存后，后续问答会直接走新的模型配置。

## 默认示例文档

页面里的“导入示例文档”按钮会导入：

`/Users/yinlin/Desktop/AI/MVPAI/国际站多渠道环境.docx`

导入后系统会在 `.mvp-docs/markdown/` 下生成对应的 `.md` 文件，后续你可以直接修改这份 Markdown，问答会优先读取修改后的内容。

## 目录说明

- `app/page.tsx`: 首页 UI
- `app/api/upload/route.ts`: 文档上传和本地索引
- `app/api/ask/route.ts`: 本地检索 + 模型回答
- `app/api/status/route.ts`: 查询知识库状态
- `app/api/model-config/route.ts`: 模型配置读取与保存
- `lib/openai.ts`: OpenAI 兼容模型接入和本地解析逻辑
- `lib/model-config.ts`: 运行时模型配置
- `.mvp-docs/markdown/`: 导出的可编辑 Markdown 文档
- `lib/store.ts`: 本地状态存储

## 已知限制

- 当前没有做文档分组、文件夹层级或权限隔离
- 没有用户体系和权限控制
- 没有对敏感字段做自动脱敏
- 没有多轮会话记忆
- 没有做图片 OCR
- PDF 还没接入本地解析

## 下一步建议

1. 增加文档元数据标签，比如 `渠道ID / 环境 / 平台 / 订单类型`
2. 在回答前先做结构化过滤检索，而不是整库搜
3. 对账号、密码、验证码做脱敏与权限控制
4. 增加会话记录和反馈按钮
5. 增加错误问题样本，做问答评测
