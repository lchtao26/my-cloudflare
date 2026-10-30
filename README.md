# 书籍推荐 RSS

Cloudflare Worker 从 Notion「书籍推荐」数据库读取全部书目，在 `/book-express-rss` 输出 RSS。每条书目的标题是书名。内容依次为“作者、简介”，两项各占一行。作者一行写成“作者：姓名 | 作者介绍”，介绍为空时只保留姓名。有「出版社 / 品牌」时，在来源上一行写出版社。有「来源」时再增加一行，来源名称链接到「推荐来源」。有封面时，图片放在最后一行，不指定尺寸。封面文件由 Worker 转发，避免把 Notion 的临时链接写进订阅源。链接优先取自「详情链接」字段；该字段为空或不是 HTTP(S) 网址时，链接到对应的 Notion 页面。没有书名或可用链接的记录不会进入订阅源。

## 配置

1. 在 Notion 创建仅具有“读取内容”权限的集成，并在「书籍推荐」数据库的“连接”中添加该集成。
2. 将集成密钥保存为 Cloudflare Worker Secret `NOTION_TOKEN`。部署配置要求这个密钥，缺少时 Wrangler 会阻止部署。不要将密钥提交到 GitHub。
3. `NOTION_DATA_SOURCE_ID` 已在 `wrangler.jsonc` 中配置为该数据库当前的数据源 ID。

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`，填入密钥，然后运行 `npm ci` 和 `npm run dev`。首次部署可在登录 Cloudflare 后运行 `npx wrangler deploy --secrets-file .dev.vars`，使代码和密钥同时上线；后续部署使用 `npm run deploy`。`.dev.vars` 已加入 `.gitignore`。

## GitHub 自动部署

推送到 `main` 后，GitHub Actions 会运行 `npm test`，再执行 `wrangler deploy`。部署任务使用 `production` 环境，因此 `CLOUDFLARE_API_TOKEN`（权限为 Edit Cloudflare Workers，且只限本账号）和 `CLOUDFLARE_ACCOUNT_ID` 要放在该环境的 Secrets 中。

`NOTION_TOKEN` 只保存在 Cloudflare Worker Secret 中。Worker 上还没有这个密钥时，Actions 会拒绝部署；先在本地执行一次 `npx wrangler deploy --secrets-file .dev.vars`。不要再把这个仓库接到 Cloudflare Worker 的 Builds，否则每次推送会部署两次。

部署成功后的订阅地址为 `https://my-cloudflare.lichcode.workers.dev/book-express-rss`。接口返回 RSS 2.0，按 Notion 的最后编辑时间排序，为每本书使用稳定的 Notion 页面 ID 作为 GUID，并缓存 5 分钟。

## 阅读节选 RSS

`/book-excerpts-rss` 从 Notion「阅读节选」读取「正文翻译」非空的记录，支持书籍、杂志和网页文章。订阅地址保持不变。每条 RSS 优先使用「标题翻译」作为标题；为空时回退到「标题」，两者均为空时显示“无标题”。

正文先显示「出处」及作者，再显示分段译文；原标题（与展示标题不同时）、出版方、章节和发布日期放在文末，缺失字段省略。输出 RSS 前使用 `pangu` 调整中文与英文、数字之间的空格；格式化只作用于可见文本，不改动 HTML 标签、图片代理地址或链接。空行或已有的连续 `<br />` 分隔符会转为段落，段内换行保留，其他 HTML 以文字显示。文末提供“阅读原文”（有有效「原文链接」时）和“在 Notion 中查看”入口；若「专有名词与术语」非空，在链接下方再加分割线并展示该部分。RSS 条目仍链接到对应的 Notion 页面，使用稳定的页面 ID 作为 GUID，按最后编辑时间倒序排列，缓存 5 分钟。空白正文翻译不会输出。

加上查询参数 `untranslated=1`（也接受 `true` / `yes`，或仅写 `?untranslated`）时，改为只输出「正文翻译」为空的记录，供待翻译队列使用。该模式下条目不含译文正文，标题回退到「标题」或“无标题”，并保留出处、元数据和原文 / Notion 链接。

译文中的 `notion-file-block` 图片引用会转换为 RSS 图片，并由 Worker 读取对应的 Notion 图片块、转发图片，避免使用会过期的文件地址。同时支持自闭合标签与带说明文字的 `<image>...</image>` 写法；说明文字会写入 `alt` 并显示在图片下方。图片块需属于对应节选页面且仍被译文引用。无法解析的其他图片引用会保留为文字。

`NOTION_EXCERPTS_DATA_SOURCE_ID` 已在 `wrangler.jsonc` 中配置。请在「阅读节选」数据库的“连接”中添加与书籍推荐相同的 Notion 集成，并确保其有读取权限。部署后订阅地址为 `https://my-cloudflare.lichcode.workers.dev/book-excerpts-rss`；待翻译队列为 `https://my-cloudflare.lichcode.workers.dev/book-excerpts-rss?untranslated=1`。RSS 地址无需登录即可读取翻译内容；打开 Notion 页面仍需相应的页面访问权限。
