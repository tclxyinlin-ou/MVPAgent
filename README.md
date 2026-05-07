# MVPAgent

# 文档问答 MVP

这是一个最小可用的“根据文档回答问题”的网页项目。当前版本聚焦单知识库问答，目标是先验证这件事：

- 用户上传文档后，系统能不能基于文档内容答准
- 回答时能不能带回命中的原文片段
- 面对缺少证据的问题，能不能明确说不知道

## 当前能力

- 上传 `pdf / doc / docx / txt / md`
- 本地解析文档正文并切片
- 本地检索相关片段
- 使用兼容 OpenAI `chat/completions` 的模型生成回答
- 在页面展示答案和命中的文档片段
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

## 默认示例文档

页面里的“导入示例文档”按钮会导入：

`/Users/yinlin/Desktop/AI/MVPAI/国际站多渠道环境.docx`

## 目录说明

- `app/page.tsx`: 首页 UI
- `app/api/upload/route.ts`: 文档上传和本地索引
- `app/api/ask/route.ts`: 本地检索 + 模型回答
- `app/api/status/route.ts`: 查询知识库状态
- `lib/openai.ts`: OpenAI 兼容模型接入和本地解析逻辑
- `lib/store.ts`: 本地状态存储

## 已知限制

- 现在是单知识库模式
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
