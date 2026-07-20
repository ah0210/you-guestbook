# 自游人 Guestbook 介绍

**自游人 Guestbook** 是一个轻量、可嵌入的网站留言板 / 评论系统，基于 Cloudflare 全栈（Workers + D1 + Pages）构建。它可以作为小组件嵌入任意网页，让访客无需离开页面即可留言、回复；也支持独立部署为带管理后台的完整评论系统。

## 它能做什么

- **嵌入任意网站**：一行脚本将留言组件挂到页面，访客在原页面即可发表、查看、回复留言
- **账号体系**：支持注册 / 登录 / 找回密码 / 修改邮箱，管理员在后台审核与管理留言与用户
- **访客分析**：内置流量洞察，可查看热门页面、访问来源渠道、搜索关键词等
- **安全防护**：Turnstile 人机验证、PBKDF2-SHA256（60 万次迭代）密码加密、登录失败限流、注册账户枚举模糊化等多重加固
- **跨域支持**：Cookie 采用 `SameSite=None; Secure`，适配 Hugo 子目录与 iframe 嵌入

## 技术栈

- **后端**：Cloudflare Workers（TypeScript）+ D1 数据库
- **前端**：Vue 3 组件（留言小组件 + 管理后台）
- **部署**：Cloudflare Pages / Workers，无需自建服务器

## 快速开始

1. 克隆仓库
2. 配置 `wrangler.toml` 与 `.dev.vars`（域名、JWT 密钥、邮件服务、ADMIN_PASSWORD 等）
3. 安装依赖并构建：`pnpm install && pnpm build && wrangler deploy`
4. 调用 `/api/v1/auth/setup` 初始化首个管理员

## 了解更多

- 项目主页：https://www.17you.com/
- 开源协议：MIT
