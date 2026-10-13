# 书籍推荐 RSS

Cloudflare Worker 从 Notion「书籍推荐」数据库读取全部书目，在 `/book-express-rss` 输出 RSS。每条书目的标题是书名，内容依次为“书名、作者、简介”。链接优先取自「豆瓣 / 亚马逊」字段；该字段为空或不是 HTTP(S) 网址时，链接到对应的 Notion 页面。没有书名或可用链接的记录不会进入订阅源。

## 配置

1. 在 Notion 创建仅具有“读取内容”权限的集成，并在「书籍推荐」数据库的“连接”中添加该集成。
2. 将集成密钥保存为 Cloudflare Worker Secret `NOTION_TOKEN`。部署配置要求这个密钥，缺少时 Wrangler 会阻止部署。不要将密钥提交到 GitHub。
3. `NOTION_DATA_SOURCE_ID` 已在 `wrangler.jsonc` 中配置为该数据库当前的数据源 ID。

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`，填入密钥，然后运行 `npm ci` 和 `npm run dev`。首次部署可在登录 Cloudflare 后运行 `npx wrangler deploy --secrets-file .dev.vars`，使代码和密钥同时上线；后续部署使用 `npm run deploy`。`.dev.vars` 已加入 `.gitignore`。

## GitHub 自动部署

将本项目代码推送到独立的 GitHub 仓库后，在 Cloudflare 的 `book-express-rss` Worker 中打开 **Settings → Builds → Connect**，连接该仓库。生产分支选 `main`，构建命令为 `npm test`，部署命令为 `npx wrangler deploy`。推送到 `main` 后，Cloudflare 会运行测试并自动发布。`NOTION_TOKEN` 保存在 Cloudflare Secret 中，不需要也不能提交 `.dev.vars`。

部署成功后的订阅地址为 `https://book-express-rss.lichcode.workers.dev/book-express-rss`。接口返回 RSS 2.0，按 Notion 的最后编辑时间排序，为每本书使用稳定的 Notion 页面 ID 作为 GUID，并缓存 5 分钟。
