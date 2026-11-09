[English](README.md) | 简体中文

# dsh-llm-dump

抓取**每一次完整的 LLM 请求**，并以折叠方式存储：重复的消息前缀和重复的大字段只存
一份，其余用哈希引用。

- 挂载点：`llm/stream` waterfall。监听器只观察 `GenerateOptions`，从不修改它，
  因此抓取不会改变模型收到的内容。
- 不拦截 `fetch`：这个切面上拿到的就是完整请求对象，前缀匹配只是对已抓取内容的
  本地计算。

这是一个纯 Host 侧 bundle，没有浏览器半边；需要提供 `llm` 服务的 DeepSeek
Harness 构建。

## 安装 / 移除

```sh
# 从 npm
dsh plugin --profile desktop add dsh-llm-dump

# 从源码
dsh plugin --profile desktop add github:wannaknowhys/dsh-llm-dump

# 移除
dsh plugin --profile desktop remove dsh-llm-dump
```

插件管理器接受同样的目标：`install_bundle target = dsh-llm-dump` 或本目录路径。

Host 模块不会热重载。修改后切换一次 bundle，让 Host 重新导入模块。

## 抓取内容

provider 边界上的 `GenerateOptions`：

- `messages` —— 模型可见的完整对话，包括组装好的 system prompt
- `tools` —— 当前生效的工具定义
- `model`、`provider`、`sessionId`、采样字段
- `toolHistory` 及其他大的顶层字段（只存一份，其余引用）

之后 adapter 仍可能继续变换请求（图片投影、工具更新、延迟加载）；这里记录的是
那一步之前最后一个公开状态。

## 存储

```
<outputDir>/<sessionId>/
  objects.jsonl    {"h": sha1, "v": <内容>}     唯一内容，只写一次
  requests.jsonl   {"prefixLen": n, "suffix": [hash...], ...}
  responses.jsonl  {"seq": n, "blocks": [...], ...}   第 n 次请求的回复
```

一次请求复用同一 session 中上一次请求的前 `prefixLen` 条消息，只列出新增的后缀。
完全相同的重试会变成 `prefixLen == messageCount`、后缀为空的记录。压缩或重写会
表现为更短的 `prefixLen` 加上更大的后缀——不会丢内容。

每条记录还带 `sha1`，即整个请求规范 JSON 的哈希，重放时可以证明重建出的内容
与当时完全一致。

## 数据格式（版本 1）

`requests.jsonl` 与 `responses.jsonl` 是与
[dsh-dump-manager](https://github.com/wannaknowhys/dsh-dump-manager) 共享的
只追加约定。读取方必须忽略未知字段，以便后续小版本新增字段。

格式号通过本包 `package.json` 的 `dsh.formatVersion` 公布（当前为 `1`），与包的
semver 相互独立——纯 UI 的发布不会被当成格式变化。`dsh-dump-manager` 启动时读取
这个值，发现自己读不了当前写入格式时会给出警告。

| 文件 | 每行一条 | 字段 |
| --- | --- | --- |
| `objects.jsonl` | 唯一内容 | `h`（规范 JSON 的 SHA-1）、`v`（值） |
| `requests.jsonl` | 请求 | `at`、`seq`、`sessionId`、`provider`、`model`、`messageCount`、`toolCount`、`prefixLen`、`suffix`、`tools`、`top`、`sha1` |
| `responses.jsonl` | 结束的流 | `seq`、`request`（对应请求的 `sha1`）、`at`、`ms`、`reason`、`usage`、`blocks`、`interrupted` |

- `messages` 只通过 `suffix` 存储；`prefixLen` 表示复用了上一次请求消息列表的
  多少条。
- `top` 保存其余所有顶层字段。超过 1 KB 的值会替换成
  `{"$dshRef": "<hash>"}`，并在 `objects.jsonl` 中只存一份；`tools` 走同样的
  间接引用（请求没有工具时为 `null`）。
- 哈希是对规范 JSON（键排序、无空白）做 SHA-1，与
  `tools/unfold-dump.mjs --verify` 的计算完全一致。

## 响应抓取

只看请求无法看到最新一条回复：第 *n* 次请求的回复，要等第 *n+1* 次请求把它作为
`assistant` 消息重发时才进入 dump。因此监听器同时读取它正在转发的流，在流结束时
向 `responses.jsonl` 追加一行：

```json
{"seq": 12, "request": "<sha1>", "at": "…", "ms": 3412,
 "reason": {"kind": "stop"}, "usage": {...},
 "blocks": [{"type": "text", "text": "…"}], "interrupted": false}
```

- block 按 harness 自身的规则组装，这里重复实现是因为插件无法 import 内部包：
  按 index 累积 delta、`block-end` 覆盖、`max-tokens` 丢弃 tool call、中断的流
  只保留已闭合的 text/reasoning。
- 没有收到 `finish` chunk（消费方取消）或 finish kind 为 `error` / `aborted` 时，
  `interrupted` 为 true；此时记录只保留截断前实际交付的内容。
- 抓取是纯观察：每个 chunk 原样转发；消费方提前停止时会关闭上游 iterator；
  任何错误都不会泄漏进响应路径。

每条响应都会存，但大多是冗余的——除最新一条外，其余都会重新出现在下一次请求里。
`dsh-dump-manager` 只显示最新那条，也就是请求快照永远装不下的那条。

## 配置

`%DSH_HOME%\llm-dumps\config.json` —— mtime 变化时重新读取：

```json
{
  "outputDir": "D:/llm-dumps"
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `outputDir` | `%DSH_HOME%\llm-dumps` | session 目录写到哪里 |

`DSH_LLM_DUMP_CONFIG` 可覆盖配置文件路径。

`dsh-dump-manager` 可以在它的设置页编辑这个文件；未知键会保留，写入是原子的。

## 重放

```powershell
node tools/unfold-dump.mjs <sessionId> --summary
node tools/unfold-dump.mjs <sessionId> --verify
node tools/unfold-dump.mjs <sessionId> --seq 3 --out req.json
```

`--verify` 会重新计算每条重放请求的规范哈希，任何不一致都会失败。工具从同一个
配置文件读取 `outputDir`，因此对任何抓取目录都适用。

## 测试

```powershell
npm test
```

两个测试都在系统临时目录下的一次性 `DSH_HOME` 中运行，不会碰真实 profile：

- `test/smoke-fold.mjs` —— 前缀复用、每个唯一值只存一个对象，以及重放哈希与
  每条记录一致。
- `test/smoke-response.mjs` —— chunk 转发、block 组装、`seq` / `sha1` 与请求的
  对应关系，以及被中断的流。

## 隐私

dump 里是模型可见的完整对话，包括文件内容、工具输出和 system prompt。不要把它
放进代码仓库；调查结束后及时删除。
