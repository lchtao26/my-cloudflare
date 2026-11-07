# 书籍推荐 RSS

Cloudflare Worker 从 Notion「书籍推荐」数据库读取最近编辑的前 30 条书目，在 `/book/rss` 输出 RSS。每条书目的标题是书名。内容依次为“作者、简介”，两项各占一行。作者一行写成“作者：姓名 | 作者介绍”，介绍为空时只保留姓名。有「出版社 / 品牌」时，在来源上一行写出版社。有「来源」时再增加一行，来源名称链接到「推荐来源」。有封面时，图片放在最后一行，不指定尺寸。封面由 Worker 经 `/book/p/{pageId}` 转发，避免把 Notion 的临时链接写进订阅源。链接优先取自「详情链接」字段；该字段为空或不是 HTTP(S) 网址时，链接到对应的 Notion 页面。没有书名或可用链接的记录不会进入订阅源。

## 配置

1. 在 Notion 创建仅具有“读取内容”权限的集成，并在「书籍推荐」数据库的“连接”中添加该集成。
2. 将集成密钥保存为 Cloudflare Worker Secret `NOTION_TOKEN`。部署配置要求这个密钥，缺少时 Wrangler 会阻止部署。不要将密钥提交到 GitHub。
3. `NOTION_DATA_SOURCE_ID` 已在 `wrangler.jsonc` 中配置为该数据库当前的数据源 ID。

本地开发时，把 `.dev.vars.example` 复制为 `.dev.vars`，填入密钥，然后运行 `npm ci` 和 `npm run dev`。首次部署可在登录 Cloudflare 后运行 `npx wrangler deploy --secrets-file .dev.vars`，使代码和密钥同时上线；后续部署使用 `npm run deploy`。`.dev.vars` 已加入 `.gitignore`。

## GitHub 自动部署

推送到 `main` 后，GitHub Actions 会运行 `npm test`，再执行 `wrangler deploy`。部署任务使用 `production` 环境，因此 `CLOUDFLARE_API_TOKEN`（权限为 Edit Cloudflare Workers，且只限本账号）和 `CLOUDFLARE_ACCOUNT_ID` 要放在该环境的 Secrets 中。

`NOTION_TOKEN` 只保存在 Cloudflare Worker Secret 中。Worker 上还没有这个密钥时，Actions 会拒绝部署；先在本地执行一次 `npx wrangler deploy --secrets-file .dev.vars`。不要再把这个仓库接到 Cloudflare Worker 的 Builds，否则每次推送会部署两次。

部署成功后的订阅地址为 `https://my-cloudflare.lichcode.workers.dev/book/rss`。接口返回 RSS 2.0，按 Notion 的最后编辑时间排序，为每本书使用稳定的 Notion 页面 ID 作为 GUID，每次最多输出 30 条。

所有 RSS 接口在 Cloudflare 边缘和浏览器中缓存 5 分钟。缓存过期后必须重新读取 Notion；刷新失败时明确返回错误，不再继续返回过期内容。RSS 阅读器自身的抓取间隔仍由阅读器决定。图片缓存为 5 分钟。

## 阅读节选 RSS

`/read/rss` 从 Notion「阅读节选」的 **RSS** 视图读取条目：Worker 会读取该视图保存的 filter、列头 quick filter 和 sort。quick filter 与 filter 按 AND 合并后再查询对应 data source，使订阅源与视图列表一致。支持书籍、杂志和网页文章。中文条目使用「标题」；其他语言优先使用「标题翻译」，为空时回退到「标题」。标题仍为空时显示“无标题”。

RSS 条目只输出标题、指向水墨屏详情页 `/read/d/{6 位短码}` 的链接，以及稳定的 Notion 页面 ID 作为 GUID，不再附带 `description` 正文。正文、出处、术语等内容只在详情页呈现。中文条目使用「标题」与「正文」；其他语言优先「标题翻译」与「正文翻译」，标题为空时回退到「标题」，仍为空时显示“无标题”。视图设置了 sort 时按该顺序输出；未设置时保持 Notion 表格本身的顺序，不再改成最后编辑时间倒序。条目的 pubDate 使用页面创建时间。每次只读取视图的前 30 条记录。不满足视图条件、对应正文为空、没有有效链接或缺少 `ID` 编号的记录不会输出。

正文字段中的 `notion-file-block` 图片引用会在详情页转换为图片，并由 Worker 通过 `/read/p/...` 转发，避免使用会过期的文件地址。同时支持自闭合标签与带说明文字的 `<image>...</image>` 写法；标签内的说明文字会被忽略，不写入 `alt`，也不显示在图片下方。图片块需属于对应节选页面，且仍被该条目使用的正文字段引用。无法解析的其他图片引用会保留为文字。

