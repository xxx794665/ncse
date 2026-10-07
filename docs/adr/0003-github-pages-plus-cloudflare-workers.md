# 前端 GitHub Pages + API Cloudflare Workers 的零成本拓扑

前端构建为纯静态产物（放弃 SSR/Next.js，GH Pages 只能托管静态资源），经 GitHub Actions 发布到 GitHub Pages 并绑定自有域名子域；API 为 Cloudflare Workers 免费套餐，绑定另一子域，CORS 白名单放行前端域。数据存 Cloudflare（D1 存结构化数据、R2 存题目图片）。动机：全部落在免费额度内。代价：前后端跨域；GH Pages 免费版要求仓库公开——代码公开可接受，题库数据因此只存 D1/R2，绝不进 Git 仓库。
