# 书籍推荐 RSS

Cloudflare Worker 从 Notion「书籍推荐」数据库读取全部书目，在 `/book-express-rss` 输出 RSS。每条书目的标题是书名，内容依次为“书名、作者、简介”。链接优先取自「豆瓣 / 亚马逊」字段；该字段为空或不是 HTTP(S) 网址时，链接到对应的 Notion 页面。没有书名或可用链接的记录不会进入订阅源。

## 配置

1. 在 Notion 创建仅具有“读取内容”权限的集成，并在「书籍推荐」数据库的“连接”中添加该集成。
2. 将集成密钥保存为 Cloudflare Worker Secret `NOTION_TOKEN`。部署配置要求这个密钥，缺少时 Wrangler 会阻止部署。不要将密钥提交到 GitHub。
3. `NOTION_DATA_SOURCE_ID` 已在 `wrangler.jsonc` 中配置为该数据库当前的数据源 ID。

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`，填入密钥，然后运行 `npm ci` 和 `npm run dev`。首次部署可在登录 Cloudflare 后运行 `npx wrangler deploy --secrets-file .dev.vars`，使代码和密钥同时上线；后续部署使用 `npm run deploy`。`.dev.vars` 已加入 `.gitignore`。

## GitHub 自动部署

推送到 `main` 后，GitHub Actions 会运行 `npm test`，再执行 `wrangler deploy`。仓库 Secrets 需要 `CLOUDFLARE_API_TOKEN`（权限为 Edit Cloudflare Workers，且只限本账号）和 `CLOUDFLARE_ACCOUNT_ID`。

`NOTION_TOKEN` 只保存在 Cloudflare Worker Secret 中。Worker 上还没有这个密钥时，Actions 会拒绝部署；先在本地执行一次 `npx wrangler deploy --secrets-file .dev.vars`。不要再把这个仓库接到 Cloudflare Worker 的 Builds，否则每次推送会部署两次。

部署成功后的订阅地址为 `https://my-cloudflare.lichcode.workers.dev/book-express-rss`。接口返回 RSS 2.0，按 Notion 的最后编辑时间排序，为每本书使用稳定的 Notion 页面 ID 作为 GUID，并缓存 5 分钟。
