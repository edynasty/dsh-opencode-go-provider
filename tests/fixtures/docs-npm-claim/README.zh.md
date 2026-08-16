# dsh-opencode-go-provider（负例 fixture）

本 fixture 是故意错误的 README，用于 docs-contract 负例测试：它声称 npm 可用，
其余内容看似合理。它必须使 docs 契约失败（`forbidden README.zh.md npm-install availability`）。

## 安装

该包已在 npm 上发布：

```sh
npm install dsh-opencode-go-provider
```

或者从 Git 安装：

```sh
dsh plugin --profile web add github:edynasty/dsh-opencode-go-provider#d2a447610a5dff4006ac966525effd9669342a78
```

## 功能

- 路由 `opencode-go`，`OPENCODE_GO_API_KEY` 在操作时经 DSH 凭据解析。
- 协议：`openai-responses`、`openai-completions`、`anthropic-messages`
  由 catalog 元数据选择，绝不按模型名前缀猜测。
- stale-while-revalidate 缓存：5 分钟新鲜度、60 分钟后台刷新、10 秒网络超时、
  原子缓存、离线回退、隔离与 14 天下架宽限期。

## 状态

本软件为社区软件，不隶属于 DeepSeek 或 OpenCode。