`NOTION_EXCERPTS_DATA_SOURCE_ID` 与 `NOTION_EXCERPTS_VIEW_ID`（RSS 视图）已在 `wrangler.jsonc` 中配置。请在「阅读节选」数据库的“连接”中添加与书籍推荐相同的 Notion 集成，并确保其有读取权限。部署后订阅地址为 `https://my-cloudflare.lichcode.workers.dev/read/rss`。RSS 地址无需登录即可读取内容；打开 Notion 页面仍需相应的页面访问权限。

## 阅读节选水墨屏页面

`/read` 与 `/read/d/{6 位短码}` 为水墨屏设备提供极简 HTML 阅读页。详情页呈现出处、作者、正文、元数据与术语。有有效「原文链接」时，点按「阅读原文」一行的标题可打开原文。普通详情页直接显示「数据来源：Notion」和分享链接的复制按钮，日期缺失时显示「—」。分享页隐藏数据来源和分享按钮。分享链接为 `/s/{6 位短码}`，与详情页使用同一个短码。短码由「阅读节选」数据库中名为 `ID` 的 ID 属性（Notion 自增编号）经带密钥的 Feistel 置换和 base62 编码得到，相邻编号的短码互不相似；Worker 可直接解码，无需存储。编号须小于 2^20，没有编号的条目不出现在列表与 RSS 中。旧的 `/read/d/{pageId}` 与 `/read/s/{pageId}` 地址已停用。修改 `SHARE_CODE_KEYS` 或 `SHARE_CODE_ALPHABET` 会使已有的详情与分享链接全部失效，浏览器保存的阅读进度也会对不上。短码只解析自己数据源内的条目，不能跳转到外部网址；随机猜测的短码约 4096 个中才有 1 个能解码出编号，其余直接返回 404，不请求 Notion，查无条目的 404 也缓存 5 分钟。这只是混淆，不是加密：仓库公开时，看过代码的人可以算出编号。分享页打开后隐藏文章底部导航，不读取或保存阅读进度；其他详情页在底部显示导航。 这些入口适用于所有设备。列表页的标题、出处和作者，以及详情页全部可见文本都经 `pangu` 调整中英文与数字间距，不改动 HTML 标签与图片代理地址。页面使用纯黑白、衬线大字号、固定行宽、实线分隔与大触控目标，无动画。图片继续复用 `/read/p/...` 代理。缓存 5 分钟。

分类栏显示「全部、收藏、新闻、周刊、文春、小说」。「全部、周刊、文春、小说、新闻」在 RSS 视图范围内筛选。周刊按原文链接或备注中的 `bunshun.jp/denshiban/articles/` 识别，文春按 `bunshun.jp/articles/` 识别；小说按「提取来源」为 epub 识别，新闻按 Hacker News 原文链接或以 `HN ` 开头的备注识别。「收藏」读取 `NOTION_EXCERPTS_FAVORITES_VIEW_ID` 配置的「已收藏」视图，沿用该视图的筛选和排序。每个分类先读取前 30 条，有更多条目时可继续加载。详情页的上一篇、下一篇和返回列表保留当前分类与已加载的条目。

正文使用 1.75 倍行高、左对齐与随字号缩放的段距；标题使用 1.35 倍行高，并在大屏上放大。按默认根字号 16px 换算，小于 440px 的视口正文与按钮为 17px，440px 至小于 720px 为 18px；小于 720px 的文章标题为 24px、列表元信息为 16px。720px 及以上正文与按钮、文章标题、列表元信息分别为 20px、26.4px、17px。实际字号均使用 rem 设置。小于 440px 的视口左右留白为 1.625rem，440px 及以上为 1.25rem。正文在所有设备上统一使用 400 字重，标题与按钮使用 700。中文和日文优先使用系统自带的宋体（Songti SC）／明朝体（Hiragino Mincho、Yu Mincho），再回退到 Android、Linux 自带的 Noto Serif CJK 和 Windows 字体；英文原文使用 Georgia 等衬线字体。字体栈只列系统自带字体：Safari 不向网页提供用户自装字体，而自装字体只装了部分字重时，Chrome 会用错误字重渲染正文。不下载网页字体，Kindle 等不认识这些字体名的设备回退到 `serif`。

页面与导航保持中文语言标记，正文、标题和文末原标题分别标记实际使用的语言；缺少标题翻译而显示原标题时，也使用原文语言的字体。列表元数据保持中文语言标记。中日文启用严格标点换行规则，超长网址允许折行；旧浏览器忽略不支持的样式后仍可阅读。中英文间距继续使用 pangu，不再叠加浏览器自动混排间距。

列表页和详情页在触屏设备上仅点击正文栏两侧的空白处才会翻页，左侧向上、右侧向下；点击正文、图片或链接不会触发翻页。以鼠标或触控板为主要输入方式的设备不启用点击翻页，仍可正常滚动阅读。

在列表中正常点开文章时，会用 `history.replaceState` 将当前列表历史项的锚点更新为该文章。使用浏览器返回时可以定位刚打开的文章，避免沿用此前“返回列表”留下的旧锚点；详情页的“返回列表”仍直接链接到当前文章的列表锚点。
