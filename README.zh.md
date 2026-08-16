# dsh-opencode-go-provider

面向 DeepSeek Harness（DSH rc.6）的 OpenCode Go LLM provider 组合包：单个
`opencode-go` 模型路由接入 OpenCode Go 网关，附带 Web Connect 设置卡、
stale-while-revalidate 模型目录与安全的诊断命令。

> **状态：社区软件，未发布到 npm。** 本包以 commit-pinned Git 依赖的形式安装进
> DSH profile；npm registry **不是**安装途径。本包不隶属于、不受 DeepSeek、
> OpenCode 或任何模型供应商的背书或赞助。见 [LICENSE](LICENSE) 与
> [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 环境要求

- DeepSeek Harness **DSH rc.6**（本组合包面向 `0.1.0-rc.6` peer 图）。
- Node.js `^22.19.0 || >=24.0.0`。
- corepack 托管的 **pnpm 11.7.0**（若 `pnpm --version` 无法经 Corepack 解析，
  先执行 `corepack enable`）。
- 一个 OpenCode Go API key。该 key **仅在操作时**经 DSH credentials 服务以
  `OPENCODE_GO_API_KEY` 为 ref 存储与解析；绝不写入 settings、catalog、日志、
  错误信息或包内。

## 安装（Git，commit-pinned）

本包未发布到 npm；受支持的安装方式是 DSH **web** profile 的 commit-pinned
Git 依赖：

```sh
dsh plugin --profile web add github:edynasty/dsh-opencode-go-provider#d2a447610a5dff4006ac966525effd9669342a78
```

仓库已提交 `lib/`，因此 Git 安装无需构建步骤即可加载组合包。卸载会移除包及其
bundle 行：

```sh
dsh plugin --profile web remove dsh-opencode-go-provider
```

### 与 web base bundle 共存

web profile 的 base bundle（`@deepseek-ai/dsh-llm-pi-ai`）已在 provider 目录中
声明了 `opencode-go`（其目录原生包含该路由）。本包**采用**该已有条目而非重复
注册，并以自身 adapter（更丰富的 SWR catalog）、Connect 卡与 doctor 路由接管该
路由。与 base bundle 共存无需任何 profile 改动——特别是无需禁用 `llm-pi-ai`。

## 注册内容

- 唯一 provider 路由：**`opencode-go`**，由 `llm-opencode-go` bundle 行
  （`cordis.patch.yml`）挂载。
- 一个 settings namespace：`llm-opencode-go`（刷新间隔、新鲜度窗口、网络超时、
  下架宽限、credential ref）。
- 一张 Web Connect 设置卡（经 `dsh.client.inject` 注入），可连接、测试连接、
  运行诊断与断开。
- 独立 `bin`（`dsh plugin --profile web exec dsh-opencode-go-provider`）提供
  `status`、`doctor`、`migration-dry-run` 与 `migration-apply`。

## 模型目录与协议

内嵌目录（`catalog/models.json`）派生自 OpenCode 的 models.dev 元数据
（`https://models.opencode.ai/api.json`），只保留 `opencode-go` provider 记录。
每个模型从该元数据携带自己的协议，adapter 按模型分发，**绝不按模型名前缀猜测**：

| 协议 | 选择依据 |
| --- | --- |
| `openai-responses` | models.dev SDK 元数据映射到 `@ai-sdk/openai` 的模型 |
| `openai-completions` | 映射到 `@ai-sdk/openai-compatible` 的模型（默认类别） |
| `anthropic-messages` | 映射到 `@ai-sdk/anthropic` 的模型（base URL `https://opencode.ai/zen/go`） |

模型可用性通过实时端点 `https://opencode.ai/zen/go/v1/models` 检查，该端点
**只**贡献可用 id；协议、上下文、模态、成本与推理元数据一律以 models.dev 为准。

### 目录生命周期（stale-while-revalidate）

- **内嵌目录**启动即可用——离线且无需凭据。
- 后台刷新维护 **5 分钟新鲜度**窗口；窗口内的读取绝不触网。
- **60 分钟**周期刷新做再验证；过期读取调度一次 single-flight 后台刷新。
- 每次网络尝试受 **10 秒**超时约束。
- 刷新成功后**原子**写入缓存（同目录临时文件、`0600`、fsync、rename），路径为
  `$DSH_HOME/cache/dsh-opencode-go-provider/catalog.json`，随后才切换内存快照；
  进行中的请求保留其启动时的快照。
- **离线回退**：缓存缺失或损坏时以内嵌目录服务（`origin: embedded`/`corrupt`）；
  损坏文件绝不删除，失败也绝不覆盖 last-good 状态。
- **隔离（quarantine）**：有 live id 但无 models.dev 元数据时，以脱敏的可机读
  原因记录，绝不暴露为可调用模型。
- **14 天下架宽限**：models.dev 已知但 live 缺失的模型在 `deprecatedAt` 时间戳
  内仍可选；超过 14 天被驱逐（若回到 live 则复活）。

## Connect / status / doctor / disconnect

- **连接（Connect）**（Web 卡或 Host 路由）只把 key 存入 DSH credentials 服务
  的 `OPENCODE_GO_API_KEY`；key 绝不回显、回传或写入其他任何位置。
- **状态（status）**只输出脱敏事实：configured 是否、来源
  （embedded/cache/refreshed）、模型数、上次刷新、上次尝试、刷新成功/失败计数。
- **测试连接 / 诊断（doctor）**只执行一次带认证的
  `GET https://opencode.ai/zen/go/v1/models`，输出脱敏计数与固定错误码；
  绝不调用生成端点。
- **断开（disconnect）**只移除 `OPENCODE_GO_API_KEY` 这一个凭据。`opencode-go`
  路由与 Connect 卡保持注册与可选——断开绝不删除 provider、不写入 disabled
  列表、也不触碰其他 provider。

`connect`/`disconnect` 仅限 Host：独立 `bin` 会以固定消息拒绝它们，因为 DSH
credential store 归运行中的 Host 所有。

## 迁移手工路由

若旧配置手工设置了 `llm-pi-ai.providers.opencode-go`，本组合包可将其迁移掉：

```sh
dsh plugin --profile web exec dsh-opencode-go-provider migration-dry-run <settings.yaml>
dsh plugin --profile web exec dsh-opencode-go-provider migration-apply --revision <64-hex> <settings.yaml>
```

- `migration-dry-run` 只读，输出目标、SHA-256 revision 与删除 key/行
  **计数**（绝不输出 key 名或值）。
- `migration-apply` 校验期望 revision、获取同目录锁、写入前重新读取并重新哈希、
  创建带时间戳的可恢复备份（绝不触碰 credentials 文件），并原子发布。并发编辑
  产生 `conflict` 且零残留；二次 apply 是幂等的 `no-change`。
- 仅支持保守的 YAML 形状：**无 flow map、anchor 或 alias 的 block mapping**
  可迁移；不支持的形状在任何锁/备份/写入之前以 `unsupported-shape` 中止。
- 迁移保留**默认模型**、其他所有 providers、注释、引号与 key 顺序——只删除
  `llm-pi-ai.providers.opencode-go` 块，credential ref 原样保留。

## 安全

支持范围、私有报告途径、凭据处理与安全诊断契约见
[SECURITY.md](SECURITY.md)。

## 开发

环境搭建、TDD 工作流、严格类型/禁止私有导入规则、250-LOC 生产代码上限与完整
本地门禁见 [CONTRIBUTING.md](CONTRIBUTING.md)：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
```

CI（`.github/workflows/ci.yml`）在 Node 22.19.0、24、26 上以 pnpm 11.7.0 与
frozen lockfile 运行相同门禁。Live smoke 需要**同时**满足本地
`RUN_OPENCODE_GO_LIVE=1` 显式开启**和**本地 `OPENCODE_GO_API_KEY`；CI 两者都
不注入，因此该步骤始终跳过。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。上游通知与署名保留在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
